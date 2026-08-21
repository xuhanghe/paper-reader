import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseInkRun } from "../lib/ink-bands.js";

// Rows in the search window. A line of text is an inked run; the window holds
// two or three of them, because it reaches a band height above the box and half
// a height below.
//
// The bug this guards: a mark landing on the line below the passage it belongs
// to. Under a wash that reads as a slightly misaligned highlight; under a thin
// underline it reads as the mark being attached to the wrong sentence.

const LINE_ABOVE = { first: 0, last: 9 };
const THIS_LINE = { first: 20, last: 29 };
const LINE_BELOW = { first: 40, last: 49 };
const runs = [LINE_ABOVE, THIS_LINE, LINE_BELOW];

describe("choosing the line a band belongs to", () => {
  test("a box sitting squarely on its line takes that line", () => {
    assert.deepEqual(chooseInkRun(runs, 20, 30), THIS_LINE);
  });

  test("a box sitting low still takes the line it overlaps, not the nearer one", () => {
    // pdf.js places the box with fallback metrics, so it sits below the glyphs.
    // Its centre (30) is nearer the line below's centre (45) than its own (25),
    // and nearest-centre alone therefore moved the mark down a line.
    assert.deepEqual(chooseInkRun(runs, 25, 35), THIS_LINE);
  });

  test("a box sitting high does the same in the other direction", () => {
    assert.deepEqual(chooseInkRun(runs, 15, 25), THIS_LINE);
  });

  test("the run it shares most with wins when it straddles two", () => {
    assert.deepEqual(chooseInkRun(runs, 27, 47), LINE_BELOW);
  });

  test("a box on blank paper falls back to the nearest line", () => {
    // Nothing overlaps, but the glyphs are half a line away — the case the
    // snapping exists for
    assert.deepEqual(chooseInkRun(runs, 32, 38), THIS_LINE);
  });

  test("but not to a line too far to be its own", () => {
    // Better to leave the band where the text layer put it than to move it
    // onto a line it may have nothing to do with
    assert.equal(chooseInkRun(runs, 100, 108), null);
  });

  test("no ink at all is no answer", () => {
    assert.equal(chooseInkRun([], 20, 30), null);
  });

  test("one line in the window is that line, if it is close", () => {
    assert.deepEqual(chooseInkRun([THIS_LINE], 22, 32), THIS_LINE);
  });
});
