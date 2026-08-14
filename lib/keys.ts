import type { KeyboardEvent } from "react";

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

export function isSubmitKey(e: KeyboardEvent<HTMLElement>): boolean {
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

// Test seam: composition state is module-level because the listeners are.
export function __resetImeStateForTests() {
  composing = false;
  endedAt = 0;
  tracking = false;
}
