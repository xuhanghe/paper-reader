import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { nextZoomFrameScale, wheelDeltaPixels, wheelZoomTarget } from "../lib/pdf-zoom.js";

describe("PDF zoom gesture normalization", () => {
  test("normalizes pixel, line, and page wheel events", () => {
    assert.equal(wheelDeltaPixels(12, 0, 800), 12);
    assert.equal(wheelDeltaPixels(3, 1, 800), 48);
    assert.equal(wheelDeltaPixels(1, 2, 800), 800);
  });

  test("keeps one unusually large wheel event from causing a visual jump", () => {
    assert.ok(Math.abs(wheelZoomTarget(1, -1000) - 1.2) < 1e-12);
    assert.ok(Math.abs(wheelZoomTarget(1, 1000) - 1 / 1.2) < 1e-12);
  });

  test("preserves small trackpad movement instead of rounding it away", () => {
    assert.ok(wheelZoomTarget(1, -0.5) > 1);
    assert.ok(wheelZoomTarget(1, 0.5) < 1);
  });
});

describe("PDF zoom animation frames", () => {
  test("approaches a distant target in bounded six-percent steps", () => {
    assert.ok(Math.abs(nextZoomFrameScale(1, 2) - 1.06) < 1e-12);
    assert.ok(Math.abs(nextZoomFrameScale(2, 1) - 2 / 1.06) < 1e-12);
  });

  test("lands directly when the target is already within one frame", () => {
    assert.ok(Math.abs(nextZoomFrameScale(1, 1.03) - 1.03) < 1e-12);
  });
});
