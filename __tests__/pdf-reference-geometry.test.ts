import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfSelectionModel } from "../lib/pdf-selection-model";
import { alignReferenceLink, referenceRectFractions } from "../lib/pdf-reference-geometry";

const styles = { regular: { ascent: 0.678, descent: -0.216, vertical: false } };

function modelFor(lines: Array<{ text: string; baseline: number }>) {
  return buildPdfSelectionModel(lines.map(({ text, baseline }) => ({
    str: text,
    transform: [10, 0, 0, 10, 100, baseline],
    width: text.length * 5,
    height: 10,
    fontName: "regular",
    hasEOL: true,
  })), styles);
}

test("moves a malformed citation rectangle onto the PDF text line", () => {
  const model = modelFor([
    { text: "line above", baseline: 420 },
    { text: "Dorfman [17] consists", baseline: 408 },
    { text: "line below", baseline: 396 },
  ]);
  const aligned = alignReferenceLink(model, [140, 402, 150, 411]);

  assert.ok(aligned);
  assert.equal(aligned.lineIndex, 1);
  assert.deepEqual(aligned.rect.slice(1, 4).filter((_, index) => index !== 1), [405.84, 414.78]);
});

test("includes square brackets omitted by a hyperref source rectangle", () => {
  const model = modelFor([{ text: "Dorfman [17] consists", baseline: 408 }]);
  // Equal-width model: [ begins at x=140, 1 at 145, 7 at 150, ] at 155.
  const aligned = alignReferenceLink(model, [145, 405, 155, 414]);

  assert.ok(aligned);
  assert.equal(aligned.label, "[17]");
  assert.deepEqual(aligned.rect, [140, 405.84, 160, 414.78]);
});

test("rejects a link rectangle too far from every text line", () => {
  const model = modelFor([{ text: "[17]", baseline: 408 }]);
  assert.equal(alignReferenceLink(model, [100, 300, 120, 310]), null);
});

test("uses the annotation text when the producer rectangle overlaps a neighbouring fragment", () => {
  const model = modelFor([
    { text: "MCMC kernel", baseline: 540 },
    { text: "The Gibbs sampler [ 20 ]", baseline: 538 },
  ]);
  const aligned = alignReferenceLink(model, [200, 535, 210, 543], "20");

  assert.ok(aligned);
  assert.equal(aligned.lineIndex, 1);
  assert.equal(aligned.label, "[20]");
});

test("keeps each number in a grouped citation as its own target", () => {
  const model = modelFor([{ text: "results [41, 46] show", baseline: 408 }]);
  const aligned = alignReferenceLink(model, [145, 405, 155, 414], "41");

  assert.ok(aligned);
  assert.equal(aligned.label, "41");
});

test("keeps a reference rectangle fixed through every viewer zoom", () => {
  const rect: [number, number, number, number] = [140, 405.84, 160, 414.78];
  const atZoom = (scale: number) => referenceRectFractions(rect, {
    width: 600 * scale,
    height: 800 * scale,
    convertToViewportPoint: (x, y) => [x * scale, (800 - y) * scale],
  });

  assert.deepEqual(atZoom(0.86), atZoom(1.12));
  assert.deepEqual(atZoom(1.12), atZoom(1.97));
});
