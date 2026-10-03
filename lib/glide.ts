// How a jump to a passage travels. The view glides from where the reader is
// to where the passage sits, so the eye follows the motion and knows which
// way it went and roughly how far. A screen's worth takes under half a
// second; a longer jump grows only with the square root of its distance and
// caps, so even a jump across the paper is over inside a second.

export const GLIDE_MIN_MS = 220;
export const GLIDE_MAX_MS = 900;

/** Milliseconds a glide over `distancePx` takes; 0 when there is nothing to cover. */
export function glideDuration(distancePx: number): number {
  if (!(distancePx > 0.5)) return 0;
  return Math.round(Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + Math.sqrt(distancePx) * 9.5));
}

/**
 * How far along the way a glide is at `t` of its time, both 0..1: slow out
 * of the start, fast through the middle, slow into the landing.
 */
export function glideEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
