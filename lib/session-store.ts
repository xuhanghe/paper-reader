import { homePath } from "@/lib/home";
import { mkdir, readFile, writeFile, appendFile, rename, readdir, stat, rm, unlink } from "node:fs/promises";
import path from "node:path";

// Per-paper session store:
//   .paper-reader-sessions/<id>/
//     state.json    — UI state (annotation cards, prefs)
//     document.dataurl — a local paper's document (not in Zotero), see writeState
//     paper.md      — extracted text, written once; agentic models read it via file tools
//     mindmap.json  — the paper map, independent artifact
//     thread.jsonl  — the fused conversation: every question & answer, appended
//                     to, and rewritten only to delete what the panel deleted
//     withdrawn.json — the numbers of the turns deleted from it
// <id> is the Zotero item key when the paper lives in Zotero, else a name slug.

export const SESSIONS_ROOT = homePath(".paper-reader-sessions");

// A directory name: letters and digits of any script, dashes and underscores.
// Path separators, dots and everything else are dropped, so an id can never
// escape the sessions root. Names are keyed by their own words (see
// lib/session-id.ts), and a Chinese title's words have to survive here too.
export const safeId = (id: string) => id.replace(/[^\p{L}\p{N}\-_]/gu, "").slice(0, 140);

export const dirFor = (id: string) => path.join(SESSIONS_ROOT, safeId(id));
export const paperPathFor = (id: string) => path.join(dirFor(id), "paper.md");

export async function ensureDir(id: string) {
  await mkdir(dirFor(id), { recursive: true });
}

export type ThreadEntry = {
  ts: number;
  role: "user" | "assistant";
  text: string;
  kind?: string;
  annotationId?: string;
  hasImage?: boolean;
  // Captured figures are stored as files and referenced here — history stays
  // complete without re-injecting image bytes on replay. Relative to the
  // session directory; see resolveSessionFile.
  imageFile?: string;
  // On an answer, the turn it answers. Answers written before turns could be
  // withdrawn carry none.
  turn?: number;
};

// The session-relative form of a stored reference. References are written
// relative so a saved thread survives the project being moved or renamed; this
// also normalises entries written before that was true, so an absolute path —
// carrying the user's home directory — never reaches a provider on replay.
export function sessionRelativeFile(id: string, ref: string): string {
  return path.isAbsolute(ref) ? path.relative(dirFor(id), ref) : ref;
}

// ── state.json (with migration from the old flat <slug>.json layout) ──

// A local paper's document — a PDF or a page that is not in Zotero — is kept
// beside its state rather than inside it: written when it arrives, not again
// with every change to a conversation, and read only by whoever asks for it.
// A paper in Zotero keeps none; its document is read from Zotero.
const DOCUMENT_FILE = "document.dataurl";

