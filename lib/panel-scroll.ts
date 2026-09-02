// Where you were in a conversation: the Ask panel's scroll offset, remembered
// per paper.
//
// The panel's list unmounts whenever it is out of sight — collapsed to its
// rail, or left behind when crossing to the Workspace — and a fresh mount
// starts at the top. Coming back should land on the exchange being read, the
// way the paper itself resumes on the paragraph being read.

const KEY = "paper-reader:ask-scroll:v1";
const MAX_ENTRIES = 80;

type Stored = Record<string, { top: number; at: number }>;

function readAll(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "null");
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadPanelScroll(paperId: string | undefined): number | null {
  if (!paperId) return null;
  const entry = readAll()[paperId];
  return entry && typeof entry.top === "number" ? entry.top : null;
}

export function savePanelScroll(paperId: string | undefined, top: number, now = Date.now()): void {
  if (!paperId || typeof window === "undefined") return;
  try {
    const all = readAll();
    all[paperId] = { top, at: now };
    localStorage.setItem(KEY, JSON.stringify(trim(all)));
  } catch {
    // losing a scroll offset is never worth breaking a render over
  }
}

// Exported for the test: keeps the newest MAX_ENTRIES entries.
export function trim(all: Stored, max = MAX_ENTRIES): Stored {
  const entries = Object.entries(all);
  if (entries.length <= max) return all;
  const newest = entries.sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, max);
  return Object.fromEntries(newest);
}
