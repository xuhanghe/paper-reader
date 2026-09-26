import { useCallback, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

// A floating box the reader can move: press on any part of it that is not a
// control and drag. The offset is added to wherever the box would sit, and
// forgotten when the box is anchored somewhere new (a new selection, another
// highlight), since a position dragged for one anchor means nothing for the
// next.
export function useDraggable(anchorKey: string) {
  // The offset remembers which anchor it was dragged for; for any other it
  // reads as zero, which is the forgetting
  const [moved, setMoved] = useState({ key: anchorKey, x: 0, y: 0 });
  const offset = moved.key === anchorKey ? { x: moved.x, y: moved.y } : { x: 0, y: 0 };
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest("button, textarea, input, a, select, [contenteditable]")) return;
    // Keeps the page's text selection, which the box is about, from clearing
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (d) setMoved({ key: anchorKey, x: d.ox + ev.clientX - d.x, y: d.oy + ev.clientY - d.y });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("blur", up);
    };
    // Capture phase: the box stops mouse events from bubbling (to keep the
    // page's selection), and the window's turn in the bubbling phase never
    // came — the box could be picked up and never put down
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("blur", up);
  }, [anchorKey, offset.x, offset.y]);
  return { offset, onMouseDown };
}
