// Where a scroller goes to show a passage: the passage's lines centred
// vertically, and — only when the page is wider than the window and the
// passage is off its edge — centred horizontally too. A page that fits, or
// a passage already in view sideways, leaves the horizontal offset alone:
// a jump that also slid the page sideways for a passage already on screen
// would read as the view wandering.

export type Rect = { left: number; top: number; width: number; height: number };

export type RevealInput = {
  /** The passage's lines, in client coordinates */
  rects: Rect[];
  /** The scroller's box, in client coordinates */
  box: Rect;
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
};

export function revealOffsets({ rects, box, scrollTop, scrollLeft, clientWidth, clientHeight }: RevealInput): { top: number; left: number } {
  const first = rects[0];
  if (!first) return { top: scrollTop, left: scrollLeft };
  const top = scrollTop + (first.top - box.top) - clientHeight / 2;

  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const inView = left >= box.left && right <= box.left + clientWidth;
  if (inView) return { top, left: scrollLeft };
  // Centre the passage's full width; a passage wider than the window shows
  // its beginning
  const width = right - left;
  const wanted = scrollLeft + (left - box.left) - Math.max(0, (clientWidth - width) / 2);
  return { top, left: Math.max(0, wanted) };
}
