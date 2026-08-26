import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// True when Enter means "submit this".
//
// While an IME is composing — typing Chinese, Japanese or Korean, and equally
// typing *English* with a Chinese IME active — Enter means "accept what is in
// the IME buffer", not "send". Submitting on that swallows the keystroke the
// user meant for the IME and sends half-typed text.
//
// `isComposing` alone does not catch this. Browsers disagree about the keydown
// that *ends* a composition: some report isComposing: false on it, and some
// deliver it after compositionend has already fired. So composition is tracked
// from the events themselves, which are the authority, and the flag is held
// briefly past compositionend to cover the commit keystroke arriving late.

const COMMIT_GRACE_MS = 80;

let composing = false;
let endedAt = 0;
let tracking = false;

// Attached on first use rather than at import: this module is evaluated during
// server rendering too, where there is no window to listen on.
function trackComposition() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  // Capture phase, on the window: one listener covers every input in the app,
  // so no field can forget to opt in.
  window.addEventListener("compositionstart", () => { composing = true; }, true);
  window.addEventListener("compositionupdate", () => { composing = true; }, true);
  window.addEventListener("compositionend", () => {
    composing = false;
    endedAt = Date.now();
  }, true);
}

export function isSubmitKey(e: ReactKeyboardEvent<HTMLElement>): boolean {
  trackComposition();
  if (e.key !== "Enter" || e.shiftKey) return false;

  const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
  // 229 is the legacy "this keystroke belongs to the IME" code, still the only
  // signal some browser/IME pairs give
  if (native.isComposing === true || native.keyCode === 229) return false;
  if (composing) return false;
  if (Date.now() - endedAt < COMMIT_GRACE_MS) return false;
  return true;
}

type HighlightDeleteKeyEvent = {
  key: string;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

const TEXT_EDITING_TARGETS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

// A selected PDF highlight can be removed with the physical Delete key or the
// key labelled "delete" on a Mac keyboard, which browsers report as Backspace.
// Modifier chords belong to the browser/OS and are deliberately left alone.
export function isHighlightDeleteKey(e: HighlightDeleteKeyEvent): boolean {
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  return e.key === "Delete" || e.key === "Backspace";
}

// Duck-type `closest` instead of using `instanceof Element`: an HTML snapshot
// lives in an iframe, whose elements belong to a different browser realm.
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  return typeof candidate?.closest === "function" && Boolean(candidate.closest(TEXT_EDITING_TARGETS));
}

// Test seam: composition state is module-level because the listeners are.
export function __resetImeStateForTests() {
  composing = false;
  endedAt = 0;
  tracking = false;
}
