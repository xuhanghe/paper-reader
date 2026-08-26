import assert from "node:assert/strict";
import test from "node:test";
import { alignRectsToZoteroLines, zoteroLineRects } from "../lib/zotero-selection-geometry";

const styles = {
  regular: { ascent: 0.678, descent: -0.216, vertical: false },
};

test("matches Zotero's PDF-character line box for the Figure 4a highlight", () => {
  const items = [{
    str: "Figure 4a highlights relative power consumption, assuming",
    width: 241.09492,
    height: 9.9626,
    transform: [9.9626, 0, 0, 9.9626, 58.927, 347.959],
    fontName: "regular",
    hasEOL: true,
  }];
  const rects = alignRectsToZoteroLines(
    [[58.9133522727, 347.8210727629, 145.6946570026, 358.8293372257]],
    items,
    styles
  );
  assert.deepEqual(rects, [[58.913, 345.807, 145.695, 354.714]]);
});

test("uses one shared vertical box across mixed-font items on a line", () => {
  const items = [
    {
      str: "bold ", width: 30, height: 10, transform: [10, 0, 0, 10, 50, 400],
      fontName: "regular", hasEOL: false,
    },
    {
      str: "regular", width: 40, height: 10, transform: [10, 0, 0, 10, 80, 400],
      fontName: "regular", hasEOL: true,
    },
  ];
  assert.deepEqual(zoteroLineRects(items, styles), [[50, 397.84, 120, 406.78]]);
});

test("does not snap a rectangle to a different nearby column", () => {
  const items = [{
    str: "right column", width: 80, height: 10, transform: [10, 0, 0, 10, 330, 400],
    fontName: "regular", hasEOL: true,
  }];
  assert.deepEqual(
    alignRectsToZoteroLines([[50, 394, 120, 405]], items, styles),
    [[50, 394, 120, 405]]
  );
});
