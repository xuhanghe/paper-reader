import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPdfSelectionModel,
  hitTestPdfSelection,
  pdfSelectionRange,
} from "../lib/pdf-selection-model";

const styles = {
  regular: { ascent: 0.678, descent: -0.216, vertical: false },
};

const item = (str: string, x: number, baseline: number, width = str.length * 5, hasEOL = true) => ({
  str,
  width,
  height: 10,
  transform: [10, 0, 0, 10, x, baseline],
  fontName: "regular",
  hasEOL,
});

test("pointer hit testing chooses the printed line, not the browser line above or below it", () => {
  const model = buildPdfSelectionModel([
    item("tensor parallelism", 50, 420),
    item("We first examine how", 50, 408),
    item("trade-offs regarding latency", 50, 396),
  ], styles);

  const target = hitTestPdfSelection(model, 52, 409);
  assert.ok(target);
  assert.equal(target.lineIndex, 1);
  assert.equal(model.characters[target.charIndex].text, "W");
});

test("selection rectangles use Zotero's exact font box vertically", () => {
  const model = buildPdfSelectionModel([
    item("Figure 4a highlights relative power consumption", 58.927, 347.959, 210),
  ], styles);
  const start = model.characters.findIndex((character) => character.text === "F");
  const end = start + "Figure 4a highlights".length;
  const selected = pdfSelectionRange(model, start, end);

  assert.ok(selected);
  assert.deepEqual(selected.rects[0].slice(1, 4).filter((_, index) => index !== 1), [345.799, 354.739]);
  assert.equal(selected.rects[0][0], 58.927);
});

test("browser-measured character widths refine only horizontal boundaries", () => {
  const model = buildPdfSelectionModel(
    [item("Wi", 10, 100, 20)],
    styles,
    [[0, 0.8, 1]]
  );
  assert.deepEqual(model.characters.map((character) => character.rect.slice(0, 4)), [
    [10, 97.84, 26, 106.78],
    [26, 97.84, 30, 106.78],
  ]);
});

test("the same physical pointer resolves identically at every viewport zoom", () => {
  const model = buildPdfSelectionModel([item("We now provide an overview", 40, 300)], styles);
  const pdfPoint: [number, number] = [63, 301];
  const boundaries = [0.86, 0.96, 1.13, 1.97].map((zoom) => {
    const clientPoint = [pdfPoint[0] * zoom, pdfPoint[1] * zoom];
    return hitTestPdfSelection(model, clientPoint[0] / zoom, clientPoint[1] / zoom)?.boundary;
  });
  assert.deepEqual(boundaries, [boundaries[0], boundaries[0], boundaries[0], boundaries[0]]);
});

test("a wrapped selection keeps one exact rectangle per PDF line", () => {
  const model = buildPdfSelectionModel([
    item("end-to-end work-", 60, 240),
    item("load", 60, 228),
  ], styles);
  const selected = pdfSelectionRange(model, 0, model.characters.length);

  assert.ok(selected);
  assert.equal(selected.text, "end-to-end work-load");
  assert.equal(selected.rects.length, 2);
  assert.deepEqual(selected.rects.map((rect) => rect.slice(1, 4).filter((_, index) => index !== 1)), [
    [237.84, 246.78],
    [225.84, 234.78],
  ]);
});
