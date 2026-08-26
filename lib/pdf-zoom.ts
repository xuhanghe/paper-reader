// PDF.js accepts wheel deltas in pixels, lines, or pages depending on the
// browser and input device. Convert them to one unit before turning them into
// a scale target so a mouse wheel and a trackpad do not feel wildly different.
export function wheelDeltaPixels(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight);
  return deltaY;
}

export function wheelZoomTarget(
  baseScale: number,
  deltaPixels: number,
  sensitivity = 0.004,
  maxGestureFactor = 1.2
): number {
  if (!(baseScale > 0) || !Number.isFinite(deltaPixels)) return baseScale;
  const limit = Math.log(maxGestureFactor);
  const exponent = Math.max(-limit, Math.min(limit, -deltaPixels * sensitivity));
  return baseScale * Math.exp(exponent);
}

// Move toward the requested scale by only a small multiplicative step. Calling
// this once per animation frame gives PDF.js an even CSS-first progression and
// postpones its expensive high-resolution redraw until the gesture settles.
export function nextZoomFrameScale(
  currentScale: number,
  targetScale: number,
  maxFrameFactor = 1.06
): number {
  if (!(currentScale > 0) || !(targetScale > 0)) return currentScale;
  const limit = Math.log(maxFrameFactor);
  const distance = Math.log(targetScale / currentScale);
  return currentScale * Math.exp(Math.max(-limit, Math.min(limit, distance)));
}
