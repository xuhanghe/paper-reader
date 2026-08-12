import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findIgnoringWhitespace } from "../lib/highlight-dom.js";

// The text layer and the browser's selection disagree about whitespace, so a
// highlight has to be located without it. See lib/highlight-dom.ts.

describe("findIgnoringWhitespace — plain matches", () => {
  test("finds an exact substring", () => {
    assert.deepEqual(findIgnoringWhitespace("the quick brown fox", "brown"), { start: 10, end: 15 });
  });

  test("is case-insensitive", () => {
    assert.deepEqual(findIgnoringWhitespace("Gradient Descent", "gradient"), { start: 0, end: 8 });
  });

  test("returns null when absent", () => {
    assert.equal(findIgnoringWhitespace("the quick brown fox", "kernel"), null);
  });

  test("returns null for an all-whitespace query", () => {
    assert.equal(findIgnoringWhitespace("the quick brown fox", "  \n "), null);
  });
});

describe("findIgnoringWhitespace — whitespace disagreements", () => {
  test("matches when the selection has a break the layer does not (CJK case)", () => {
    // Chrome puts a newline between per-character spans; the DOM has none
    const found = findIgnoringWhitespace("学渣暮易Introduction", "暮易\nIntro");
    assert.deepEqual(found, { start: 2, end: 9 });
  });

  test("matches when the layer has whitespace the selection does not", () => {
    const found = findIgnoringWhitespace("top k kernel", "topk");
    assert.deepEqual(found, { start: 0, end: 5 }); // spans the interior space
  });

  test("matches across a line wrap in the query", () => {
    const found = findIgnoringWhitespace("the quick brown fox", "quick\n  brown");
    assert.deepEqual(found, { start: 4, end: 15 });
  });

  test("ignores leading and trailing whitespace in the query", () => {
    assert.deepEqual(findIgnoringWhitespace("the quick brown fox", "  brown  "), { start: 10, end: 15 });
  });
});

describe("findIgnoringWhitespace — index integrity", () => {
  test("the returned range starts and ends on non-whitespace", () => {
    const full = "a  bc   def";
    const found = findIgnoringWhitespace(full, "bc def")!;
    assert.ok(found);
    assert.equal(full[found.start], "b");
    assert.equal(full[found.end - 1], "f");
  });

  test("a character that lowercases to two units keeps indices aligned", () => {
    // "İ".toLowerCase() is two code units — folding it would shift every
    // later index, so it is left as-is
    const full = "aİb kernel";
    const found = findIgnoringWhitespace(full, "kernel")!;
    assert.ok(found);
    assert.equal(full.slice(found.start, found.end), "kernel");
  });
});
