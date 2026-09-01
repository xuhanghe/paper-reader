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
        className="w-[5px] -mx-[2px] z-10 shrink-0 cursor-col-resize group/handle flex justify-center"
      >
        <div
          className="w-[1.5px] h-full transition-all group-hover/handle:w-[3px]"
          style={{ background: dragging ? "var(--accent)" : "var(--border-light)" }}
          onMouseEnter={(event) => {
            if (!dragging) event.currentTarget.style.background = "rgba(232,120,76,0.55)";
          }}
          onMouseLeave={(event) => {
            if (!dragging) event.currentTarget.style.background = "var(--border-light)";
          }}
        />
      </div>
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}

// What a collapsed panel leaves behind: a narrow labelled strip you click to
// bring it back. Shared so every collapsible panel in the app — the Zotero
// library, the Workspace's project tree and its agent — collapses to the same
// thing rather than to three lookalikes.
export function CollapsedRail({
  label,
  side,
  onExpand,
  title,
}: {
  label: string;
  /** Which edge the panel lives on, so the border faces the content */
  side: "left" | "right";
  onExpand: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onExpand}
      className="flex flex-col items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(230,237,243,0.05)]"
      style={{
        width: "2.25rem",
        [side === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--border)",
        background: "var(--surface)",
      }}
      title={title ?? `Show ${label.toLowerCase()}`}
    >
      <span
        className="flex items-center justify-center h-9 w-full shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span className="rotate-90 text-xs" style={{ color: "var(--ink-faint)" }}>≡</span>
      </span>
      <span
        className="mt-3 text-[10px] uppercase tracking-widest select-none"
        style={{ color: "var(--ink-faint)", writingMode: "vertical-rl" }}
      >
        {label}
      </span>
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
