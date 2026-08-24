// Deciding how far a text-layer span sits from the glyphs it stands for.
//
// Some PDFs' invisible text layers ride off the printed glyphs — old Type 1
// fonts positioned with metrics pdf.js has to guess. The browser hit-tests
// against the layer, so selection, copy and clicks all lie with it: sweeping
// the upper half of a printed line selects the line above. Measured on the
// xPU paper, the error is per-span, with different spans on one page off in
// different directions — so each span is corrected individually, vertically
// and horizontally, against the rendered ink. A span that measures aligned is
// left alone, which is every span of a metrically clean PDF.
//
// This file is the judgement; reading the pixels stays in the viewer.

import type { InkRun } from "./ink-bands";

// How far the nearest ink run sits from the span's box, vertically. Capped:
// beyond ~half a line the nearest run is likelier a neighbouring line than
// this span's own glyphs, and a wrong nudge is worse than none.
export function verticalNudge(runs: InkRun[], top: number, bottom: number, cap: number): number | null {
  const centre = (top + bottom) / 2;
  let best: number | null = null;
  for (const run of runs) {
    const d = (run.first + run.last + 1) / 2 - centre;
    if (Math.abs(d) <= cap && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

// Horizontal correction from the ink extent on the span's own line. Only
// trusted when the ink reads as this span's own text: about the same width as
// the box. A span that shares its line with others fails the width test —
// neighbouring glyphs run into the measured extent — and is left alone.
export function horizontalNudge(
  boxLeft: number,
  boxRight: number,
  inkLeft: number | null,
  inkRight: number | null,
  cap: number
): number | null {
  if (inkLeft === null || inkRight === null) return null;
  const boxWidth = boxRight - boxLeft;
  if (boxWidth < 8) return null;
  const inkWidth = inkRight - inkLeft;
  if (inkWidth < boxWidth * 0.7 || inkWidth > boxWidth * 1.3) return null;
  const dx = inkLeft - boxLeft;
  return Math.abs(dx) <= cap ? dx : null;
}
