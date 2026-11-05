// Finding something from a vague memory of it: a one-shot agent over the
// library. It lives for one search and keeps nothing — no session to resume,
// no transcript on disk — since what it learned about one search is no use to
// the next, and a context kept across searches would only grow.
//
// It reads and never writes: Read, Grep and Glob, nothing else, and no
// Zotero MCP. It is given the index written out as a catalog for this run, the
// closest plain-word matches, and where the full texts and records are; it
// answers with ids from the catalog, so every result it gives is a place the
// app can open, never one it made up. Server-only.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeStream } from "@/lib/providers";
import { parseJsonLine, createLineSplitter } from "@/lib/ndjson";
import { SESSIONS_ROOT } from "@/lib/session-store";
import { rankSearch, snippet, type RankIndex } from "@/lib/search-rank";
import { landingFor, type Locator, type SearchDoc, type WorkspaceInput } from "@/lib/search-index";

export type FoundResult = { id: string; kind: SearchDoc["kind"]; title: string; where: string; why: string; locator: Locator };
export type AgentEvent =
  | { type: "activity"; text: string }
  | { type: "results"; reply?: string; results: FoundResult[] }
  | { type: "error"; message: string };

// The search so far, when it is a conversation: what I said, and what was
// found for it
export type SearchTurn = { role: "user" | "agent"; text: string; found?: { id: string; title: string }[] };

export function parseHistory(value: unknown): SearchTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).flatMap((t: Record<string, unknown>) => {
    if ((t?.role !== "user" && t?.role !== "agent") || typeof t.text !== "string") return [];
    const found = Array.isArray(t.found)
      ? (t.found as Record<string, unknown>[]).filter((f) => typeof f?.id === "string" && typeof f.title === "string").slice(0, 8).map((f) => ({ id: f.id as string, title: (f.title as string).slice(0, 160) }))
      : undefined;
    return [{ role: t.role as SearchTurn["role"], text: t.text.slice(0, 1500), found }];
  });
}

const MODEL = "claude:sonnet";
const EFFORT = "low";
const TOOLS = "Read,Grep,Glob";
const CANDIDATES = 30;
const MAX_RESULTS = 5;
const TIME_LIMIT_MS = 150_000;

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export function catalogLine(doc: SearchDoc): string {
  const place = doc.locator as { page?: number };
  return JSON.stringify({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    where: doc.where,
    ...(place.page ? { page: place.page } : {}),
    ...(doc.turns?.length ? { turns: doc.turns.map((t) => `[turn ${t.turn}] ${t.question}`) } : {}),
    text: clip(doc.text, 600),
  });
}

export function searchPrompt(memory: string, catalogPath: string, candidates: SearchDoc[], workspaceRoots: string[], reading?: { id: string; title: string }, history: SearchTurn[] = []): string {
  const earlier = history.length
    ? `\nEarlier in this search, oldest first — my message now may narrow, correct or follow up on it:\n${history
        .map((t) => (t.role === "user" ? `- I said: ${clip(t.text, 400)}` : `- You answered: ${clip(t.text, 300) || "(nothing said)"}${t.found?.length ? `; found ${t.found.map((f) => `${f.title} [${f.id}]`).join("; ")}` : "; found nothing"}`))
        .join("\n")}\n`
    : "";
  const shortlist = candidates.length
    ? candidates.map((d) => `- ${d.id} (${d.kind}, in “${clip(d.where, 60)}”): ${clip(d.title, 120)}`).join("\n")
    : "(none — nothing shares a word with it)";
  return `You find things in my research library from a vague memory of them, and say exactly where they are.

${earlier}
What I remember, or ask now: «${memory}»
${reading ? `\nI am reading “${reading.title}” (paper id ${reading.id}) right now: when the memory fits something in it, that is most likely what I mean.\n` : ""}
The library, one JSON object per line, each with an "id": ${catalogPath}
Kinds: paper (its record, structure map and what I worked out about it), conversation (one of my conversations about a paper in the Reader, its questions listed by turn), concept (what one of those conversations established), note (a highlight or a note on a paper), workspace-chat (a message of mine in a workspace's chat), workspace-file (a file in a workspace).

The closest by plain word match, best first — they may all be wrong:
${shortlist}

When the catalog is not enough, go to the sources:
- ${SESSIONS_ROOT}/<paper id>/paper.md — a paper's full text, with [page N] markers (the paper id is the part of a catalog id after the first colon, up to the next)
- ${SESSIONS_ROOT}/<paper id>/thread.jsonl — every question I asked about the paper and the answers, one JSON object per line ({role, text, annotationId}); my questions start with [turn N]
${workspaceRoots.length ? `- the workspace folders: ${workspaceRoots.join(", ")}` : ""}

My memory may be in Chinese while the source is in English, or the other way round, and its details may be off: search for the idea in both languages and with other words for it. Grep the catalog first; read a file only to confirm. Be quick.

Answer with JSON only, nothing after it:
{"reply": "<one or two sentences, in the language of my message: what you found, or what you need from me to find it>", "results": [{"id": "<an id from the catalog>", "why": "<one short sentence, in the language of my message, saying why this is it>", "turn": <for a conversation, the turn that matches>, "page": <for a paper, the page>, "quote": "<for a paper, 5 to 15 words copied exactly from paper.md on that page; for a conversation, the sentence of my question or of the answer that matches, copied exactly>"}]}
Best first, at most ${MAX_RESULTS}, only what you are fairly sure of. Never make up an id. If nothing fits, say so in the reply, with "results": [].`;
}

