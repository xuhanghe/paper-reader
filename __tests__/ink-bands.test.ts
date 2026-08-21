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

  test("a box sitting low still takes its own line, not the nearer one", () => {
    // pdf.js places the box with fallback metrics, so it sits below the glyphs.
    // Its centre (30) is nearer the line below's centre (45) than its own (25).
    assert.deepEqual(chooseInkRun(runs, 25, 35), THIS_LINE);
  });

  test("a box half a line low takes the line it came from, not the one it covers more", () => {
    // The regression this file exists for, round two: this box overlaps its own
    // line by 2 rows and the line below by 6. Biggest-overlap moved the mark
    // down a line — the topmost touched line is the right one, because when
    // the text layer errs, it errs downward.
    assert.deepEqual(chooseInkRun(runs, 28, 46), THIS_LINE);
  });

  test("bottom padding grazing the line below does not steal the mark", () => {
    // A correct box routinely dips a row into the next line's ascenders
    assert.deepEqual(chooseInkRun(runs, 19, 41), THIS_LINE);
  });

  test("a box sitting high does the same in the other direction", () => {
    assert.deepEqual(chooseInkRun(runs, 15, 25), THIS_LINE);
  });

  test("a box entirely on one line, touching no other, takes that line", () => {
    assert.deepEqual(chooseInkRun(runs, 40, 50), LINE_BELOW);
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
