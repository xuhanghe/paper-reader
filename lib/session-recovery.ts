// When a provider's own transcript of a conversation is gone — Claude Code
// deletes transcripts after 30 days of quiet; a session id was lost; the
// reader switched provider — the conversation goes on in a fresh provider
// session seeded from the app's own record. The thread file holds every turn;
// an agent with file tools is told where it is and what is in it, and reads
// the right turn for itself when a question reaches back. One without tools
// gets the recent part inline. The app never loses the conversation; what is
// rebuilt here is the provider's memory of it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dirFor, readState, readWithdrawn, withoutWithdrawn, type ThreadEntry } from "@/lib/session-store";
import type { ConceptEntry } from "@/types/session";

export type AskIndexEntry = { turn: number; kind: string; page?: number; gist: string; ts: number };

// What the app appends to an ask — how to answer, not what was asked
const DIRECTIVE_STARTS = [
  "\n\nExplain it:",
  "\n\nExplain what this is on its own terms",
  "\n\nThis is a question about the term itself",
  "\n\nWhere you draw on the paper",
  "\n\nLive web search is available",
  "\n\nUse these user-selected skills",
  "\n\nAnswer in ",
  "\n\nI am at page ",
  "\n\nHere I am asking about the paper as a whole",
];
// Edited questions were once sent with a note saying what they replaced;
// records written then still hold it
const REWRITE = /^This replaces (?:my question in \[turn \d+\]|an earlier question of mine): I have rewritten it\.[^\n]*\n\n/;

function withoutDirectives(text: string): string {
  let cut = text.length;
  for (const directive of DIRECTIVE_STARTS) {
    const at = text.indexOf(directive);
    if (at >= 0 && at < cut) cut = at;
  }
  return text.slice(0, cut).replace(REWRITE, "").trim();
}

const tidy = (text: string, max = 110) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// What an ask was about, read back off the message the app composed for it
export function askGist(text: string): { page?: number; gist: string } {
  const body = withoutDirectives(text.replace(/^\[turn \d+\]\s*/, ""));
  const passage = /^(?:I selected this (?:passage|term)|About this (?:passage|term))(?: \(page (\d+)\))?:\n\n"([\s\S]*?)"(?:\n\nMy question: ([\s\S]*))?$/.exec(body);
  if (passage) {
    const page = passage[1] ? Number(passage[1]) : undefined;
    const quote = tidy(passage[2], 70);
    return passage[3] ? { page, gist: `${tidy(passage[3])} — on "${quote}"` } : { page, gist: `"${quote}"` };
  }
  if (/^I captured the attached figure/.test(body)) {
    const question = /My question: ([\s\S]*)$/.exec(body);
    return { gist: question ? `a captured figure — ${tidy(question[1])}` : "a captured figure" };
  }
  if (/^Passages I selected from the paper/.test(body)) {
    // The question follows the labelled quotes
    const paragraphs = body.split(/\n\n+/).filter((p) => !/^\[\d+\] from/.test(p) && !p.startsWith(">") && !/^Passages I selected/.test(p));
    return { gist: tidy(paragraphs[paragraphs.length - 1] ?? body) };
  }
  return { gist: tidy(body) };
}

// Every question in a thread, numbered as the model knew it: by its [turn N]
// marker, or by count for entries from before the markers existed
export function indexThread(entries: ThreadEntry[]): AskIndexEntry[] {
  const index: AskIndexEntry[] = [];
  let count = 0;
  for (const entry of entries) {
    if (entry.role !== "user") continue;
    count += 1;
    const marker = /^\[turn (\d+)\]/.exec(entry.text);
    const { page, gist } = askGist(entry.text);
    index.push({ turn: marker ? Number(marker[1]) : count, kind: entry.kind ?? "question", page, gist, ts: entry.ts });
  }
  return index;
}

export const threadPathFor = (id: string) => path.join(dirFor(id), "thread.jsonl");

export async function readWholeThread(id: string): Promise<ThreadEntry[]> {
  try {
    const raw = await readFile(threadPathFor(id), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) as ThreadEntry; } catch { return null; }
    }).filter(Boolean) as ThreadEntry[];
  } catch {
    return [];
  }
}

// What each conversation established, as the Concepts tab shows it
export function takeawayLines(concepts: ConceptEntry[], max = 10, maxChars = 180): string[] {
  const lines: string[] = [];
  for (const concept of concepts) {
    for (const line of concept.takeaways ?? []) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push(text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);
      if (lines.length >= max) return lines;
    }
  }
  return lines;
}

