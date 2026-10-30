"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type ResizeHandleProps = {
  onDrag: (dx: number) => void;
  onStart?: (handle: HTMLElement) => void;
  onEnd?: () => void;
};

export function ResizeHandle({ onDrag, onStart, onEnd }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      aria-hidden="true"
      onMouseDown={(event) => {
        event.preventDefault();
        onStart?.(event.currentTarget);
        setDragging(true);
        // Over the whole page while dragging, so the cursor stays and nothing
        // under the pointer hovers or selects. On the page itself, not beside
        // the handle: the panel a drag moves is found as the handle's neighbour.
        const veil = document.createElement("div");
        veil.className = "fixed inset-0 z-50 cursor-col-resize";
        document.body.appendChild(veil);
        let lastX = event.clientX;
        const move = (nextEvent: MouseEvent) => {
          onDrag(nextEvent.clientX - lastX);
          lastX = nextEvent.clientX;
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          veil.remove();
          setDragging(false);
          onEnd?.();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      className="pr-resize"
      data-dragging={dragging || undefined}
    >
      <div />
    </div>
  );
}

// What a collapsed panel leaves behind: a narrow labelled strip you click to
// bring it back. Shared so every collapsible panel in the app — the Zotero
// library, the conversation, the notebook, the Workspace's project tree and its
// agent — collapses to the same thing rather than to lookalikes.
export function CollapsedRail({
  label,
  side,
  onExpand,
  title,
  count,
}: {
  label: string;
  /** Which edge the panel lives on, so the border faces the content */
  side: "left" | "right";
  onExpand: () => void;
  title?: string;
  /** How much is waiting inside, shown under the label */
  count?: number;
}) {
  return (
    <button type="button" onClick={onExpand} className="pr-rail" data-side={side} title={title ?? `Show ${label.toLowerCase()}`}>
      <span className="pr-rail-head" aria-hidden="true">
        {/* Points the way the panel will open */}
        <svg viewBox="0 0 16 16">
          <path d={side === "left" ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8l4.5 4.5"} />
        </svg>
      </span>
      <span className="pr-rail-label">{label}</span>
      {!!count && <span className="pr-rail-count">{count}</span>}
    </button>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// A folded panel's rail (.pr-rail, 2.25rem)
const RAIL = 36;
// Pulled this far out from its rail (or from where it folded) a panel opens;
// just pulled open, it folds again this far back from the furthest the hand
// has gone, until that is past halfway
const REOPEN_SNAP = 28;

type PanelWidthOptions = {
  collapsible?: boolean;
};

type Drag = {
  handle: HTMLElement;
  // The width the hand puts the edge at, and the widest the edge can reach
  raw: number;
  high: number;
  open: boolean;
  // The furthest out the hand has gone since the panel was last open, and
  // where it opens the panel again once folded
  peak: number;
  openAt: number;
  width: number;
};

/**
 * A side panel's width, dragged by a ResizeHandle beside it. The edge stays
 * under the hand, measured from where the panel really is — its rail, when
 * folded — and the drag writes the width straight onto the panel, so React
 * hears of it only when the panel folds or opens and when the hand lets go.
 * Past its minimum the panel waits, and folds once the hand is more than
 * halfway from there to its rail; pulled back out it opens at its minimum,
 * and the edge goes on with the hand once the hand reaches it.
 */
export function usePanelWidth(
  initial: number,
  min: number,
  max: number,
  direction: 1 | -1,
  isOpen: boolean,
  setOpen: (open: boolean) => void,
  options: PanelWidthOptions = {},
) {
  const { collapsible = true } = options;
  const [width, setWidth] = useState(initial);
  const widthRef = useRef(initial);
  const openRef = useRef(isOpen);
  const drag = useRef<Drag | null>(null);
  // A panel folded by the hand goes back to the width it had before the drag,
  // ready for its next opening — once React has hidden it, not before: written
  // at the fold, it showed at that width for a frame
  const restoreOnFold = useRef<{ el: HTMLElement; width: number } | null>(null);

  useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  useLayoutEffect(() => {
    const pending = restoreOnFold.current;
    if (isOpen || !pending) return;
    restoreOnFold.current = null;
    pending.el.style.width = `${pending.width}px`;
  }, [isOpen]);

  // Halfway between the panel at its narrowest and its rail
  const halfway = (min + RAIL) / 2;

  // The handle's neighbour on the panel's side: the panel, or its rail
  const panelBy = useCallback((handle: HTMLElement) =>
    (direction === 1 ? handle.previousElementSibling : handle.nextElementSibling) as HTMLElement | null, [direction]);

  const onStart = useCallback((handle: HTMLElement) => {
    const el = panelBy(handle);
    if (!el?.parentElement) return;
    const shown = el.getBoundingClientRect().width;
    // It grows only as far as the pane taking up the slack can give before
    // its own minimum; past that the edge would fall behind the hand
    let room = 0;
    for (const pane of Array.from(el.parentElement.children)) {
      const style = getComputedStyle(pane);
      if (pane !== el && parseFloat(style.flexGrow) > 0) room += pane.getBoundingClientRect().width - (parseFloat(style.minWidth) || 0);
    }
    drag.current = {
      handle,
      raw: shown,
      high: Math.max(min, Math.min(max, shown + Math.max(0, room))),
      open: openRef.current,
      peak: shown,
      openAt: shown + REOPEN_SNAP,
      width: widthRef.current,
    };
  }, [max, min, panelBy]);

  const onDrag = useCallback((dx: number) => {
    const d = drag.current;
    if (!d) return;
    d.raw += direction * dx;
    if (d.open) d.peak = Math.max(d.peak, d.raw);
    // Pulled open just past its rail, the hand is far short of halfway; the
    // panel folds again only once the hand comes back some way, or it would
    // fold the moment it opened
    if (collapsible && d.open && d.raw < Math.min(halfway, d.peak - REOPEN_SNAP)) {
      const el = panelBy(d.handle);
      if (el) restoreOnFold.current = { el, width: widthRef.current };
      d.open = false;
      d.openAt = d.raw + REOPEN_SNAP;
      setOpen(false);
      return;
    }
    if (!d.open) {
      if (!collapsible || d.raw <= d.openAt) return;
      d.open = true;
      d.peak = d.raw;
      restoreOnFold.current = null;
      d.width = clamp(d.raw, min, d.high);
      widthRef.current = d.width;
      setWidth(d.width);
      setOpen(true);
      return;
    }
    d.width = clamp(d.raw, min, d.high);
    const el = panelBy(d.handle);
    // Until React has put the panel back in place of its rail
    if (el && !el.classList.contains("pr-rail")) el.style.width = `${d.width}px`;
  }, [collapsible, direction, halfway, min, panelBy, setOpen]);

  const onEnd = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d?.open || d.width === widthRef.current) return;
    widthRef.current = d.width;
    setWidth(d.width);
  }, []);

  return [width, onDrag, onStart, onEnd] as const;
}
