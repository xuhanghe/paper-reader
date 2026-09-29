import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseTakeaways, isStale, mergeTakeaways, MAX_TAKEAWAYS } from "../lib/takeaways.js";

describe("parseTakeaways", () => {
  test("reads a plain array", () => {
    assert.deepEqual(parseTakeaways('["Padding breaks the stride", "Banks stop colliding"]'), [
      "Padding breaks the stride",
      "Banks stop colliding",
    ]);
  });

  test("digs the array out of a fenced, prefaced reply", () => {
    const reply = 'Here are the takeaways:\n\n```json\n["One thing", "Another thing"]\n```\n';
    assert.deepEqual(parseTakeaways(reply), ["One thing", "Another thing"]);
  });

  test("strips bullet markers the model adds inside the strings", () => {
    assert.deepEqual(parseTakeaways('["- One thing", "• Another"]'), ["One thing", "Another"]);
  });

  test("drops the trailing full stop, in either script", () => {
    assert.deepEqual(parseTakeaways('["It is bandwidth bound.", "共享内存有 32 个 bank。"]'), [
      "It is bandwidth bound",
      "共享内存有 32 个 bank",
    ]);
  });

  test("flattens a line broken across two", () => {
    assert.deepEqual(parseTakeaways('["one\\n  two"]'), ["one two"]);
  });

  test("keeps the list short enough to scan", () => {
    const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => `item ${i}`));
    assert.equal(parseTakeaways(many).length, MAX_TAKEAWAYS);
  });

  test("the same point twice is one point", () => {
    assert.deepEqual(parseTakeaways('["same", "same"]'), ["same"]);
  });

  test("nothing usable is nothing, not a crash", () => {
    for (const junk of ["", "I could not summarise that", "{}", "[", '["  "]', "[1, 2, 3]"]) {
      assert.deepEqual(parseTakeaways(junk), [], JSON.stringify(junk));
    }
  });
});

describe("isStale", () => {
  test("never summarised is stale", () => {
    assert.equal(isStale(undefined, 2), true);
  });

  test("a summary that covers the whole conversation is current", () => {
    assert.equal(isStale(4, 4), false);
  });

  test("a follow-up makes it stale again", () => {
    assert.equal(isStale(4, 6), true);
  });

  test("so does an edit that shortens the thread", () => {
    // Rewriting a question replaces everything after it
    assert.equal(isStale(6, 4), true);
  });
});

// The list is rewritten after every answer. A list the reader wrote in is
// theirs: the model may add to it, never touch what is there.
describe("mergeTakeaways", () => {
  test("a fresh summary replaces an untouched list", () => {
    assert.deepEqual(mergeTakeaways(["old"], ["new one", "new two"], false), ["new one", "new two"]);
  });

  test("an empty summary changes nothing", () => {
    assert.deepEqual(mergeTakeaways(["old"], [], false), ["old"]);
    assert.deepEqual(mergeTakeaways(["mine"], [], true), ["mine"]);
  });

  test("the reader's lines stay word for word; new findings are added after them", () => {
    assert.deepEqual(mergeTakeaways(["My note", "Another"], ["my note", "Something new"], true), ["My note", "Another", "Something new"]);
  });

  test("an edited list still stays short", () => {
    const mine = Array.from({ length: MAX_TAKEAWAYS }, (_, i) => `mine ${i}`);
    assert.deepEqual(mergeTakeaways(mine, ["more"], true), mine);
  });
});
