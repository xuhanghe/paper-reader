import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseInkRun, mergeIntoLines, nearestInkRun, nearestStoredLine, relativeToPage } from "../lib/ink-bands.js";

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

describe("choosing ink for a calibrated fresh selection", () => {
  test("uses the nearest line once calibration has removed the directional drift", () => {
    assert.deepEqual(nearestInkRun(runs, 23, 34), THIS_LINE);
  });

  test("does not serialize a neighbouring line into Zotero", () => {
    // A calibrated selection box can retain normal descender padding toward
    // the next line. Its centre still identifies its own ink unambiguously.
    assert.deepEqual(nearestInkRun([THIS_LINE, LINE_BELOW], 24, 36), THIS_LINE);
  });

  test("rejects ink that is too far away to belong to the selection", () => {
    assert.equal(nearestInkRun([LINE_BELOW], 0, 8), null);
  });

  test("does not jump a full line to a neighbouring row", () => {
    // This is the measured xPU failure: the selected words were right, but a
    // permissive nearest-run search froze the preceding line into Zotero.
    assert.equal(nearestInkRun([{ first: 10, last: 19 }], 20, 30), null);
  });

  test("repairs a logical font box sitting two-thirds of a line above its ink", () => {
    // Measured on the xPU microbenchmark paragraph: PDF.js preserved the right
    // line, but its substituted ascent put the box 6px above the actual glyphs.
    assert.deepEqual(nearestInkRun([THIS_LINE], 13, 23), THIS_LINE);
  });
});

// Stored geometry pairing: a record that knows where it sits provides one box
// per line; each measured mark-line takes the nearest stored line. Nothing
// nearby means the record does not cover this line, and the caller reads the
// ink instead.
describe("pairing a mark-line with its stored line", () => {
  const stored = [
    { left: 10, top: 20, width: 200, height: 10 },
    { left: 10, top: 40, width: 180, height: 10 },
  ];

  test("a line takes the stored line it sits on", () => {
    assert.deepEqual(nearestStoredLine(stored, 25, 15), stored[0]);
    assert.deepEqual(nearestStoredLine(stored, 45, 15), stored[1]);
  });

  test("a mark-line sitting low still pairs with its own stored line", () => {
    // The text-layer box drifts down; the stored line does not move
    assert.deepEqual(nearestStoredLine(stored, 33, 15), stored[0]);
  });

  test("a line the record does not cover pairs with nothing", () => {
    assert.equal(nearestStoredLine(stored, 90, 15), null);
    assert.equal(nearestStoredLine([], 25, 15), null);
  });
});

describe("page-relative persistent geometry", () => {
  test("is identical before and after the PDF page is zoomed", () => {
    const at96 = relativeToPage(
      { left: 320, top: 640, width: 120, height: 18 },
      { left: 80, top: 160, width: 960, height: 1242 }
    );
    const at197 = relativeToPage(
      { left: 572, top: 1120, width: 240, height: 36 },
      { left: 92, top: 160, width: 1920, height: 2484 }
    );
    assert.deepEqual(at197, at96);
  });

  test("keeps the rectangle relative to a scrolled page, not the viewer", () => {
    assert.deepEqual(
      relativeToPage(
        { left: 250, top: 500, width: 100, height: 20 },
        { left: 50, top: 100, width: 800, height: 1000 }
      ),
      { left: 0.25, top: 0.4, width: 0.125, height: 0.02 }
    );
  });

  test("keeps a live selection fixed to the same PDF line while zooming", () => {
    const at112 = relativeToPage(
      { left: 180, top: 360, width: 210, height: 14 },
      { left: 40, top: 80, width: 684, height: 887.04 }
    );
    const at224 = relativeToPage(
      { left: 320, top: 640, width: 420, height: 28 },
      { left: 40, top: 80, width: 1368, height: 1774.08 }
    );
    assert.deepEqual(at224, at112);
  });
});

describe("merging selection fragments into line ribbons", () => {
  test("keeps the complete bounds when the later fragment extends left and down", () => {
    // The first fragment sorts first because it sits a fraction higher, even
    // though it is the right-hand fragment. Updating `left`/`top` before the
    // old right/bottom had been saved used to crop the resulting ribbon.
    assert.deepEqual(
      mergeIntoLines([
        { left: 100, top: 20, width: 40, height: 10 },
        { left: 60, top: 21, width: 30, height: 12 },
      ]),
      [{ left: 60, top: 20, width: 80, height: 13 }]
    );
  });

  test("keeps wrapped text as two lines", () => {
    assert.deepEqual(
      mergeIntoLines([
        { left: 300, top: 20, width: 120, height: 11 },
        { left: 60, top: 38, width: 35, height: 11 },
      ]),
      [
        { left: 300, top: 20, width: 120, height: 11 },
        { left: 60, top: 38, width: 35, height: 11 },
      ]
    );
  });

  test("drops PDF.js's page-sized structural selection rectangle", () => {
    assert.deepEqual(
      mergeIntoLines([
        { left: 20, top: 20, width: 80, height: 10 },
        { left: 20, top: 40, width: 50, height: 10 },
        { left: 0, top: 0, width: 600, height: 800 },
      ]).length,
      2
    );
  });

  test("drops the structural rectangle even for a one-line selection", () => {
    assert.deepEqual(
      mergeIntoLines([
        { left: 20, top: 20, width: 80, height: 10 },
        { left: 0, top: 0, width: 600, height: 800 },
      ]),
      [{ left: 20, top: 20, width: 80, height: 10 }]
    );
  });
});