/** What the agent said, from its answer: its reply in a sentence or two. */
export function parseReply(text: string): string | undefined {
  const at = text.lastIndexOf('{"reply"');
  const start = at >= 0 ? at : text.lastIndexOf("{");
  if (start < 0) return undefined;
  try {
    const body = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as { reply?: unknown };
    return typeof body.reply === "string" && body.reply.trim() ? clip(body.reply, 600) : undefined;
  } catch {
    return undefined;
  }
}

/** The results the agent named, checked against the index: unknown ids dropped. */
export function parseFound(text: string, byId: Map<string, SearchDoc>, memory = ""): FoundResult[] {
  // The last JSON object holding "results" (and, these days, a reply first)
  const replyAt = text.lastIndexOf('{"reply"');
  const at = replyAt >= 0 ? replyAt : text.lastIndexOf('{"results"');
  const start = at >= 0 ? at : text.indexOf("{");
  if (start < 0) return [];
  let body: { results?: unknown };
  try {
    const end = text.lastIndexOf("}");
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const out: FoundResult[] = [];
  for (const raw of Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : []) {
    const doc = typeof raw?.id === "string" ? byId.get(raw.id) : undefined;
    if (!doc || out.some((r) => r.id === doc.id)) continue;
    let locator: Locator = doc.locator;
    const page = Number(raw.page);
    const turn = Number(raw.turn);
    const quote = typeof raw.quote === "string" ? raw.quote.trim().slice(0, 300) : "";
    // The sentence it quoted, in the turn it named; or the one the memory matches best
    if (locator.kind === "conversation") locator = landingFor(doc, memory, Number.isInteger(turn) && turn > 0 ? turn : undefined, quote || undefined);
    if (locator.kind === "paper" && Number.isInteger(page) && page > 0) locator = { ...locator, page, ...(quote ? { quote } : {}) };
    out.push({
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      where: doc.where,
      why: typeof raw.why === "string" ? clip(raw.why, 240) : "",
      locator,
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// What the agent is doing, in a line for the panel
function describeTool(name: string, input: Record<string, unknown>, titles: Map<string, string>): string | null {
  const where = (file: unknown) => {
    const text = String(file ?? "");
    const rel = text.startsWith(SESSIONS_ROOT) ? text.slice(SESSIONS_ROOT.length + 1) : path.basename(text);
    const [id, ...rest] = rel.split("/");
    if (id === "_search") return "the catalog";
    return titles.has(id) ? `${clip(titles.get(id)!, 50)} › ${rest.join("/")}` : rel;
  };
  if (name === "Grep") return `Searching for “${clip(String(input.pattern ?? ""), 60)}”${input.path ? ` in ${where(input.path)}` : ""}`;
  if (name === "Read") return `Reading ${where(input.file_path)}`;
  if (name === "Glob") return `Looking for ${clip(String(input.pattern ?? ""), 60)}`;
  return null;
}

export async function* findFromMemory(
  memory: string,
  index: RankIndex<SearchDoc>,
  workspaces: WorkspaceInput[],
  signal?: AbortSignal,
  reading?: { id: string; title: string },
  history: SearchTurn[] = []
): AsyncGenerator<AgentEvent> {
  const run = path.join(SESSIONS_ROOT, "_search", `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const catalogPath = path.join(run, "catalog.jsonl");
  const byId = new Map(index.docs.map((d) => [d.id, d]));
  const titles = new Map(index.docs.filter((d) => d.kind === "paper").map((d) => [(d.locator as { paperId: string }).paperId, d.title]));
  const roots = workspaces.map((w) => w.root);
  try {
    await mkdir(run, { recursive: true });
    await writeFile(catalogPath, index.docs.map(catalogLine).join("\n") + "\n");
    // Matched by word on the whole search so far, so a follow-up as short as
    // "the other one" still has the first message's words to go on
    const words = [memory, ...history.filter((t) => t.role === "user").map((t) => t.text)].join(" ");
    const candidates = rankSearch(index, words, CANDIDATES).map((r) => r.doc);
    yield { type: "activity", text: candidates.length ? `${candidates.length} close matches by word; looking further` : "No word in common with anything; looking by meaning" };

    const timeout = AbortSignal.timeout(TIME_LIMIT_MS);
    const stream = claudeStream(searchPrompt(memory, catalogPath, candidates, roots, reading, history), {
      model: MODEL,
      effort: EFFORT,
      cwd: SESSIONS_ROOT,
      // Read-only, preapproved: the run cannot ask, and must not write
      permissionArgs: ["--allowedTools", TOOLS],
      extraArgs: ["--tools", TOOLS, "--no-session-persistence", ...(roots.length ? ["--add-dir", ...roots] : [])],
      mcp: false,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    let finalText = "";
    let failure = "";
    const queue: AgentEvent[] = [];
    const split = createLineSplitter((line) => {
      const ev = parseJsonLine(line) as Record<string, unknown> | null;
      if (!ev) return;
      if (ev.type === "assistant") {
        const content = ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
        for (const block of content) {
          if (block.type === "tool_use") {
            const text = describeTool(String(block.name), (block.input ?? {}) as Record<string, unknown>, titles);
            if (text) queue.push({ type: "activity", text });
          }
        }
      }
      if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        if (ev.is_error) failure = typeof ev.result === "string" && ev.result ? ev.result : "The search agent stopped with an error.";
      }
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      split.push(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
    }
    split.push(decoder.decode());
    split.end();
    while (queue.length) yield queue.shift()!;

    if (failure && !finalText.includes('"results"')) {
      yield { type: "error", message: clip(failure, 300) };
      return;
    }
    yield { type: "results", reply: parseReply(finalText), results: parseFound(finalText, byId, memory) };
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : "The search could not run." };
  } finally {
    await rm(run, { recursive: true, force: true }).catch(() => {});
  }
}

// How many of the paper being read come first
const HERE_LIMIT = 8;

// What a result shows of itself: for a conversation, the sentence found,
// question or answer, as a quote; for anything else, the words around the match
function citeFor(doc: SearchDoc, query: string): { snippet: string; locator: Locator } {
  const locator = landingFor(doc, query);
  if (locator.kind === "conversation" && locator.quote) return { snippet: locator.quote, locator };
  return { snippet: snippet(doc.text || doc.title, query), locator };
}

/** Whether a result is one of the paper being read's own conversations or concepts. */
const isHere = (doc: SearchDoc, paperId?: string) =>
  !!paperId && (doc.kind === "conversation" || doc.kind === "concept") && (doc.locator as { paperId?: string }).paperId === paperId;

/**
 * The plain-word results, as the box shows them while typing: the paper
 * being read's own conversations and concepts first, marked as such, then the
 * rest of the library.
 */
export function quickResults(index: RankIndex<SearchDoc>, query: string, limit = 24, paperId?: string) {
  const ranked = rankSearch(index, query, paperId ? 400 : limit).map((r) => r.doc);
  const here = ranked.filter((d) => isHere(d, paperId)).slice(0, HERE_LIMIT);
  const elsewhere = ranked.filter((d) => !isHere(d, paperId)).slice(0, limit);
  return [...here, ...elsewhere].map((doc) => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    where: doc.where,
    here: isHere(doc, paperId),
    ...citeFor(doc, query),
  }));
}
