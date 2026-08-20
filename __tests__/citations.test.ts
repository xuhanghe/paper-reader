import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCitation, turnMarker, citationLabel } from "../lib/citations.js";

// The model writes its references as markdown links in two private schemes.
// Everything else it links to is an ordinary link and has to stay one — a
// recommended textbook must not turn into a jump into the paper.

describe("parseCitation", () => {
  test("a paper citation carries the page to land on", () => {
    assert.deepEqual(parseCitation("paper:12"), { kind: "paper", page: 12 });
  });

  test("a page-less document cites its one page", () => {
    // HTML snapshots have no page numbers to give
    assert.deepEqual(parseCitation("paper"), { kind: "paper", page: 1 });
  });

  test("a conversation citation carries the turn it points back at", () => {
    assert.deepEqual(parseCitation("turn:7"), { kind: "turn", turn: 7 });
  });

  test("ordinary links are left alone", () => {
    for (const href of ["https://en.wikipedia.org/wiki/Softmax", "mailto:a@b.c", "#section", "/local"]) {
      assert.equal(parseCitation(href), null, href);
    }
  });

  test("a link that only looks like one is not one", () => {
    for (const href of ["paper:0", "turn:0", "paper:abc", "turns:3", "paperclip", "paper:12:3", ""]) {
      assert.equal(parseCitation(href), null, href);
    }
  });

  test("a missing href is not a citation", () => {
    assert.equal(parseCitation(undefined), null);
  });

  test("surrounding whitespace does not break one", () => {
    assert.deepEqual(parseCitation(" paper:3 "), { kind: "paper", page: 3 });
  });
});

describe("turnMarker", () => {
  test("numbers a message the way the model is told to cite it", () => {
    assert.equal(turnMarker(7), "[turn 7]");
    assert.deepEqual(parseCitation("turn:7"), { kind: "turn", turn: 7 });
  });
});

describe("citationLabel", () => {
  test("leaves ordinary prose as it is", () => {
    assert.equal(citationLabel("the kernel is bandwidth bound"), "the kernel is bandwidth bound");
  });

  test("closes the gaps PDF extraction leaves between CJK glyphs", () => {
    // A quote copied verbatim out of paper.md looks like this, and still
    // matches the page — only the label needs mending
    assert.equal(citationLabel("上 上 周 五 写 了 top k ke rn e l"), "上上周五写了 top k ke rn e l");
  });

  test("keeps the space between a CJK word and a latin one", () => {
    assert.equal(citationLabel("使用 CUDA 核函数"), "使用 CUDA 核函数");
  });

  test("flattens a quote broken across lines onto one", () => {
    assert.equal(citationLabel("bandwidth\n  bound   kernel"), "bandwidth bound kernel");
  });
});
