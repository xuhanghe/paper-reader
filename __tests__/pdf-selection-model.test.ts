import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPdfSelectionModel,
  hitTestPdfSelection,
  pdfSelectionRange,
  pdfSelectionRangeForText,
  pdfSelectionAcrossPages,
  selectionSegmentsText,
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

test("a cited quote resolves through the same PDF range as a pointer selection", () => {
  const model = buildPdfSelectionModel([
    item("the operator commutes", 40, 300),
    item("with decompression", 40, 288),
  ], styles);
  const cited = pdfSelectionRangeForText(model, "commutes with decompression");

  assert.ok(cited);
  assert.equal(cited.text, "commutes with decompression");
  assert.equal(cited.rects.length, 2);
  assert.deepEqual(cited.rects.map((rect) => [rect[1], rect[3]]), [
    [297.84, 306.78],
    [285.84, 294.78],
  ]);
});

test("citation matching ignores PDF whitespace and selects a requested occurrence", () => {
  const model = buildPdfSelectionModel([
    item("Theorem 2 commutes with decompression", 40, 300),
    item("Theorem 2 commutes   with decompression", 40, 288),
  ], styles);
  const cited = pdfSelectionRangeForText(model, "COMMUTES\nWITH DECOMPRESSION", 1);

  assert.ok(cited);
  assert.equal(cited.rects.length, 1);
  assert.equal(cited.rects[0][1], 285.84);
});

test("a selection dragged from one page into the next is one segment per page, in reading order", () => {
  const page1 = buildPdfSelectionModel([item("end of page one", 50, 100)], styles);
  const page2 = buildPdfSelectionModel([item("start of page two", 50, 700), item("and more", 50, 688)], styles);
  const pages = [{ pageNumber: 2, model: page2 }, { pageNumber: 1, model: page1 }];

  const forward = pdfSelectionAcrossPages(pages, { pageNumber: 1, boundary: 7 }, { pageNumber: 2, boundary: 5 });
  assert.ok(forward);
  assert.deepEqual(forward.map((s) => s.pageNumber), [1, 2]);
  assert.equal(forward[0].range.text, "page one");
  assert.equal(forward[1].range.text, "start");
  assert.equal(selectionSegmentsText(forward), "page one\nstart");

  // Dragged upwards from page 2 back into page 1: the same passage
  const backward = pdfSelectionAcrossPages(pages, { pageNumber: 2, boundary: 5 }, { pageNumber: 1, boundary: 7 });
  assert.deepEqual(backward!.map((s) => s.range.text), ["page one", "start"]);
});

test("pages between the anchor and the focus are taken whole", () => {
  const mk = (text: string) => buildPdfSelectionModel([item(text, 50, 100)], styles);
  const pages = [1, 2, 3].map((n) => ({ pageNumber: n, model: mk(`page ${n} text`) }));
  const segments = pdfSelectionAcrossPages(pages, { pageNumber: 1, boundary: 5 }, { pageNumber: 3, boundary: 4 });
  assert.deepEqual(segments!.map((s) => s.range.text), ["1 text", "page 2 text", "page"]);
});

test("a selection on one page is the ordinary single range, and an empty one is nothing", () => {
  const model = buildPdfSelectionModel([item("one page only", 50, 100)], styles);
  const pages = [{ pageNumber: 4, model }];
  const single = pdfSelectionAcrossPages(pages, { pageNumber: 4, boundary: 4 }, { pageNumber: 4, boundary: 8 });
  assert.deepEqual(single!.map((s) => [s.pageNumber, s.range.text]), [[4, "page"]]);
  assert.equal(pdfSelectionAcrossPages(pages, { pageNumber: 4, boundary: 4 }, { pageNumber: 4, boundary: 4 }), null);
  // A page whose model is not loaded contributes nothing rather than breaking the selection
  assert.deepEqual(pdfSelectionAcrossPages(pages, { pageNumber: 3, boundary: 0 }, { pageNumber: 4, boundary: 3 })!.map((s) => s.range.text), ["one"]);
});

test("a range that crosses a line break reads with a space where the break was", () => {
  const model = buildPdfSelectionModel([item("da Licença.", 50, 420), item("A. Licença de", 50, 408)], styles);
  const range = pdfSelectionRange(model, 3, model.characters.length);
  assert.equal(range!.text, "Licença. A. Licença de");
  // A word hyphenated across the break stays one word
  const hyphenated = buildPdfSelectionModel([item("end-to-end work-", 50, 420), item("load", 50, 408)], styles);
  assert.equal(pdfSelectionRange(hyphenated, 0, hyphenated.characters.length)!.text, "end-to-end work-load");
  // A break that already has whitespace around it gains nothing
  const spaced = buildPdfSelectionModel([item("ends here ", 50, 420), item("next line", 50, 408)], styles);
  assert.equal(pdfSelectionRange(spaced, 0, spaced.characters.length)!.text, "ends here next line");
});
