import type { PdfRect } from "./zotero-selection-geometry";
import type { PdfSelectionModel } from "./pdf-selection-model";

export type AlignedReferenceLink = {
  rect: PdfRect;
  label: string;
  lineIndex: number;
};

export type ReferenceViewport = {
  width: number;
  height: number;
  convertToViewportPoint: (x: number, y: number) => number[];
};

export type ReferenceRectFractions = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function intervalDistance(a1: number, a2: number, b1: number, b2: number): number {
  if (a2 < b1) return b1 - a2;
  if (b2 < a1) return a1 - b2;
  return 0;
}

/**
 * Replaces a PDF producer's link rectangle with the exact character box on the
 * corresponding PDF text line. The source rectangle is only used to identify
 * the characters; its display geometry is never reused.
 */
export function alignReferenceLink(
  model: PdfSelectionModel,
  sourceRect: number[],
  sourceText?: string
): AlignedReferenceLink | null {
  if (sourceRect.length < 4 || model.characters.length === 0) return null;
  const [x1, y1, x2, y2] = sourceRect;
  const sourceCentreY = (y1 + y2) / 2;

  // PDF.js exposes the text covered by a link annotation. Prefer that semantic
  // anchor when available: it identifies the citation even when a producer's
  // rectangle is a line away from the glyphs. Whitespace is ignored because
  // TeX PDFs commonly extract "[17]" as "[ 17 ]".
  const needle = Array.from(sourceText?.trim() ?? "")
    .filter((character) => !/\s/u.test(character))
    .map((character) => character.toLocaleLowerCase());
  let semanticMatch: { lineIndex: number; selected: number[]; score: number } | null = null;
  if (needle.length) {
    for (let index = 0; index < model.lines.length; index++) {
      const line = model.lines[index];
      const searchable = line.charIndexes.filter(
        (charIndex) => !/\s/u.test(model.characters[charIndex].text)
      );
      for (let start = 0; start <= searchable.length - needle.length; start++) {
        const selected = searchable.slice(start, start + needle.length);
        const matches = selected.every(
          (charIndex, offset) => model.characters[charIndex].text.toLocaleLowerCase() === needle[offset]
        );
        if (!matches) continue;
        const left = Math.min(...selected.map((charIndex) => model.characters[charIndex].rect[0]));
        const right = Math.max(...selected.map((charIndex) => model.characters[charIndex].rect[2]));
        const horizontal = intervalDistance(x1, x2, left, right);
        const vertical = intervalDistance(y1, y2, line.rect[1], line.rect[3]);
        const score = horizontal + vertical * 4
          + Math.abs(sourceCentreY - (line.rect[1] + line.rect[3]) / 2) * 0.01;
        if (!semanticMatch || score < semanticMatch.score) {
          semanticMatch = { lineIndex: index, selected, score };
        }
      }
    }
  }

  let lineIndex = semanticMatch?.lineIndex ?? -1;
  let selected = semanticMatch?.selected ?? [];
  if (!semanticMatch) {
    let bestLineScore = Infinity;
    for (let index = 0; index < model.lines.length; index++) {
      const line = model.lines[index];
      if (!line.charIndexes.length) continue;
      const lineHeight = Math.max(1, line.rect[3] - line.rect[1]);
      const vertical = intervalDistance(y1, y2, line.rect[1], line.rect[3]);
      if (vertical > lineHeight * 1.25) continue;
      const horizontal = intervalDistance(x1, x2, line.rect[0], line.rect[2]);
      const score = horizontal + vertical * 4
        + Math.abs(sourceCentreY - (line.rect[1] + line.rect[3]) / 2) * 0.01;
      if (score < bestLineScore) {
        bestLineScore = score;
        lineIndex = index;
      }
    }
  }
  if (lineIndex < 0) return null;
  const line = model.lines[lineIndex];
  const lineHeight = Math.max(1, line.rect[3] - line.rect[1]);

  if (!selected.length) {
    selected = line.charIndexes.filter((index) => {
      const rect = model.characters[index].rect;
      return intervalDistance(x1, x2, rect[0], rect[2]) <= Math.min(1.25, lineHeight * 0.14);
    });
  }
  if (!selected.length) {
    const nearest = line.charIndexes.reduce((best, index) => {
      const rect = model.characters[index].rect;
      const distance = intervalDistance(x1, x2, rect[0], rect[2]);
      return distance < best.distance ? { index, distance } : best;
    }, { index: -1, distance: Infinity });
    if (nearest.index < 0 || nearest.distance > lineHeight) return null;
    selected = [nearest.index];
  }

  // Hyperref frequently links only the number and leaves the square brackets
  // outside the source rectangle. Include immediately adjacent brackets so the
  // hover target reads as the citation the reader sees.
  let first = Math.min(...selected);
  let last = Math.max(...selected);
  let bracketBefore = first - 1;
  while (
    model.characters[bracketBefore]?.lineIndex === lineIndex
    && /\s/u.test(model.characters[bracketBefore].text)
  ) bracketBefore--;
  let bracketAfter = last + 1;
  while (
    model.characters[bracketAfter]?.lineIndex === lineIndex
    && /\s/u.test(model.characters[bracketAfter].text)
  ) bracketAfter++;
  if (
    model.characters[bracketBefore]?.lineIndex === lineIndex
    && model.characters[bracketBefore].text === "["
    && model.characters[bracketAfter]?.lineIndex === lineIndex
    && model.characters[bracketAfter].text === "]"
  ) {
    first = bracketBefore;
    last = bracketAfter;
  }
  selected = line.charIndexes.filter((index) => index >= first && index <= last);

  const characters = selected.map((index) => model.characters[index]);
  const rawLabel = characters.map((character) => character.text).join("").trim();
  return {
    lineIndex,
    label: /^\[\s*\d+\s*\]$/u.test(rawLabel) ? rawLabel.replace(/\s/gu, "") : rawLabel,
    rect: [
      Math.min(...characters.map((character) => character.rect[0])),
      line.rect[1],
      Math.max(...characters.map((character) => character.rect[2])),
      line.rect[3],
    ],
  };
}

/**
 * Converts a PDF rectangle to fractions of its page. The result is independent
 * of the viewport scale, so PDF.js can zoom the page without repainting or
 * drifting the reference target away from its text.
 */
export function referenceRectFractions(
  rect: PdfRect,
  viewport: ReferenceViewport
): ReferenceRectFractions {
  const fraction = (value: number, total: number) => Math.round((value / total) * 1e12) / 1e12;
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: fraction(Math.min(ax, bx), viewport.width),
    top: fraction(Math.min(ay, by), viewport.height),
    width: fraction(Math.abs(bx - ax), viewport.width),
    height: fraction(Math.abs(by - ay), viewport.height),
  };
}
