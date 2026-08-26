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

// Fresh browser selections are measured from PDF.js's original logical span
// coordinates (display-time calibration is deliberately removed first). For
// those boxes there is no "always drifts down" prior to apply: the nearest ink
// centre is the selected line. Keeping this separate from chooseInkRun
// preserves the legacy fallback for an uncalibrated/missing-position record.
export function nearestInkRun(runs: InkRun[], top: number, bottom: number): InkRun | null {
  if (runs.length === 0) return null;
  const centre = (top + bottom) / 2;
  const centreOf = (run: InkRun) => (run.first + run.last + 1) / 2;
  const nearest = runs.reduce((a, b) =>
    Math.abs(centreOf(b) - centre) < Math.abs(centreOf(a) - centre) ? b : a
  );
  // A logical PDF.js box can sit roughly two-thirds of a line above its glyphs
  // when the embedded font's ascent is substituted. Let the nearest run repair
  // that within-line error, but still reject anything a full line away so a
  // neighbouring row can never be serialized into the PDF annotation.
  const reach = Math.max(bottom - top, nearest.last + 1 - nearest.first) * 0.75;
  return Math.abs(centreOf(nearest) - centre) <= reach ? nearest : null;
}

// A measured mark-line paired with the stored line it stands for. Stored
// geometry is per line already (selection rects come one per line), so the
// nearest stored line within `reach` of the measured centre is the one this
// line's band should take. Nothing nearby means the stored record does not
// cover this line — the caller falls back to reading the ink.
export type Box = { left: number; top: number; width: number; height: number };

// Convert viewport geometry into fractions of the PDF page. Persistent bands
// are stored/rendered in this coordinate system so CSS-first zoom can resize
// the page and its annotations as one object; no scroll-container pixel
// position has to race PDF.js's delayed redraw.
export function relativeToPage(rect: Box, page: Box): Box {
  if (page.width <= 0 || page.height <= 0) return { ...rect };
  return {
    left: (rect.left - page.left) / page.width,
    top: (rect.top - page.top) / page.height,
    width: rect.width / page.width,
    height: rect.height / page.height,
  };
}

// The browser returns one rectangle per selected text fragment. PDF.js also
// puts a page-sized structural node in the range, so discard implausibly tall
// boxes and merge the real fragments into one ribbon per line.
//
// Keep the founding centre as the line identity: growing a band's bounds must
// not make the next physical line look close enough to join it.
export function mergeIntoLines(rects: Box[]): Box[] {
  if (rects.length === 0) return [];

  const heights = rects.map((r) => r.height).sort((a, b) => a - b);
  // Use the lower middle for an even-sized sample: one real text rect plus
  // PDF.js's page-sized endOfContent rect must not let the structural outlier
  // define the threshold.
  const median = heights[Math.floor((heights.length - 1) / 2)];
  const lines = rects
    .filter((r) => r.height <= median * 2.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const bands: (Box & { centre: number; lineHeight: number })[] = [];
  for (const r of lines) {
    const centre = r.top + r.height / 2;
    const band = bands[bands.length - 1];
    if (!band || Math.abs(centre - band.centre) > Math.min(r.height, band.lineHeight) * 0.5) {
      bands.push({ ...r, centre, lineHeight: r.height });
      continue;
    }
    const left = Math.min(band.left, r.left);
    const right = Math.max(band.left + band.width, r.left + r.width);
    const top = Math.min(band.top, r.top);
    const bottom = Math.max(band.top + band.height, r.top + r.height);
    band.left = left;
    band.top = top;
    band.width = right - left;
    band.height = bottom - top;
  }
  return bands.map(({ left, top, width, height }) => ({ left, top, width, height }));
}

export function nearestStoredLine(stored: Box[], centre: number, reach: number): Box | null {
  let best: Box | null = null;
  for (const line of stored) {
    const d = Math.abs(line.top + line.height / 2 - centre);
    if (d <= reach && (!best || d < Math.abs(best.top + best.height / 2 - centre))) best = line;
  }
  return best;
}
