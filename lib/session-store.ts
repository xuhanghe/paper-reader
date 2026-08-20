import { mkdir, readFile, writeFile, appendFile, rename, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";

// Per-paper session store:
//   .paper-reader-sessions/<id>/
//     state.json    — UI state (annotation cards, prefs)
//     paper.md      — extracted text, written once; agentic models read it via file tools
//     mindmap.json  — the paper map, independent artifact
//     thread.jsonl  — the fused conversation: every question & answer, append-only
// <id> is the Zotero item key when the paper lives in Zotero, else a name slug.

export const SESSIONS_ROOT = path.join(process.cwd(), ".paper-reader-sessions");

export const safeId = (id: string) => id.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 140);

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
};

// The session-relative form of a stored reference. References are written
// relative so a saved thread survives the project being moved or renamed; this
// also normalises entries written before that was true, so an absolute path —
// carrying the user's home directory — never reaches a provider on replay.
export function sessionRelativeFile(id: string, ref: string): string {
  return path.isAbsolute(ref) ? path.relative(dirFor(id), ref) : ref;
}

// ── state.json (with migration from the old flat <slug>.json layout) ──

export async function readState(id: string, legacyId?: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(dirFor(id), "state.json"), "utf8"));
  } catch {
    // legacy locations: flat file under the new id, then under the old name-slug
    for (const candidate of [safeId(id), legacyId ? safeId(legacyId) : null].filter(Boolean) as string[]) {
      const flat = path.join(SESSIONS_ROOT, `${candidate}.json`);
      try {
        const state = JSON.parse(await readFile(flat, "utf8"));
        // migrate into the directory layout
        await ensureDir(id);
        await writeFile(path.join(dirFor(id), "state.json"), JSON.stringify(state));
        await rename(flat, `${flat}.migrated`).catch(() => {});
        return state;
      } catch {
        // keep trying
      }
    }
    return null;
  }
}

export async function writeState(id: string, state: unknown) {
  await ensureDir(id);
  await writeFile(path.join(dirFor(id), "state.json"), JSON.stringify(state));
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

export async function appendThread(id: string, entry: ThreadEntry) {
  await ensureDir(id);
  await appendFile(path.join(dirFor(id), "thread.jsonl"), JSON.stringify(entry) + "\n");
}

// How many questions this paper's thread already holds. Every ask is numbered
// with it, so an answer can point back at one of them by number.
export async function countAsks(id: string): Promise<number> {
  try {
    const raw = await readFile(path.join(dirFor(id), "thread.jsonl"), "utf8");
    let n = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as ThreadEntry).role === "user") n++;
      } catch {
        // a half-written line is not a question
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export async function readThread(id: string, maxEntries = 40, maxChars = 24000): Promise<ThreadEntry[]> {
  try {
    const raw = await readFile(path.join(dirFor(id), "thread.jsonl"), "utf8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l) as ThreadEntry; } catch { return null; }
      })
      .filter(Boolean) as ThreadEntry[];
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
  } catch {
    return [];
  }
}
