import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { logicalSelectionBands } from "../lib/selection-geometry.js";

describe("logical selection geometry", () => {
  test("serializes the PDF position, not a display-time calibration nudge", () => {
    const dom = new JSDOM(`<div class="textLayer"><span style="top: 90px; left: 42px">We first examine how</span></div>`);
    const layer = dom.window.document.querySelector(".textLayer") as HTMLElement;
    const span = layer.querySelector("span") as HTMLElement;
    span.dataset.prOriginalTop = "100px";
    span.dataset.prOriginalLeft = "40px";

    const range = {
      intersectsNode: (node: Node) => node === span,
      getClientRects: () => {
        assert.equal(span.style.top, "100px");
        assert.equal(span.style.left, "40px");
        return [{ left: 40, top: 100, width: 120, height: 12 }];
      },
    } as unknown as Range;

    assert.deepEqual(logicalSelectionBands(range, layer), [
      { left: 40, top: 100, width: 120, height: 12 },
    ]);
    assert.equal(span.style.top, "90px");
    assert.equal(span.style.left, "42px");
  });

  test("restores the calibrated display position even if measurement throws", () => {
    const dom = new JSDOM(`<div class="textLayer"><span style="top: 90px">text</span></div>`);
    const layer = dom.window.document.querySelector(".textLayer") as HTMLElement;
    const span = layer.querySelector("span") as HTMLElement;
    span.dataset.prOriginalTop = "100px";
    const range = {
      intersectsNode: () => true,
      getClientRects: () => { throw new Error("measurement failed"); },
    } as unknown as Range;

    assert.throws(() => logicalSelectionBands(range, layer), /measurement failed/);
    assert.equal(span.style.top, "90px");
  });
});