// Written whole or not at all: a reader never sees half a file. Each write has
// its own temporary name, so two saves landing together cannot share one.
let tempCount = 0;
async function writeAtomic(file: string, text: string) {
  const temp = `${file}.${process.pid}.${++tempCount}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * A paper's saved state. Its document is attached only when `document` is
 * asked for — everything else reads the conversation, and a local paper's
 * document is megabytes.
 */
export async function readState(id: string, legacyId?: string, opts: { document?: boolean } = {}): Promise<Record<string, unknown> | null> {
  const state = await readStateFile(id, legacyId);
  if (!state) return null;
  const embedded = typeof state.pdfDataUrl === "string" && state.pdfDataUrl;
  if (!opts.document) delete state.pdfDataUrl;
  else if (!embedded) {
    try {
      state.pdfDataUrl = await readFile(path.join(dirFor(id), DOCUMENT_FILE), "utf8");
    } catch {
      // a paper in Zotero, or one with nothing saved
    }
  }
  return state;
}

async function readStateFile(id: string, legacyId?: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(dirFor(id), "state.json"), "utf8"));
  } catch {
    // legacy locations: flat file under the new id, then under the old name-slug
    for (const candidate of [safeId(id), legacyId ? safeId(legacyId) : null].filter(Boolean) as string[]) {
      const flat = path.join(SESSIONS_ROOT, `${candidate}.json`);
      try {
        const state = JSON.parse(await readFile(flat, "utf8"));
        // migrate into the directory layout
        await writeState(id, state);
        await rename(flat, `${flat}.migrated`).catch(() => {});
        return state;
      } catch {
        // keep trying
      }
    }
    return null;
  }
}

/**
 * Saves a paper's state. A document in it is written to its own file; a state
 * without one (`pdfDataUrl` empty) keeps the document already saved — an
 * empty field never deletes it. A state saved before documents were kept
 * apart has its document moved out on its next save.
 */
export async function writeState(id: string, state: unknown) {
  await ensureDir(id);
  const dir = dirFor(id);
  const record = { ...(state as Record<string, unknown>) };
  const document = typeof record.pdfDataUrl === "string" ? record.pdfDataUrl : "";
  const documentFile = path.join(dir, DOCUMENT_FILE);
  if (document) {
    await writeAtomic(documentFile, document);
  } else if (!record.zoteroKey && !(await exists(documentFile))) {
    try {
      const before = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
      if (typeof before?.pdfDataUrl === "string" && before.pdfDataUrl) await writeAtomic(documentFile, before.pdfDataUrl);
    } catch {
      // nothing saved before
    }
  }
  record.pdfDataUrl = "";
  await writeAtomic(path.join(dir, "state.json"), JSON.stringify(record));
}

// The Workspace marks the same paper the Reader does, and keeps the marks
// where the Reader will find them: in the paper's state.json. A paper with no
// state yet — attached from Zotero, never opened in the Reader — gets the
// minimal one the Reader can open (it fetches the PDF by Zotero key). A local
// paper with no state cannot be seeded: its PDF bytes live only in its session.
export async function patchSessionHighlights(
  id: string,
  highlights: unknown[],
  seed?: { pdfName?: string; zoteroKey?: string; zoteroAttachmentKey?: string }
): Promise<"updated" | "created" | "missing"> {
  const state = await readState(id);
  if (state) {
    await writeState(id, { ...state, highlights });
    return "updated";
  }
  if (!seed?.zoteroKey) return "missing";
  await writeState(id, {
    pdfName: seed.pdfName || `${seed.zoteroKey}.pdf`,
    pdfDataUrl: "",
    docType: "pdf",
    zoteroKey: seed.zoteroKey,
    zoteroAttachmentKey: seed.zoteroAttachmentKey,
    annotations: [],
    concepts: [],
    highlights,
    model: "claude:sonnet",
  });
  return "created";
}

export async function deleteSession(id: string) {
  await rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
}

export async function listSessions(): Promise<{ id: string; updatedAt: number }[]> {
  try {
    const entries = await readdir(SESSIONS_ROOT, { withFileTypes: true });
    const sessions: { id: string; updatedAt: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const s = await stat(path.join(SESSIONS_ROOT, e.name, "state.json"));
        sessions.push({ id: e.name, updatedAt: s.mtimeMs });
      } catch {
        // dir without state — skip
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  } catch {
    return [];
  }
}

// ── paper.md ──

export async function writePaperText(id: string, title: string, text: string) {
  await ensureDir(id);
  await writeFile(paperPathFor(id), `# ${title}\n\n${text}`);
}

export async function readPaperText(id: string): Promise<string | null> {
  try {
    return await readFile(paperPathFor(id), "utf8");
  } catch {
    return null;
  }
}

export async function hasPaperText(id: string): Promise<boolean> {
  try {
    await stat(paperPathFor(id));
    return true;
  } catch {
    return false;
  }
}

// ── pages/ — per-page snapshots for multimodal understanding ──

