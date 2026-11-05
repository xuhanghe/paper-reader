// Everything in the library that can be found, one entry per thing, each
// carrying where it is: a paper (and a page in it), a conversation in the
// Reader (and a turn of it), a note or highlight, a message in a workspace
// chat, a workspace file.
//
// Built from what is already there — the papers' session folders, the Zotero
// library, and the workspaces the client describes (their chats live in the
// browser) — and never written anywhere: it is rebuilt from those whenever it
// is stale. Server-only.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ZOTERO_BASE } from "@/lib/zotero-server";
import { dirFor, readMindmapFile, readState, readWithdrawn, SESSIONS_ROOT, withoutWithdrawn, type ThreadEntry } from "@/lib/session-store";
import { askedText, askGist, readWholeThread } from "@/lib/session-recovery";
import { parseQuotes } from "@/lib/quotes";
import { listWorkspaceFiles, readWorkspaceText } from "@/lib/workspace-files";
import { bestMatch, buildRankIndex, type RankIndex } from "@/lib/search-rank";
import type { Annotation, ConceptEntry, Highlight, MindmapNode } from "@/types/session";

// Where a result takes you. The Reader's kinds open the paper first.
export type PaperPlace = { paperId: string; title: string; zoteroKey?: string };
export type Locator =
  | ({ kind: "paper"; page?: number; quote?: string } & PaperPlace)
  // messageIndex: the message the result is about, by its place in the card —
  // a question, or an answer; quote: the sentence of it that matched, and
  // inAnswer whether that sentence is the answer's
  | ({ kind: "conversation"; annotationId?: string; turn?: number; messageIndex?: number; page?: number; quote?: string; inAnswer?: boolean } & PaperPlace)
  | ({ kind: "note"; noteId: string; page?: number; text?: string } & PaperPlace)
  // What a conversation established, as the Concepts tab shows it
  | ({ kind: "concept"; annotationId: string } & PaperPlace)
  | { kind: "workspace-chat"; workspaceId: string; workspaceName: string; messageId: string }
  | { kind: "workspace-file"; workspaceId: string; workspaceName: string; path: string };

export type SearchKind = Locator["kind"];
export type SearchDoc = {
  id: string;
  kind: SearchKind;
  title: string;
  // Searched, and shown as the snippet
  text: string;
  // What it belongs to: the paper's title, or the workspace's name
  where: string;
  locator: Locator;
  // A conversation's questions by turn, for the agent to name one
  turns?: { turn: number; question: string }[];
  // Its exchanges, by the place of their question in the card
  pairs?: { index: number; turn?: number; text: string }[];
  // Every message of it as shown, for the sentence a result cites and lands
  // on (see landingFor)
  messages?: { index: number; role: "user" | "assistant"; turn?: number; text: string }[];
};

// A workspace as the client knows it: its chat is kept in the browser
export type WorkspaceInput = {
  id: string;
  name: string;
  root: string;
  papers?: { id: string; name: string; zoteroKey?: string }[];
  chat?: { id: string; role: "user" | "assistant"; content: string }[];
};

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const stripHtml = (html: string) => html.replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const titleOfName = (name: string) => name.replace(/\.pdf$/i, "").trim();

// ── Zotero, read through its local API ──

type ZoteroItem = { key: string; data: Record<string, unknown> };

