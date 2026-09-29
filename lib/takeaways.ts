// What a conversation established, in a few lines.
//
// The Concepts list used to be a table of contents: one row per conversation,
// labelled with the words that started it. That tells you where you asked
// something, not what you learned. These are the answers themselves, short
// enough to scan.

export const MAX_TAKEAWAYS = 4;

// Models wrap JSON in fences, preambles, or both, however plainly they are
// asked not to. Take the first array in the text and be forgiving about the
// rest — an unparsed reply means the row stays empty for no good reason.
export function parseTakeaways(text: string): string[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // Bullet markers and stray quotes creep in even inside the JSON
    const line = item.replace(/^\s*[-*•]\s*/, "").replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length === MAX_TAKEAWAYS) break;
  }
  return out;
}

// A summary is stale as soon as the conversation moves on, so what it covered
// is recorded with it rather than guessed at later.
export function isStale(summarizedTurns: number | undefined, messageCount: number): boolean {
  return summarizedTurns === undefined || summarizedTurns !== messageCount;
}

// What the list becomes after a fresh summary. The reader's own lines are
// kept word for word: a list they wrote in is theirs, and the model may only
// add to it. A summary that came back empty changes nothing.
export function mergeTakeaways(previous: string[], next: string[], edited: boolean): string[] {
  if (next.length === 0) return previous;
  if (!edited) return next;
  const fold = (line: string) => line.replace(/\s+/g, " ").trim().toLowerCase();
  const have = new Set(previous.map(fold));
  const out = [...previous];
  for (const line of next) {
    if (out.length >= MAX_TAKEAWAYS) break;
    if (have.has(fold(line))) continue;
    have.add(fold(line));
    out.push(line);
  }
  return out;
}
