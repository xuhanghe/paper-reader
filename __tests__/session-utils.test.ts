import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeLabel } from "../lib/session-utils.js";

describe("makeLabel — image type", () => {
  test('always returns "Figure region" regardless of text', () => {
    assert.equal(makeLabel("some text here", "image"), "Figure region");
    assert.equal(makeLabel("", "image"), "Figure region");
  });
});

describe("makeLabel — text type", () => {
  test("returns the full string when 6 words or fewer", () => {
    assert.equal(makeLabel("gradient descent", "text"), "gradient descent");
    assert.equal(makeLabel("one two three four five six", "text"), "one two three four five six");
  });

  test("truncates to 6 words and appends ellipsis for longer text", () => {
    const result = makeLabel("one two three four five six seven eight", "text");
    assert.ok(result.endsWith("…"), `expected ellipsis, got: ${result}`);
    const wordCount = result.replace("…", "").trim().split(/\s+/).length;
    assert.equal(wordCount, 6);
  });

  test("trims leading and trailing whitespace before processing", () => {
    assert.equal(makeLabel("  hello world  ", "text"), "hello world");
  });

  test("handles a single word", () => {
    assert.equal(makeLabel("eigenvalue", "text"), "eigenvalue");
  });
});