async function zoteroPages(query: string, maxPages = 30): Promise<ZoteroItem[]> {
  const out: ZoteroItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = query.includes("?") ? "&" : "?";
    const res = await fetch(`${ZOTERO_BASE}/${query}${sep}limit=100&start=${page * 100}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!res.ok) break;
    const body = (await res.json()) as ZoteroItem[];
    out.push(...body);
    const total = Number(res.headers.get("Total-Results") || 0);
    if (body.length < 100 || out.length >= total) break;
  }
  return out;
}

type ZoteroLibrary = {
  items: Map<string, { title: string; authors: string; year: string; abstract: string; collections: string[] }>;
  notes: { key: string; parent: string; text: string }[];
  annotations: { key: string; paper: string; text: string; comment: string; page?: number }[];
};

async function readZotero(): Promise<ZoteroLibrary | null> {
  try {
    const [top, collections, notes, attachments, annotations] = await Promise.all([
      zoteroPages("items/top"),
      zoteroPages("collections"),
      zoteroPages("items?itemType=note"),
      zoteroPages("items?itemType=attachment"),
      zoteroPages("items?itemType=annotation"),
    ]);
    const collectionName = new Map(collections.map((c) => [c.key, String(c.data.name ?? "")]));
    const items: ZoteroLibrary["items"] = new Map();
    for (const item of top) {
      const d = item.data;
      const creators = Array.isArray(d.creators) ? (d.creators as { lastName?: string; name?: string }[]) : [];
      items.set(item.key, {
        title: String(d.title ?? "").trim(),
        authors: creators.map((c) => c.lastName || c.name || "").filter(Boolean).slice(0, 6).join(", "),
        year: /\d{4}/.exec(String(d.date ?? ""))?.[0] ?? "",
        abstract: String(d.abstractNote ?? ""),
        collections: (Array.isArray(d.collections) ? (d.collections as string[]) : []).map((k) => collectionName.get(k) ?? "").filter(Boolean),
      });
    }
    // An annotation hangs off an attachment; the paper is the attachment's
    // parent, or the attachment itself when it stands alone
    const paperOf = new Map(attachments.map((a) => [a.key, String(a.data.parentItem || a.key)]));
    return {
      items,
      notes: notes
        .filter((n) => typeof n.data.parentItem === "string" && typeof n.data.note === "string")
        .map((n) => ({ key: n.key, parent: String(n.data.parentItem), text: stripHtml(String(n.data.note)) })),
      annotations: annotations
        .map((a) => {
          let page: number | undefined;
          try { page = Number(JSON.parse(String(a.data.annotationPosition ?? "{}")).pageIndex) + 1 || undefined; } catch { page = undefined; }
          return { key: a.key, paper: paperOf.get(String(a.data.parentItem)) ?? String(a.data.parentItem), text: String(a.data.annotationText ?? ""), comment: String(a.data.annotationComment ?? ""), page };
        })
        .filter((a) => a.text.trim() || a.comment.trim()),
    };
  } catch {
    // Zotero not running: the sessions are still searched
    return null;
  }
}

// ── The papers' sessions ──

const mapLines = (node: MindmapNode | null | undefined, depth = 0, out: string[] = []): string[] => {
  if (!node || depth > 2) return out;
  if (node.label) out.push(node.note ? `${node.label}: ${node.note}` : node.label);
  for (const child of node.children ?? []) mapLines(child, depth + 1, out);
  return out;
};

// The app's own folders beside the papers' (a folder with no state.json is
// passed over anyway)
const NOT_PAPERS = new Set(["_trace", "_search"]);

async function sessionIds(): Promise<string[]> {
  try {
    const entries = await readdir(SESSIONS_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !NOT_PAPERS.has(e.name) && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

async function paperDocs(zotero: ZoteroLibrary | null, inWorkspaces: Map<string, string[]>): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = [];
  const seen = new Set<string>();

  for (const id of await sessionIds()) {
    const state = await readState(id);
    if (!state) continue;
    const zoteroKey = typeof state.zoteroKey === "string" && state.zoteroKey ? state.zoteroKey : undefined;
    const meta = zoteroKey ? zotero?.items.get(zoteroKey) : undefined;
    const title = meta?.title || titleOfName(String(state.pdfName ?? id));
    const place: PaperPlace = { paperId: id, title, zoteroKey };
    seen.add(id);
    if (zoteroKey) seen.add(zoteroKey);

    const mindmap = (await readMindmapFile(id)) as MindmapNode | null;
    const concepts = Array.isArray(state.concepts) ? (state.concepts as ConceptEntry[]) : [];
    docs.push({
      id: `paper:${id}`,
      kind: "paper",
      title,
      where: title,
      text: [
        meta && [meta.authors, meta.year].filter(Boolean).join(" · "),
        meta?.collections.length && `collections: ${meta.collections.join(", ")}`,
        inWorkspaces.get(id)?.length && `workspaces: ${inWorkspaces.get(id)!.join(", ")}`,
        meta?.abstract,
        ...mapLines(mindmap),
        ...concepts.map((c) => [c.label, ...(c.takeaways ?? [])].join(" — ")),
      ].filter(Boolean).join("\n"),
      locator: { kind: "paper", ...place },
    });

    // What each conversation established, found as itself
    for (const c of concepts) {
      if (!c.label?.trim() && !c.takeaways?.length) continue;
      docs.push({
        id: `concept:${id}:${c.annotationId}`,
        kind: "concept",
        title: clip(c.label || "Concept", 140),
        where: title,
        text: (c.takeaways ?? []).join("\n"),
        locator: { kind: "concept", ...place, annotationId: c.annotationId },
      });
    }

    // Its conversations, as the Ask panel holds them
    const annotations = Array.isArray(state.annotations) ? (state.annotations as Annotation[]) : [];
    const carded = new Set<string>();
    for (const a of annotations) {
      carded.add(a.id);
      const turns: { turn: number; question: string }[] = [];
      const pairs: { index: number; turn?: number; text: string }[] = [];
      const shown: NonNullable<SearchDoc["messages"]> = [];
      const lines: string[] = [];
      if (a.selectedText) lines.push(`passage: ${clip(a.selectedText, 400)}`);
      (a.messages ?? []).forEach((m, index) => {
        if (!m.content?.trim()) return;
        if (m.role === "user") {
          const question = parseQuotes(m.content).question;
          if (m.turn) turns.push({ turn: m.turn, question: clip(question, 160) });
          pairs.push({ index, turn: m.turn, text: question });
          shown.push({ index, role: "user", turn: m.turn, text: question.slice(0, 6000) });
          lines.push(`Q${m.turn ? ` [turn ${m.turn}]` : ""}: ${clip(question, 600)}`);
        } else {
          const pair = pairs[pairs.length - 1];
          if (pair) pair.text += `\n${clip(m.content, 1200)}`;
          shown.push({ index, role: "assistant", turn: pair?.turn, text: m.content.slice(0, 12000) });
          lines.push(`A: ${clip(m.content, 700)}`);
        }
      });
      if (!lines.length) continue;
      const opening = a.messages?.find((m) => m.role === "user")?.content;
      docs.push({
        id: `conv:${id}:${a.id}`,
        kind: "conversation",
        title: clip(a.label || (opening ? parseQuotes(opening).question : "") || a.selectedText || "Conversation", 140),
        where: title,
        text: lines.join("\n"),
        turns,
        pairs,
        messages: shown,
        locator: { kind: "conversation", ...place, annotationId: a.id, page: a.pageNumber },
      });
    }

    // Turns the record holds with no card in the panel — a card lost, or
    // from before cards were kept — go by the paper and the page asked on.
    // Deleted turns stay deleted.
    const thread = withoutWithdrawn(await readWholeThread(id), await readWithdrawn(id)) as ThreadEntry[];
    const orphans = new Map<string, ThreadEntry[]>();
    for (const entry of thread) {
      if (entry.annotationId && carded.has(entry.annotationId)) continue;
      const key = entry.annotationId || "general";
      orphans.set(key, [...(orphans.get(key) ?? []), entry]);
    }
    for (const [key, entries] of orphans) {
      const turns: { turn: number; question: string }[] = [];
      const lines: string[] = [];
      let page: number | undefined;
      for (const e of entries) {
        if (e.role === "user") {
          const gist = askGist(e.text);
          page ??= gist.page;
          const turn = Number(/^\[turn (\d+)\]/.exec(e.text)?.[1]) || undefined;
          if (turn) turns.push({ turn, question: clip(gist.gist, 160) });
          lines.push(`Q${turn ? ` [turn ${turn}]` : ""}: ${clip(askedText(e.text), 600)}`);
        } else {
          lines.push(`A: ${clip(e.text, 700)}`);
        }
      }
      if (!turns.length && !lines.length) continue;
      docs.push({
        id: `thread:${id}:${key}`,
        kind: "conversation",
        title: clip(turns[0]?.question || "Earlier conversation", 140),
        where: title,
        text: lines.join("\n"),
        turns,
        locator: { kind: "conversation", ...place, page },
      });
    }

    // Highlights, with the note written on them
    const highlights = Array.isArray(state.highlights) ? (state.highlights as Highlight[]) : [];
    const mirrored = new Set(highlights.map((h) => h.zoteroKey).filter(Boolean));
    for (const h of highlights) {
      if (!h.text?.trim() && !h.note?.trim()) continue;
      docs.push({
        id: `note:${id}:${h.id}`,
        kind: "note",
        title: clip(h.note || h.text, 140),
        where: title,
        text: [h.note, h.text].filter(Boolean).join("\n"),
        locator: { kind: "note", ...place, noteId: h.id, page: h.pageNumber, text: h.text },
      });
    }
    // Zotero's own, for this paper, unless a highlight here already mirrors it
    if (zotero && zoteroKey) {
      for (const a of zotero.annotations.filter((x) => x.paper === zoteroKey && !mirrored.has(x.key))) {
        docs.push({
          id: `note:${id}:zotero-${a.key}`,
          kind: "note",
          title: clip(a.comment || a.text, 140),
          where: title,
          text: [a.comment, a.text].filter(Boolean).join("\n"),
          locator: { kind: "note", ...place, noteId: `zotero-${a.key}`, page: a.page, text: a.text },
        });
      }
    }
  }

  // Papers in Zotero never opened in the Reader: their record, and their notes
  if (zotero) {
    for (const [key, meta] of zotero.items) {
      if (seen.has(key) || !meta.title) continue;
      const place: PaperPlace = { paperId: key, title: meta.title, zoteroKey: key };
      docs.push({
        id: `paper:${key}`,
        kind: "paper",
        title: meta.title,
        where: meta.title,
        text: [
          [meta.authors, meta.year].filter(Boolean).join(" · "),
          meta.collections.length && `collections: ${meta.collections.join(", ")}`,
          inWorkspaces.get(key)?.length && `workspaces: ${inWorkspaces.get(key)!.join(", ")}`,
          meta.abstract,
        ].filter(Boolean).join("\n"),
        locator: { kind: "paper", ...place },
      });
    }
    for (const a of zotero.annotations) {
      if (seen.has(a.paper) || !zotero.items.has(a.paper)) continue;
      const meta = zotero.items.get(a.paper)!;
      docs.push({
        id: `note:${a.paper}:zotero-${a.key}`,
        kind: "note",
        title: clip(a.comment || a.text, 140),
        where: meta.title,
        text: [a.comment, a.text].filter(Boolean).join("\n"),
        locator: { kind: "note", paperId: a.paper, title: meta.title, zoteroKey: a.paper, noteId: `zotero-${a.key}`, page: a.page, text: a.text },
      });
    }
  }
  // Zotero's notes on a paper, opened or not
  if (zotero) {
    for (const n of zotero.notes) {
      const meta = zotero.items.get(n.parent);
      if (!meta || !n.text.trim()) continue;
      docs.push({
        id: `note:${n.parent}:zotero-note-${n.key}`,
        kind: "note",
        title: clip(n.text, 140),
        where: meta.title,
        text: clip(n.text, 4000),
        locator: { kind: "note", paperId: n.parent, title: meta.title, zoteroKey: n.parent, noteId: `zotero-note-${n.key}` },
      });
    }
  }
  return docs;
}

// ── Workspaces, as the client describes them ──

const TEXT_FILE = /\.(md|markdown|txt|tex|bib|py|ipynb|json|csv|yaml|yml|toml|sh|js|ts)$/i;
const MAX_FILES = 300;

async function workspaceDocs(workspaces: WorkspaceInput[]): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = [];
  for (const ws of workspaces) {
    const chat = ws.chat ?? [];
    chat.forEach((message, i) => {
      if (message.role !== "user" || !message.content?.trim()) return;
      const reply = chat[i + 1]?.role === "assistant" ? chat[i + 1].content : "";
      docs.push({
        id: `wsmsg:${ws.id}:${message.id}`,
        kind: "workspace-chat",
        title: clip(message.content, 140),
        where: ws.name,
        text: [message.content, reply && `A: ${clip(reply, 900)}`].filter(Boolean).join("\n"),
        locator: { kind: "workspace-chat", workspaceId: ws.id, workspaceName: ws.name, messageId: message.id },
      });
    });
    let files: { path: string; kind: string }[] = [];
    try {
      files = (await listWorkspaceFiles(ws.root)).filter((f) => f.kind === "file").slice(0, MAX_FILES);
    } catch {
      continue; // a folder moved or gone: its chat is still searched
    }
    for (const file of files) {
      let body = "";
      if (TEXT_FILE.test(file.path)) {
        try { body = clip(await readWorkspaceText(ws.root, file.path), 3000); } catch { body = ""; }
      }
      docs.push({
        id: `wsfile:${ws.id}:${file.path}`,
        kind: "workspace-file",
        title: file.path,
        where: ws.name,
        text: body,
        locator: { kind: "workspace-file", workspaceId: ws.id, workspaceName: ws.name, path: file.path },
      });
    }
  }
  return docs;
}

export function parseWorkspaces(value: unknown): WorkspaceInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((w: Record<string, unknown>) => {
    if (typeof w?.id !== "string" || typeof w.root !== "string") return [];
    const chat = Array.isArray(w.chat) ? (w.chat as Record<string, unknown>[]) : [];
    return [{
      id: w.id,
      name: typeof w.name === "string" ? w.name : w.id,
      root: w.root,
      papers: Array.isArray(w.papers) ? (w.papers as WorkspaceInput["papers"])!.filter((p) => typeof p?.id === "string").slice(0, 200) : [],
      chat: chat
        .filter((m) => typeof m?.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-400)
        .map((m) => ({ id: m.id as string, role: m.role as "user" | "assistant", content: (m.content as string).slice(0, 4000) })),
    }];
  });
}

// ── The index, rebuilt when stale ──

export type SearchIndex = RankIndex<SearchDoc>;

// The papers' part changes only as papers are read; it is kept a few seconds,
// and rebuilt sooner when a session has been written since
const LIBRARY_TTL_MS = 15_000;
let libraryCache: { at: number; newest: number; key: string; docs: SearchDoc[] } | null = null;

async function newestSessionWrite(): Promise<number> {
  let newest = 0;
  for (const id of await sessionIds()) {
    for (const file of ["state.json", "thread.jsonl"]) {
      const info = await stat(path.join(dirFor(id), file)).catch(() => null);
      if (info && info.mtimeMs > newest) newest = info.mtimeMs;
    }
  }
  return newest;
}

export async function libraryDocs(workspaces: WorkspaceInput[]): Promise<SearchDoc[]> {
  const inWorkspaces = new Map<string, string[]>();
  for (const ws of workspaces) for (const p of ws.papers ?? []) {
    for (const id of [p.id, p.zoteroKey].filter(Boolean) as string[]) inWorkspaces.set(id, [...(inWorkspaces.get(id) ?? []), ws.name]);
  }
  const key = JSON.stringify([...inWorkspaces].sort());
  const newest = await newestSessionWrite();
  if (libraryCache && libraryCache.key === key && Date.now() - libraryCache.at < LIBRARY_TTL_MS && libraryCache.newest >= newest) return libraryCache.docs;
  const docs = await paperDocs(await readZotero(), inWorkspaces);
  libraryCache = { at: Date.now(), newest, key, docs };
  return docs;
}

/** Everything searchable: the library, and the workspaces described. */
export async function buildSearchIndex(workspaces: WorkspaceInput[]): Promise<SearchIndex> {
  const [library, workspace] = await Promise.all([libraryDocs(workspaces), workspaceDocs(workspaces)]);
  return buildRankIndex([...library, ...workspace]);
}

/** For a test: forget what was cached. */
export function forgetSearchCache() {
  libraryCache = null;
}

// A message as it reads on screen: Markdown's marks gone, so a sentence of it
// is found again in the rendered answer, and shown cleanly
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, "")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1");
}

// Sentences, in Chinese or English: ended by a stop or a line break
export function sentencesOf(text: string): string[] {
  return plainText(text)
    .split(/\n+|(?<=[。！？!?；;])|(?<=[.])\s+(?=[A-Z0-9“"(])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 4);
}

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Where a result in a conversation lands, and what it cites: the sentence —
 * of a question or of an answer — that the words match best, or the one the
 * agent quoted, in the turn it named. The message holding it is landed on and
 * the sentence lit; never just the conversation's beginning when something in
 * it can be pointed at.
 */
export function landingFor(doc: SearchDoc, words: string, turn?: number, quote?: string): Locator {
  const base = doc.locator;
  if (base.kind !== "conversation" || !doc.messages?.length) return base;
  const named = turn ? doc.messages.filter((m) => m.turn === turn) : [];
  const pool = named.length ? named : doc.messages;
  const at = (m: NonNullable<SearchDoc["messages"]>[number], sentence: string): Locator => ({
    ...base,
    messageIndex: m.index,
    ...(m.turn ? { turn: m.turn } : {}),
    quote: sentence.length > 220 ? `${sentence.slice(0, 219)}…` : sentence,
    inAnswer: m.role === "assistant",
  });
  // The agent's own quote, where it is really there
  if (quote?.trim()) {
    const wanted = squash(plainText(quote)).slice(0, 80);
    for (const m of pool) {
      if (!wanted || !squash(plainText(m.text)).includes(wanted)) continue;
      const sentence = sentencesOf(m.text).find((s) => squash(s).includes(wanted.slice(0, 24))) ?? plainText(quote).trim();
      return at(m, sentence);
    }
  }
  // Else the sentence the words match best
  const sentences = pool.flatMap((m) => sentencesOf(m.text).map((sentence) => ({ m, sentence })));
  const best = bestMatch(sentences.map((s) => s.sentence), words);
  if (best >= 0) return at(sentences[best].m, sentences[best].sentence);
  // Nothing in common: the turn named, at its question
  const first = named.find((m) => m.role === "user") ?? named[0];
  return first ? { ...base, messageIndex: first.index, ...(first.turn ? { turn: first.turn } : {}) } : base;
}
