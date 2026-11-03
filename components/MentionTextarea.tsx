"use client";
import { useLayoutEffect, useRef } from "react";
import { GrowingTextarea } from "./GrowingTextarea";

// A question box whose @mentions are marked where they stand in the text.
//
// A textarea cannot style part of its text, so the marks are drawn on a layer
// behind it that holds the same text, invisibly, laid out exactly as the box
// lays it out — the box's own font, padding and wrapping are copied onto the
// layer, and its scroll followed. Only the marks show through. The box still
// draws the text itself, so typing, selection and an input method's
// composition all behave as in any other box.

const MIRRORED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing", "lineHeight", "wordSpacing",
  "textTransform", "textIndent", "tabSize", "whiteSpace", "overflowWrap", "wordBreak", "boxSizing",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string;
  // Where the mentions stand in the text
  ranges: { start: number; end: number }[];
  markClassName?: string;
};

export function MentionTextarea({ value, ranges, markClassName, onScroll, style, ...props }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // The layer takes the box's measure after every render, and whenever the
  // box itself changes size (the panel dragged wider, the window resized)
  useLayoutEffect(() => {
    const box = wrapRef.current?.querySelector("textarea");
    const layer = layerRef.current;
    if (!box || !layer) return;
    const follow = () => {
      const computed = getComputedStyle(box);
      for (const prop of MIRRORED) layer.style[prop] = computed[prop];
      layer.style.borderStyle = "solid";
      layer.style.borderColor = "transparent";
      // The box's text wraps inside its client width: no scrollbar on the layer
      const borders = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
      layer.style.width = `${box.clientWidth + borders}px`;
      layer.style.height = `${box.offsetHeight}px`;
      layer.style.top = `${box.offsetTop}px`;
      layer.style.left = `${box.offsetLeft}px`;
      layer.scrollTop = box.scrollTop;
    };
    follow();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(box);
    return () => observer?.disconnect();
  });

  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start < at) continue;
    parts.push(value.slice(at, range.start));
    parts.push(<span key={range.start} className={markClassName} data-mention="">{value.slice(range.start, range.end)}</span>);
    at = range.end;
  }
  parts.push(value.slice(at));

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div
        ref={layerRef}
        aria-hidden="true"
        style={{ position: "absolute", overflow: "hidden", pointerEvents: "none", color: "transparent", margin: 0 }}
      >
        {parts}
        {/* A last empty line still takes its height, as it does in the box */}
        {"​"}
      </div>
      <GrowingTextarea
        value={value}
        style={{ ...style, position: "relative", background: "transparent" }}
        onScroll={(event) => {
          if (layerRef.current) layerRef.current.scrollTop = event.currentTarget.scrollTop;
          onScroll?.(event);
        }}
        {...props}
      />
    </div>
  );
}
