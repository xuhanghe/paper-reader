import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isSubmitKey, __resetImeStateForTests } from "../lib/keys.js";

// Typing English with a Chinese IME active still opens a composition: the
// letters sit in the IME buffer and Enter commits them. Submitting on that
// Enter sends a half-typed message and eats the keystroke the user meant.

let dom: JSDOM;

const key = (
  overrides: Partial<{ key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}
) =>
  ({
    key: overrides.key ?? "Enter",
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: {
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 13,
    },
  }) as unknown as ReactKeyboardEvent<HTMLElement>;

const fire = (type: string) =>
  dom.window.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true }));

beforeEach(() => {
  __resetImeStateForTests();
  dom = new JSDOM("<!doctype html><body></body>");
  (globalThis as Record<string, unknown>).window = dom.window;
});

describe("isSubmitKey — plain typing", () => {
  test("Enter submits", () => {
    assert.equal(isSubmitKey(key()), true);
  });

  test("other keys do not", () => {
    assert.equal(isSubmitKey(key({ key: "a" })), false);
    assert.equal(isSubmitKey(key({ key: "Escape" })), false);
  });

  test("Shift+Enter does not — it is for a line break, not for sending", () => {
    assert.equal(isSubmitKey(key({ shiftKey: true })), false);
  });
});

describe("isSubmitKey — an IME is composing", () => {
  test("the browser's own isComposing flag is honoured", () => {
    assert.equal(isSubmitKey(key({ isComposing: true })), false);
  });

  test("keyCode 229 is honoured, for browsers that report nothing else", () => {
    assert.equal(isSubmitKey(key({ keyCode: 229 })), false);
  });

  test("composing is believed over isComposing:false — the case that was broken", () => {
    // Typing English with a Chinese IME: compositionstart has fired, but the
    // committing keydown reports isComposing: false in several browsers
    isSubmitKey(key()); // installs the listeners
    fire("compositionstart");
    assert.equal(isSubmitKey(key({ isComposing: false })), false, "Enter here commits the IME buffer, it does not send");
  });

  test("compositionupdate alone is enough to count as composing", () => {
    isSubmitKey(key());
    fire("compositionupdate");
    assert.equal(isSubmitKey(key()), false);
  });
});

describe("isSubmitKey — the keystroke that ends a composition", () => {
  test("an Enter arriving right after compositionend still belongs to the IME", () => {
    // Some browsers deliver the committing keydown *after* compositionend
    isSubmitKey(key());
    fire("compositionstart");
    fire("compositionend");
    assert.equal(isSubmitKey(key()), false);
  });

  test("but the next Enter sends, so committing then sending still works", async () => {
    isSubmitKey(key());
    fire("compositionstart");
    fire("compositionend");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(isSubmitKey(key()), true);
  });
});
