import type { KeyboardEvent } from "react";

// True when Enter means "submit this".
//
// While an IME is composing — typing Chinese, Japanese or Korean — Enter means
// "accept the candidate I'm looking at", and the browser still reports it as a
// keydown. Submitting on that swallows the keystroke the user meant for the IME
// and sends half-typed text, so composing Enter is ignored here.
export function isSubmitKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing;
}
