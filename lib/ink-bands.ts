// Which line of text a band belongs to.
//
// Highlights are drawn onto the page canvas rather than onto pdf.js's text
// layer, because the two do not agree about where the text is: pdf.js positions
// its invisible spans with the browser's fallback font metrics while the canvas
// is drawn with the PDF's embedded fonts. The rendered pixels are the only
// source of truth, so a band is snapped to the ink it covers — and this is the
// part that decides which ink.

export type InkRun = { first: number; last: number };

// The fact everything here leans on: when the text layer is wrong, it is wrong
// DOWNWARD. Fallback fonts carry taller ascents, so pdf.js's boxes slide below
// the glyphs they stand for — which is why the search window reaches a whole
// band height above the box and only half below. It follows that of the lines
// a box touches, the TOPMOST is the one it belongs to.
//
// Choosing by amount of overlap got exactly the pathological boxes wrong: a box
// half a line low covers the next line's ink more than its own, so the biggest
// overlap — like the nearest centre before it — moved the mark down a line.
//
// A run has to be met meaningfully, not grazed: a box's bottom padding
// routinely dips into the ascenders of the line below, and that contact must
// not count as touching.
const MEANINGFUL_OVERLAP = 0.15;

export function chooseInkRun(runs: InkRun[], top: number, bottom: number): InkRun | null {
  if (runs.length === 0) return null;

  const height = Math.max(1, bottom - top);
  const touched = runs.filter((run) => {
    const overlap = Math.min(bottom, run.last + 1) - Math.max(top, run.first);
    const runHeight = run.last + 1 - run.first;
    return overlap >= Math.min(runHeight, height) * MEANINGFUL_OVERLAP;
  });
  if (touched.length > 0) {
    return touched.reduce((a, b) => (b.first < a.first ? b : a));
  }

  // The box floats in blank space, glyphs half a line away — the very case the
  // snapping exists for. Take the nearest line, but only within a line height;
  // beyond that the text layer's own geometry is the safer answer.
  const centre = (top + bottom) / 2;
  const centreOf = (run: InkRun) => (run.first + run.last + 1) / 2;
  const nearest = runs.reduce((a, b) =>
    Math.abs(centreOf(b) - centre) < Math.abs(centreOf(a) - centre) ? b : a
  );
  const reach = Math.max(height, nearest.last + 1 - nearest.first);
  return Math.abs(centreOf(nearest) - centre) <= reach ? nearest : null;
}

// A measured mark-line paired with the stored line it stands for. Stored
// geometry is per line already (selection rects come one per line), so the
// nearest stored line within `reach` of the measured centre is the one this
// line's band should take. Nothing nearby means the stored record does not
// cover this line — the caller falls back to reading the ink.
export type Box = { left: number; top: number; width: number; height: number };

export function nearestStoredLine(stored: Box[], centre: number, reach: number): Box | null {
  let best: Box | null = null;
  for (const line of stored) {
    const d = Math.abs(line.top + line.height / 2 - centre);
    if (d <= reach && (!best || d < Math.abs(best.top + best.height / 2 - centre))) best = line;
  }
  return best;
}
