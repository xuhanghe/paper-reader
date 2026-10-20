// What is being typed and not yet sent: kept per box, so a refresh, a switch
// to another paper, or a crossing to the other surface and back finds it as
// it was left. Text and quoted passages are kept; an attached image is too
// large for storage and lives in memory for the session instead.
//
// Keyed by surface and what the box belongs to: "reader:<paper>" for the
// Reader's composer, "workspace:<workspace>" for the Workspace agent's.
import type { Quote } from "@/lib/quotes";

export type Draft = { text: string; quotes?: Quote[] };

const KEY = "paper-reader:drafts:v1";
// A draft is a few lines; the oldest fall off the end so the store cannot
// grow with a years-old library
const MAX_ENTRIES = 60;

type Stored = Record<string, Draft & { at: number }>;

function readAll(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "null");
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadDraft(key: string | null | undefined): Draft | null {
  if (!key) return null;
  const entry = readAll()[key];
  if (!entry || typeof entry.text !== "string") return null;
  return { text: entry.text, quotes: Array.isArray(entry.quotes) ? entry.quotes : [] };
}

// An empty draft is not kept: sending, or clearing the box, forgets it
export function saveDraft(key: string | null | undefined, draft: Draft, now = Date.now()): void {
  if (!key || typeof window === "undefined") return;
  try {
    const all = readAll();
    if (!draft.text.trim() && !draft.quotes?.length) {
      if (!(key in all)) return;
      delete all[key];
    } else {
      all[key] = { text: draft.text, quotes: draft.quotes?.length ? draft.quotes : undefined, at: now };
    }
    window.localStorage.setItem(KEY, JSON.stringify(trim(all)));
  } catch {
    // losing a draft is never worth breaking a render over
  }
}

// Exported for the test: keeps the newest MAX_ENTRIES entries
export function trim(all: Stored, max = MAX_ENTRIES): Stored {
  const entries = Object.entries(all);
  if (entries.length <= max) return all;
  return Object.fromEntries(entries.sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, max));
}
