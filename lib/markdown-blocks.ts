// An answer as blocks, split at blank lines, so a streaming answer re-parses
// only the block still being written. Every chunk used to re-parse the whole
// answer — markdown, formulas and all — hundreds of times over one reply.
//
// Blank lines inside a fenced code block or a display formula are not
// boundaries, and a list or a quotation that a blank line only loosens stays
// one block, so the separate parses render as the whole would have. Joined,
// the blocks are the text exactly.

const FENCE = /^\s{0,3}(```|~~~)/;
const DISPLAY_MATH = /^\s*\$\$/;
const LIST_OR_QUOTE = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>)/;

export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let inMath = false;
  const flush = () => {
    if (current.length === 0) return;
    blocks.push(current.join("\n"));
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMath && FENCE.test(line)) inFence = !inFence;
    else if (!inFence && DISPLAY_MATH.test(line)) {
      // A formula opened and closed on one line is not a span
      const rest = line.replace(DISPLAY_MATH, "");
      if (!rest.includes("$$")) inMath = !inMath;
    }
    const blank = line.trim() === "";
    if (blank && !inFence && !inMath) {
      current.push(line);
      // The boundary is after this blank line — unless what follows carries on
      // a list or a quotation that what came before began
      const next = lines[i + 1];
      const first = current.find((l) => l.trim() !== "");
      const continues = next !== undefined && first !== undefined && LIST_OR_QUOTE.test(next) && LIST_OR_QUOTE.test(first);
      if (!continues && next !== undefined && next.trim() !== "") flush();
      continue;
    }
    current.push(line);
  }
  flush();
  // split("\n") drops nothing; join("\n") of the pieces gives the text back
  return blocks.map((b, k) => (k < blocks.length - 1 ? b + "\n" : b));
}
