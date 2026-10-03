import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { revealOffsets } from "../lib/reveal-scroll.js";

// A viewer 800px wide and 600px tall at the top-left of the screen, scrolled
// 1000px down and showing the left column of a page twice its width
const viewer = { box: { left: 0, top: 0, width: 800, height: 600 }, scrollTop: 1000, scrollLeft: 0, clientWidth: 800, clientHeight: 600 };

describe("revealing a passage", () => {
  test("a passage in the left column centres vertically and leaves the horizontal offset alone", () => {
    const { top, left } = revealOffsets({ ...viewer, rects: [{ left: 60, top: 450, width: 300, height: 14 }] });
    assert.equal(top, 1000 + 450 - 300);
    assert.equal(left, 0);
  });

  test("a passage in the right column, off the window's edge, is brought into the middle of it", () => {
    // The right column starts at x=900, past the window's right edge (800)
    const { top, left } = revealOffsets({ ...viewer, rects: [{ left: 900, top: 450, width: 300, height: 14 }, { left: 900, top: 466, width: 280, height: 14 }] });
    assert.equal(top, 1000 + 450 - 300);
    // The passage (900–1200, 300px wide) centred in an 800px window: its left
    // edge lands 250px in
    assert.equal(left, 900 - 250);
  });

  test("a passage partly off the left edge comes back into view", () => {
    const scrolled = { ...viewer, scrollLeft: 500 };
    const { left } = revealOffsets({ ...scrolled, rects: [{ left: -40, top: 100, width: 300, height: 14 }] });
    // Content x = 500 + (-40) = 460; centred in 800 with 300 wide → 460 - 250
    assert.equal(left, 210);
  });

  test("a passage wider than the window shows its beginning rather than its middle", () => {
    const { left } = revealOffsets({ ...viewer, rects: [{ left: 1000, top: 100, width: 1200, height: 14 }] });
    assert.equal(left, 1000);
  });

  test("the offset never goes negative", () => {
    const { left } = revealOffsets({ ...viewer, rects: [{ left: -600, top: 100, width: 100, height: 14 }] });
    assert.equal(left, 0);
  });

  test("no lines: nothing moves", () => {
    assert.deepEqual(revealOffsets({ ...viewer, rects: [] }), { top: 1000, left: 0 });
  });
});
