import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { verticalNudge, horizontalNudge } from "../lib/text-layer-calibration.js";

// Measured on the xPU paper: span boxes ride off their glyphs per-span — one
// span 6.4px low, another 4.1px high, on the same page — so sweeping a printed
// line selects its neighbour and copy returns the wrong sentence. Each span is
// judged alone, against the ink.

describe("verticalNudge", () => {
  // box rows 0..13, its own ink centred ~0, next line at +10..+22
  const runs = [
    { first: -6, last: 5 },
    { first: 10, last: 21 },
  ];

  test("a span riding below its glyphs measures a negative nudge", () => {
    const d = verticalNudge(runs, 0, 13, 7);
    assert.ok(d !== null && d < -5 && d > -8);
  });

  test("an aligned span measures ~0", () => {
    assert.ok(Math.abs(verticalNudge([{ first: 1, last: 12 }], 0, 13, 7)!) < 1);
  });

  test("the cap keeps a neighbouring line from posing as the correction", () => {
    // only the next line's ink is in reach — nudging onto it would move the
    // span a full line, which is not a metric error
    assert.equal(verticalNudge([{ first: 14, last: 25 }], 0, 13, 7), null);
  });

  test("no ink is no verdict", () => {
    assert.equal(verticalNudge([], 0, 13, 7), null);
  });
});

describe("horizontalNudge", () => {
  test("a full-line span shifted sideways is pulled onto its ink", () => {
    assert.equal(horizontalNudge(100, 400, 92, 396, 14), -8);
  });

  test("an aligned span is left alone in effect", () => {
    assert.equal(horizontalNudge(100, 400, 100, 399, 14), 0);
  });

  test("ink much narrower than the box is someone else's line", () => {
    // e.g. the line below ends early — its extent must not drag this span
    assert.equal(horizontalNudge(100, 400, 100, 250, 14), null);
  });

  test("ink much wider than the box is shared with neighbours", () => {
    // a span that does not own its whole line measures its neighbours' glyphs
    // as part of the extent; that is not a correction
    assert.equal(horizontalNudge(100, 200, 60, 340, 14), null);
  });

  test("a shift beyond the cap is not a metric error", () => {
    assert.equal(horizontalNudge(100, 400, 60, 356, 14), null);
  });

  test("no measurable extent is no verdict", () => {
    assert.equal(horizontalNudge(100, 400, null, null, 14), null);
  });
});