export const pagesDirFor = (id: string) => path.join(dirFor(id), "pages");

export async function writePageImage(id: string, n: number, dataUrl: string) {
  await mkdir(pagesDirFor(id), { recursive: true });
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  await writeFile(path.join(pagesDirFor(id), `page-${n}.jpg`), Buffer.from(base64, "base64"));
}

export async function countPageImages(id: string): Promise<number> {
  try {
    return (await readdir(pagesDirFor(id))).filter((f) => f.endsWith(".jpg")).length;
  } catch {
    return 0;
  }
}

export async function readPageImageDataUrl(id: string, n: number): Promise<string | null> {
  try {
    const buf = await readFile(path.join(pagesDirFor(id), `page-${n}.jpg`));
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── figures/ — screenshots the user asked about, stored once ──

export const figuresDirFor = (id: string) => path.join(dirFor(id), "figures");

// Returns the reference to record in the thread — relative to the session
// directory, never an absolute path: the thread outlives any one checkout, and
// an absolute path would also carry the user's home directory into replayed
// prompts sent to third-party endpoints.
export async function writeFigureImage(id: string, dataUrl: string): Promise<string | null> {
  try {
    await mkdir(figuresDirFor(id), { recursive: true });
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const name = `fig-${Date.now()}.png`;
    await writeFile(path.join(figuresDirFor(id), name), Buffer.from(base64, "base64"));
    return path.posix.join("figures", name);
  } catch {
    return null;
  }
}

// A figure the thread refers to, as a data URL to send again. Typed by its
// bytes, not its name: a figure is saved as .png whatever it was captured as,
// and an API that is told the wrong type refuses the image.
export async function readFigureDataUrl(id: string, ref: string): Promise<string | null> {
  const file = path.resolve(dirFor(id), sessionRelativeFile(id, ref));
  if (!file.startsWith(dirFor(id) + path.sep)) return null;
  try {
    const buf = await readFile(file);
    const mime = imageType(buf);
    return mime ? `data:${mime};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
}

function imageType(buf: Buffer): string | null {
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export async function countFigures(id: string): Promise<number> {
  try {
    return (await readdir(figuresDirFor(id))).filter((f) => f.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

// ── mindmap.json ──

export async function writeMindmapFile(id: string, mindmap: unknown) {
  await ensureDir(id);
  await writeFile(path.join(dirFor(id), "mindmap.json"), JSON.stringify(mindmap, null, 1));
}

export async function readMindmapFile(id: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path.join(dirFor(id), "mindmap.json"), "utf8"));
  } catch {
    return null;
  }
}

// ── thread.jsonl ──

const threadPathFor = (id: string) => path.join(dirFor(id), "thread.jsonl");

// Every write to a paper's thread, one at a time: an answer arriving while a
// deletion rewrites the file lands in the new file rather than being lost
const threadWrites = new Map<string, Promise<unknown>>();
function writingThread<T>(id: string, write: () => Promise<T>): Promise<T> {
  const key = safeId(id);
  const run = (threadWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  threadWrites.set(key, run);
  return run.finally(() => {
    if (threadWrites.get(key) === run) threadWrites.delete(key);
  });
}

// Each line with what it holds; a half-written line holds nothing
async function threadLines(id: string): Promise<{ line: string; entry: ThreadEntry | null }[]> {
  try {
    const raw = await readFile(threadPathFor(id), "utf8");
    return raw.split("\n").filter((line) => line.trim()).map((line) => {
      try { return { line, entry: JSON.parse(line) as ThreadEntry }; } catch { return { line, entry: null }; }
    });
  } catch {
    return [];
  }
}
const entriesOf = (lines: { entry: ThreadEntry | null }[]) => lines.flatMap((l) => (l.entry ? [l.entry] : []));

export function appendThread(id: string, entry: ThreadEntry): Promise<void> {
  return writingThread(id, async () => {
    // What arrives for a question, or a card, deleted while it was being answered
    const deleted = await readDeleted(id);
    if (entry.annotationId && deleted.conversations.includes(entry.annotationId)) return;
    if (entry.role === "assistant" && entry.turn !== undefined && deleted.turns.includes(entry.turn)) return;
    await ensureDir(id);
    await appendFile(threadPathFor(id), JSON.stringify(entry) + "\n");
  });
}

// How many questions this paper's thread holds
export async function countAsks(id: string): Promise<number> {
  return entriesOf(await threadLines(id)).filter((e) => e.role === "user").length;
}

// The highest number an ask has been given: off its [turn N] marker, by count
// for one from before the markers, or a deleted one's. The next ask is
// numbered after it, so no number is given out twice — not even a deleted
// one, which an agent resumed by session id may still remember by it.
export async function lastTurn(id: string): Promise<number> {
  const asked = numberedQuestions(entriesOf(await threadLines(id))).map((q) => q.turn);
  return Math.max(0, ...asked, ...(await readWithdrawn(id)));
}

// Each question with its number as the model knew it: its [turn N] marker,
// or its count for one from before the markers
function numberedQuestions(entries: ThreadEntry[]): { entry: ThreadEntry; turn: number }[] {
  let count = 0;
  return entries.flatMap((entry) => {
    if (entry.role !== "user") return [];
    count += 1;
    const marker = /^\[turn (\d+)\]/.exec(entry.text);
    return [{ entry, turn: marker ? Number(marker[1]) : count }];
  });
}

export async function readThread(id: string, maxEntries = 40, maxChars = 24000): Promise<ThreadEntry[]> {
  // Before the cap, which counts what is kept. Turns deleted before the
  // thread was rewritten on deletion are only listed as deleted.
  const entries = withoutWithdrawn(entriesOf(await threadLines(id)), await readWithdrawn(id));
  // newest-biased cap
  const recent = entries.slice(-maxEntries);
  let total = 0;
  const kept: ThreadEntry[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    total += recent[i].text.length;
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(recent[i]);
  }
  return kept;
}

// ── Deleting turns ──
//
// A question deleted in the panel — on its own with its answer, or with its
// whole card — is deleted from the thread too: the question, its answer, and
// any figure only it used, as though it had never been asked. The model is
// told nothing. Its number is kept in withdrawn.json, so that it is never
// given out again, and so that an answer still arriving for it is dropped;
// so is a deleted card's id, for whatever of it arrives without a number.
//
// A card or an edit deletes by conversation rather than by the numbers the
// panel holds: a question still being asked has none there yet, and some
// older cards never had them.

const withdrawnPathFor = (id: string) => path.join(dirFor(id), "withdrawn.json");
const turnList = (value: unknown): number[] =>
  Array.isArray(value) ? [...new Set(value.filter((t): t is number => Number.isInteger(t) && t > 0))].sort((a, b) => a - b) : [];

async function readDeleted(id: string): Promise<{ turns: number[]; conversations: string[] }> {
  try {
    const raw = JSON.parse(await readFile(withdrawnPathFor(id), "utf8")) as { turns?: unknown; conversations?: unknown };
    const conversations = Array.isArray(raw.conversations) ? raw.conversations.filter((c): c is string => typeof c === "string" && !!c) : [];
    return { turns: turnList(raw.turns), conversations: [...new Set(conversations)] };
  } catch {
    return { turns: [], conversations: [] };
  }
}

export async function readWithdrawn(id: string): Promise<number[]> {
  return (await readDeleted(id)).turns;
}

// A rewrite deleted takes the question it replaced with it: the panel showed
// the rewrite in its place, so neither is there any more. (Edits now delete
// what they replace when they are asked; this is for records from before.)
const REWRITE_OF = /^\[turn (\d+)\]\s*This replaces my question in \[turn (\d+)\]/;
function withReplaced(entries: ThreadEntry[], turns: number[]): number[] {
  const replaced: [number, number][] = [];
  for (const entry of entries) {
    const rewrite = entry.role === "user" ? REWRITE_OF.exec(entry.text) : null;
    if (rewrite) replaced.push([Number(rewrite[1]), Number(rewrite[2])]);
  }
  const gone = new Set(turns);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [rewrite, original] of replaced) {
      if (gone.has(rewrite) && !gone.has(original)) { gone.add(original); grew = true; }
    }
  }
  return turnList([...gone]);
}

/**
 * Deletes from the thread the turns named and, for a conversation, its turns
 * from `fromTurn` on — or, with no turn given, all of it, a question still
 * being asked included.
 */
export function deleteFromThread(id: string, what: { turns?: number[]; conversation?: string; fromTurn?: number }): Promise<void> {
  return writingThread(id, async () => {
    const lines = await threadLines(id);
    const entries = entriesOf(lines);
    const deleted = await readDeleted(id);
    const turns = [...deleted.turns, ...(what.turns ?? [])];
    const conversations = [...deleted.conversations];
    if (what.conversation) {
      for (const { entry, turn } of numberedQuestions(entries)) {
        if (entry.annotationId === what.conversation && turn >= (what.fromTurn ?? 0)) turns.push(turn);
      }
      if (what.fromTurn === undefined) conversations.push(what.conversation);
    }
    const gone = withReplaced(entries, turnList(turns));
    const goneConversations = [...new Set(conversations)];
    await ensureDir(id);
    await writeAtomic(withdrawnPathFor(id), JSON.stringify({ turns: gone, ...(goneConversations.length ? { conversations: goneConversations } : {}) }));
    const kept = new Set(withoutWithdrawn(entries, gone).filter((e) => !e.annotationId || !goneConversations.includes(e.annotationId)));
    if (kept.size === entries.length) return;
    const remaining = lines.filter((l) => !l.entry || kept.has(l.entry));
    await writeAtomic(threadPathFor(id), remaining.map((l) => `${l.line}\n`).join(""));
    // The figures only the deleted entries used
    const used = new Set(entriesOf(remaining).flatMap((e) => (e.imageFile ? [sessionRelativeFile(id, e.imageFile)] : [])));
    for (const entry of entries) {
      if (!entry.imageFile || kept.has(entry)) continue;
      const ref = sessionRelativeFile(id, entry.imageFile);
      const file = path.resolve(dirFor(id), ref);
      if (!used.has(ref) && file.startsWith(figuresDirFor(id) + path.sep)) await unlink(file).catch(() => {});
    }
  });
}

export function withdrawTurns(id: string, turns: number[]): Promise<void> {
  return deleteFromThread(id, { turns });
}

/**
 * The thread without its withdrawn turns: each withdrawn question and the
 * answer it got. A question's turn is its [turn N] marker, or its count for
 * one from before the markers, as the model knew them. An answer names its
 * turn since withdrawals existed; an older one is the next answer in the same
 * conversation — unless that conversation asks again first, since an answer
 * that came to nothing was never written.
 */
export function withoutWithdrawn(entries: ThreadEntry[], turns: Iterable<number>): ThreadEntry[] {
  const gone = new Set(turns);
  if (!gone.size) return entries;
  const kept: ThreadEntry[] = [];
  // Conversations whose withdrawn question's answer is still to come
  const awaiting = new Set<string>();
  let count = 0;
  for (const entry of entries) {
    const conversation = entry.annotationId ?? "";
    if (entry.role === "user") {
      count += 1;
      const marker = /^\[turn (\d+)\]/.exec(entry.text);
      awaiting.delete(conversation);
      if (gone.has(marker ? Number(marker[1]) : count)) awaiting.add(conversation);
      else kept.push(entry);
      continue;
    }
    if (entry.turn !== undefined ? gone.has(entry.turn) : awaiting.has(conversation)) {
      awaiting.delete(conversation);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}
