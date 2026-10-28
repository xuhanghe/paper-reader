"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ResizeHandleProps = {
  onDrag: (dx: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
};

export function ResizeHandle({ onDrag, onStart, onEnd }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <>
      <div
        aria-hidden="true"
        onMouseDown={(event) => {
          event.preventDefault();
          onStart?.();
          setDragging(true);
          let lastX = event.clientX;
          const move = (nextEvent: MouseEvent) => {
            onDrag(nextEvent.clientX - lastX);
            lastX = nextEvent.clientX;
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
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
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
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
const COLLAPSE_SNAP = 45;
const REOPEN_SNAP = 28;

type PanelWidthOptions = {
  collapsible?: boolean;
};

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
  const rawRef = useRef(initial);
  const widthRef = useRef(initial);
  const openRef = useRef(isOpen);

  useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  const collapseAt = min - COLLAPSE_SNAP;
  const reopenAt = collapseAt + REOPEN_SNAP;

  const onStart = useCallback(() => {
    rawRef.current = openRef.current ? widthRef.current : collapseAt;
  }, [collapseAt]);

  const onDrag = useCallback((dx: number) => {
    rawRef.current = clamp(rawRef.current + direction * dx, collapsible ? 0 : min, max);

    if (collapsible) {
      if (openRef.current) {
        if (rawRef.current < collapseAt) {
          setOpen(false);
          return;
        }
      } else {
        if (rawRef.current <= reopenAt) return;
        setOpen(true);
      }
    }

    const clamped = clamp(rawRef.current, min, max);
    widthRef.current = clamped;
    setWidth(clamped);
  }, [collapseAt, collapsible, direction, max, min, reopenAt, setOpen]);

  const onEnd = useCallback(() => {
    if (!collapsible || openRef.current) return;
    widthRef.current = initial;
    setWidth(initial);
  }, [collapsible, initial]);

  return [width, onDrag, onStart, onEnd] as const;
}
