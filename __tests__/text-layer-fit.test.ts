import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseScaleX, fitRatio, fittedTransform } from "../lib/text-layer-fit.js";

describe("text-layer fit", () => {
  test("reads pdf.js's horizontal scale, and only that", () => {
    assert.equal(parseScaleX("scaleX(0.912132)"), 0.912132);
    assert.equal(parseScaleX(" scaleX(1.02) "), 1.02);
    assert.equal(parseScaleX(""), null);
    assert.equal(parseScaleX("rotate(90deg) scaleX(0.9)"), null);
    assert.equal(parseScaleX("scaleX(0)"), null);
  });

  test("a minimum-font-size scale rides along unchanged", () => {
    // Safari with "Never use font sizes smaller than 9": pdf.js sets the font
    // nine times larger and adds scale(1/9). The fit must keep that suffix.
    assert.equal(parseScaleX("scaleX(0.9) scale(0.1111111)"), 0.9);
    const fitted = fittedTransform("scaleX(0.9) scale(0.1111111)", 400, 360);
    assert.ok(fitted);
    assert.ok(fitted!.endsWith(" scale(0.1111111)"), fitted);
    assert.ok(Math.abs(parseScaleX(fitted!)! - 1.0) < 1e-9);
  });

  test("a span the DOM renders as measured needs nothing", () => {
    assert.equal(fitRatio(374.0, 374.0), null);
    assert.equal(fitRatio(374.0, 375.2), null); // within rounding
    assert.equal(fittedTransform("scaleX(0.912)", 374, 374.5), null);
  });

  test("a span rendered narrower than measured is widened by the same factor", () => {
    // Times where Helvetica was measured: the DOM comes out 10% narrow, and
    // pdf.js's scale, computed for Helvetica, has to grow by the same 10%
    const fitted = fittedTransform("scaleX(0.9)", 400, 360);
    assert.ok(fitted);
    const k = parseScaleX(fitted!)!;
    assert.ok(Math.abs(k - 1.0) < 1e-9, `expected 1.0, got ${k}`);
  });

  test("a span rendered wider than measured is narrowed", () => {
    const k = parseScaleX(fittedTransform("scaleX(1.0)", 300, 330)!)!;
    assert.ok(Math.abs(k - 300 / 330) < 1e-9);
  });

  test("degenerate measurements are refused rather than producing a scale of 0 or infinity", () => {
    assert.equal(fitRatio(0, 300), null);
    assert.equal(fitRatio(300, 0), null);
    assert.equal(fitRatio(NaN, 300), null);
    assert.equal(fittedTransform("scaleX(0.9)", 0, 0), null);
  });

  test("rotated runs are left to pdf.js", () => {
    assert.equal(fittedTransform("rotate(90deg) scaleX(0.9)", 400, 360), null);
  });
});
