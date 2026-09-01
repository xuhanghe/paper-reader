// Where you were in a paper: scroll offset and zoom, remembered per document.
//
// Reopening a paper — after a restart, or after crossing between Reader and
// Workspace — should put you back on the paragraph you were reading at the
// size you were reading it, not at the top of page 1 at the default zoom.
//
// Keyed by paper, because the position belongs to the document rather than to
// the surface showing it: the same paper opened on either side resumes in the
// same place.

export type ReadingPosition = {
  scrollTop: number;
  /** pdf.js scale, or "page-width" for the fit-to-width default */
  scale: number | "page-width";
  page?: number;
};

const KEY = "paper-reader:reading-positions:v1";
// Enough for a long session's worth of papers; the oldest fall off the end so
// a years-old library can't grow this without bound.
const MAX_ENTRIES = 80;

type Stored = Record<string, ReadingPosition & { at: number }>;

function readAll(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "null");
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadReadingPosition(paperId: string | undefined): ReadingPosition | null {
  if (!paperId) return null;
  const entry = readAll()[paperId];
  if (!entry || typeof entry.scrollTop !== "number") return null;
  return { scrollTop: entry.scrollTop, scale: entry.scale ?? "page-width", page: entry.page };
}

export function saveReadingPosition(paperId: string | undefined, position: ReadingPosition, now = Date.now()): void {
  if (!paperId || typeof window === "undefined") return;
  try {
    const all = readAll();
    all[paperId] = { ...position, at: now };
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
