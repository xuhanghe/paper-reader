"use client";
import { useRef, useLayoutEffect } from "react";

// A text box that grows with what is in it.
//
// Used for every box the reader types prose into — questions, notes, follow-ups
// — so none of them ever hides what was typed above the visible line.
//
// These were single-line <input>s, which cannot hold a newline at all and
// scroll horizontally once the text outruns the width — so a long question hid
// its own beginning. A textarea wraps, and this keeps its height matched to the
// content up to a ceiling, after which it scrolls rather than eating the panel.
const MAX_BOX_HEIGHT = 168;

// Where the browser can size a textarea to its content itself, let it.
//
// The JS way — reset the height to auto, read scrollHeight, write the new
// height — forces the whole document to be laid out twice per keystroke, and
// this document contains a rendered PDF page with its text layer. `field-sizing`
// does the same job in the engine, with no layout the app can see. Probed once;
// the class is always applied, since a browser without it simply ignores it.
let fieldSizing: boolean | null = null;
function browserSizesTextareas(): boolean {
  if (fieldSizing === null) {
    fieldSizing =
      typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
  }
  return fieldSizing;
}

export function GrowingTextarea({
  value,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Layout effect, not effect: resizing after paint shows one frame at the old
  // height, which reads as a flicker on every keystroke
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || browserSizesTextareas()) return;
    el.style.height = "auto";
    // scrollHeight excludes the border, and these are border-box, so the height
    // has to add it back or every box sits two pixels short and shows a
    // scrollbar it does not need
    const border = el.offsetHeight - el.clientHeight;
    const wanted = el.scrollHeight + border;
    el.style.height = `${Math.min(wanted, MAX_BOX_HEIGHT)}px`;
    el.style.overflowY = wanted > MAX_BOX_HEIGHT ? "auto" : "hidden";
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} className={`pr-autosize ${className ?? ""}`} {...props} />;
}
