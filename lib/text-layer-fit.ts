// Fitting each text-layer span to the width pdf.js meant it to have.
//
// pdf.js lays a span over each run of glyphs and stretches it to the run's
// printed width with `transform: scaleX(k)`, where k is the printed width
// divided by the width it *measured* for the span's text — on a canvas, in the
// font family it wrote into the span's inline style. That only comes out right
// when the browser then renders the span in that same font. Anything that
// makes the DOM disagree with the canvas — an extension or user stylesheet
// swapping the page's fonts, a profile-level font preference the canvas does
// not follow — leaves every span the wrong width, and the error is worst at
// the far end of a line: a word near the end of a 10%-narrow span sits a
// whole word to the left of its print, so selecting or underlining it marks
// the neighbour instead.
//
// The cure is to measure the way pdf.js measured (same text, same inline
// family, same size) and compare with what the DOM actually rendered. The
// ratio is exactly the correction the scale needs. A span whose DOM agrees
// with the canvas measures a ratio of 1 and is left alone, which is every
// span on a machine where nothing interferes.

const MATCH_SCALE_X = /^scaleX\(([\d.eE+-]+)\)$/;

// The horizontal scale pdf.js applied, when the transform is nothing but
// that. Rotated runs and browsers that add a minimum-font-size scale are
// left to pdf.js — the fit would have to reason about the whole transform.
export function parseScaleX(transform: string): number | null {
  const match = MATCH_SCALE_X.exec(transform.trim());
  if (!match) return null;
  const k = Number(match[1]);
  return Number.isFinite(k) && k > 0 ? k : null;
}

// How far the DOM's rendering of a span departs from pdf.js's measurement of
// it: `measured` is the canvas width of the text in the span's inline font,
// `rendered` the width the DOM laid it out at before the transform. Anything
// within half a percent is rounding, not a font mismatch.
export const FIT_TOLERANCE = 0.005;

export function fitRatio(measured: number, rendered: number): number | null {
  if (!(measured > 0) || !(rendered > 0)) return null;
  const ratio = measured / rendered;
  return Math.abs(ratio - 1) < FIT_TOLERANCE ? null : ratio;
}

// The transform that puts the span at the width pdf.js intended, or null when
// it already is (or cannot be fitted).
export function fittedTransform(transform: string, measured: number, rendered: number): string | null {
  const k = parseScaleX(transform);
  if (k === null) return null;
  const ratio = fitRatio(measured, rendered);
  if (ratio === null) return null;
  return `scaleX(${k * ratio})`;
}