// The entries of the thread from before a given turn — the current question,
// already appended, is not "earlier"
export function entriesBefore(entries: ThreadEntry[], turn: number): ThreadEntry[] {
  const kept: ThreadEntry[] = [];
  let current = 0;
  for (const entry of entries) {
    if (entry.role === "user") {
      current += 1;
      const marker = /^\[turn (\d+)\]/.exec(entry.text);
      if (marker) current = Number(marker[1]);
    }
    if (current >= turn) break;
    kept.push(entry);
  }
  return kept;
}

export type EarlierConversation = {
  threadPath: string;
  index: AskIndexEntry[];
  takeaways: string[];
  // The most recent part, for a provider without file tools
  recent: ThreadEntry[];
};

const RECENT_ENTRIES = 24;
const RECENT_CHARS = 16000;

export async function earlierConversation(id: string, opts: { beforeTurn: number }): Promise<EarlierConversation | null> {
  // Turns deleted before deletion rewrote the thread are still in it, only
  // listed as deleted. Cut before they go: a question from before the markers
  // is numbered by its place in the whole thread.
  const deleted = (await readWithdrawn(id)).filter((t) => t < opts.beforeTurn);
  const entries = withoutWithdrawn(entriesBefore(await readWholeThread(id), opts.beforeTurn), deleted);
  const index = indexThread(entries);
  if (!index.length) return null;
  const state = await readState(id);
  const takeaways = takeawayLines(Array.isArray(state?.concepts) ? (state.concepts as ConceptEntry[]) : []);
  // Newest-biased slice, as the custom provider's replay is
  const recent: ThreadEntry[] = [];
  let chars = 0;
  for (const entry of entries.slice(-RECENT_ENTRIES).reverse()) {
    chars += entry.text.length;
    if (chars > RECENT_CHARS && recent.length) break;
    recent.unshift(entry);
  }
  return { threadPath: threadPathFor(id), index, takeaways, recent };
}

const FORMAT = "one JSON object per line ({ts, role, text, kind, annotationId, imageFile}), in order, each message of mine carrying its [turn N] marker";

export function earlierConversationSection(earlier: EarlierConversation, opts: { agentic: boolean }): string {
  const parts: string[] = [];
  if (opts.agentic) {
    parts.push(
      `We have talked about this paper before. Your own memory of that conversation is gone, but the record of it is complete, in this file — ${FORMAT}:\n${earlier.threadPath}\nWhen I refer to something we discussed, or you build on an earlier answer, read that file first: find the turn by its marker or by its words (grep works), then read my message and the answer that follows it. Do not guess at what was said. Turn numbers continue from where they left off.`
    );
  } else {
    parts.push("We have talked about this paper before. Your own memory of that conversation is gone; the app keeps the record, and the most recent part of it is below, oldest first. Turn numbers continue from where they left off.");
  }
  if (earlier.takeaways.length) {
    parts.push(`What we worked out so far:\n${earlier.takeaways.map((line) => `• ${line}`).join("\n")}`);
  }
  parts.push(`The questions so far:\n${earlier.index.map((e) => `[turn ${e.turn}]${e.page ? ` (page ${e.page})` : ""} ${e.gist}`).join("\n")}`);
  if (!opts.agentic && earlier.recent.length) {
    parts.push(earlier.recent.map((e) => `${e.role === "user" ? "Me" : "You"}: ${tidy(e.role === "user" ? withoutDirectives(e.text) : e.text, e.role === "user" ? 400 : 900)}`).join("\n"));
  }
  return parts.join("\n\n");
}

// ── The thread sent to a custom endpoint ──
//
// A custom endpoint keeps no conversation of its own: every question goes to
// it with the thread before it. Nor has it file tools, so a figure in that
// thread goes as the image itself, never as a path it cannot open — when the
// model reads images, and only a few: the conversation's own first, then the
// most recent. Any other is said in words.

export const REPLAY_FIGURES = 3;
const FIGURE_NOT_SHOWN = "(I attached a figure to this message. It is not shown to you here; go by what was said about it.)";

export type ReplayMessage = { role: "user" | "assistant"; content: string | unknown[] };

