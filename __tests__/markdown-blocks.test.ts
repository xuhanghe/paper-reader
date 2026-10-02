import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownBlocks } from "../lib/markdown-blocks.js";

// A streaming answer re-parses only the block being written. The split must
// be lossless and must not cut through anything that reads as one.
describe("splitMarkdownBlocks", () => {
  const joinsBack = (md: string) => assert.equal(splitMarkdownBlocks(md).join(""), md);

  test("paragraphs split at blank lines, losslessly", () => {
    const md = "First paragraph.\n\nSecond one,\nstill second.\n\nThird.";
    assert.deepEqual(splitMarkdownBlocks(md), ["First paragraph.\n\n", "Second one,\nstill second.\n\n", "Third."]);
    joinsBack(md);
  });

  test("a fenced code block with blank lines inside stays one block", () => {
    const md = "Before.\n\n```py\na = 1\n\nb = 2\n```\n\nAfter.";
    const blocks = splitMarkdownBlocks(md);
    assert.equal(blocks.length, 3);
    assert.match(blocks[1], /a = 1\n\nb = 2/);
    joinsBack(md);
  });

  test("a display formula with blank lines inside stays one block", () => {
    const md = "Then:\n\n$$\nL = \\sum_i x_i\n\n+ \\lambda\n$$\n\nSo.";
    const blocks = splitMarkdownBlocks(md);
    assert.equal(blocks.length, 3);
    assert.match(blocks[1], /\$\$\nL = [\s\S]*\$\$/);
    joinsBack(md);
  });

  test("a one-line display formula is not an opening", () => {
    const md = "a\n\n$$ x = 1 $$\n\nb\n\nc";
    assert.equal(splitMarkdownBlocks(md).length, 4);
    joinsBack(md);
  });

  test("a loose list is one block, so it renders as one list", () => {
    const md = "- one\n\n- two\n\n- three\n\nNot a list.";
    const blocks = splitMarkdownBlocks(md);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /one[\s\S]*three/);
    joinsBack(md);
  });

  test("a quotation loosened by a blank line stays together", () => {
    const md = "> first\n\n> second\n\nAfter.";
    assert.equal(splitMarkdownBlocks(md).length, 2);
    joinsBack(md);
  });

  test("while streaming, earlier blocks keep their text as the tail grows", () => {
    const a = splitMarkdownBlocks("One.\n\nTwo.\n\nThr");
    const b = splitMarkdownBlocks("One.\n\nTwo.\n\nThree and more.\n\nFo");
    assert.deepEqual(a.slice(0, 2), b.slice(0, 2));
  });

  test("empty, and a single block", () => {
    assert.deepEqual(splitMarkdownBlocks(""), [""]);
    assert.deepEqual(splitMarkdownBlocks("just this"), ["just this"]);
  });
});
