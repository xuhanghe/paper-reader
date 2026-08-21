// Which line of text a band belongs to.
//
// Highlights are drawn onto the page canvas rather than onto pdf.js's text
// layer, because the two do not agree about where the text is: pdf.js positions
// its invisible spans with the browser's fallback font metrics while the canvas
// is drawn with the PDF's embedded fonts, so the boxes routinely sit a half-line
// off the glyphs. The rendered pixels are the only source of truth, so a band is
// snapped to the ink it covers — and this is the part that decides which ink.

export type InkRun = { first: number; last: number };

// The search window reaches a whole band height above the box and half a height
// below, so it almost always holds two or three lines of text. Choosing the run
// whose centre is nearest the box's centre is not enough on its own: a box that
// sits low — which is exactly the case this snapping exists to correct — is
// often nearer the centre of the line below than of its own, and the band then
// lands on the wrong line. Under a thin underline that reads as the mark being
// attached to the following sentence.
//
// Overlap decides it first. A run sharing no pixels with the box is not this
// line, whatever its centre says. Only when nothing overlaps at all does
// nearest-centre apply, and then only within a line height — beyond that the
// box is better trusted as it is than moved onto a line it may not belong to.
export function chooseInkRun(runs: InkRun[], top: number, bottom: number): InkRun | null {
  if (runs.length === 0) return null;

  let best: InkRun | null = null;
  let bestOverlap = 0;
  for (const run of runs) {
    const overlap = Math.min(bottom, run.last + 1) - Math.max(top, run.first);
    if (overlap > bestOverlap) {
      best = run;
      bestOverlap = overlap;
    }
  }
  if (best) return best;

  const centre = (top + bottom) / 2;
  const centreOf = (run: InkRun) => (run.first + run.last + 1) / 2;
  const nearest = runs.reduce((a, b) =>
    Math.abs(centreOf(b) - centre) < Math.abs(centreOf(a) - centre) ? b : a
  );
  // "Close enough" is a line height — the box's own height is the wrong ruler,
  // since a box that has drifted off the glyphs is often a thin one
  const reach = Math.max(bottom - top, nearest.last + 1 - nearest.first);
  return Math.abs(centreOf(nearest) - centre) <= reach ? nearest : null;
}