export async function replayForEndpoint(
  entries: ThreadEntry[],
  opts: { vision: boolean; annotationId?: string; readFigure: (ref: string) => Promise<string | null>; max?: number },
): Promise<ReplayMessage[]> {
  const shown = new Map<ThreadEntry, string>();
  if (opts.vision) {
    const own = (e: ThreadEntry) => !!opts.annotationId && e.annotationId === opts.annotationId;
    // Newest first, the conversation asked in ahead of the rest (sort is stable)
    const figures = entries.filter((e) => e.role === "user" && e.imageFile).reverse().sort((a, b) => Number(own(b)) - Number(own(a)));
    for (const entry of figures) {
      if (shown.size >= (opts.max ?? REPLAY_FIGURES)) break;
      const url = await opts.readFigure(entry.imageFile!);
      if (url) shown.set(entry, url);
    }
  }
  return entries.map((entry) => {
    const url = shown.get(entry);
    if (url) return { role: entry.role, content: [{ type: "image_url", image_url: { url } }, { type: "text", text: entry.text }] };
    const figure = entry.role === "user" && (entry.imageFile || entry.hasImage);
    return { role: entry.role, content: figure ? `${FIGURE_NOT_SHOWN}\n${entry.text}` : entry.text };
  });
}

// ── The workspace chat, which has no thread file ──

export type ChatTurn = { role: "user" | "assistant"; content: string };
const CHAT_TURNS = 30;
const CHAT_TURN_CHARS = 1500;
const CHAT_CHARS = 12000;

export function parseChatHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value
    .filter((m): m is ChatTurn => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !!m.content.trim())
    .slice(-CHAT_TURNS)
    .map((m) => ({ role: m.role, content: m.content.length > CHAT_TURN_CHARS ? `${m.content.slice(0, CHAT_TURN_CHARS - 1)}…` : m.content }));
  let chars = 0;
  const kept: ChatTurn[] = [];
  for (const turn of turns.reverse()) {
    chars += turn.content.length;
    if (chars > CHAT_CHARS && kept.length) break;
    kept.unshift(turn);
  }
  return kept;
}

export function chatHistorySection(history: ChatTurn[]): string {
  if (!history.length) return "";
  return `Earlier in this chat. Your own memory of it is gone; this is the record, oldest first:\n${history.map((t) => `${t.role === "user" ? "Me" : "You"}: ${t.content.replace(/\s+/g, " ").trim()}`).join("\n")}`;
}

// ── Telling a lost session from any other failure ──

// What each provider's stream holds when the session it was asked to resume
// no longer exists, and nothing else happened
export const LOST_SESSION = {
  claude: (output: string, stderr = "") =>
    /No conversation found with session ID/.test(stderr) ||
    (/"subtype":"error_during_execution"/.test(output) && /"num_turns":0/.test(output)),
  codex: (output: string) => /no rollout found|thread\/resume failed/.test(output),
  opencode: (output: string) => /Error: opencode responded with 404/.test(output),
};

// Something the model actually did: an answer or a tool, not a session
// announcement and not an error line
const PROGRESS = /"type":"(?:assistant|stream_event|tool)"/;
const ERROR_TEXT = /"text":"(?:\\n\\n)?Error:/;
export function showsProgress(output: string): boolean {
  if (PROGRESS.test(output)) return true;
  return /"type":"content_block_delta"/.test(output) && !ERROR_TEXT.test(output);
}

// Runs the resumed attempt; if it produces nothing but the signs of a lost
// session, runs the fresh attempt in its place, on the same response. Until
// the resumed attempt shows progress its output is held back, so a failed
// start is never shown to the reader.
export function freshStartOnLostSession(
  resumed: ReadableStream,
  fresh: () => Promise<ReadableStream>,
  lost: (output: string) => boolean,
  onDone?: () => void,
): ReadableStream {
  const decoder = new TextDecoder();
  let active: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      const held: Uint8Array[] = [];
      let output = "";
      let committed = false;
      try {
        active = resumed.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        while (true) {
          const { done, value } = await active.read();
          if (done) break;
          if (committed) { controller.enqueue(value); continue; }
          held.push(value);
          output += decoder.decode(value, { stream: true });
          if (showsProgress(output)) {
            committed = true;
            for (const chunk of held) controller.enqueue(chunk);
            held.length = 0;
          }
        }
        if (!committed && !cancelled) {
          if (lost(output)) {
            active = (await fresh()).getReader() as ReadableStreamDefaultReader<Uint8Array>;
            while (true) {
              const { done, value } = await active.read();
              if (done) break;
              controller.enqueue(value);
            }
          } else {
            for (const chunk of held) controller.enqueue(chunk);
          }
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        onDone?.();
      }
    },
    cancel() {
      cancelled = true;
      active?.cancel().catch(() => {});
    },
  });
}
