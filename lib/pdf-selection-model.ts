import {
  zoteroFontBounds,
  zoteroItemRect,
  zoteroTextLines,
  type PdfRect,
  type PdfTextItem,
  type PdfTextStyle,
} from "./zotero-selection-geometry";

export type PdfSelectionCharacter = {
  text: string;
  itemIndex: number;
  startOffset: number;
  endOffset: number;
  lineIndex: number;
  rect: PdfRect;
  inlineStart: [number, number];
  inlineEnd: [number, number];
};

export type PdfSelectionLine = {
  rect: PdfRect;
  charIndexes: number[];
};

export type PdfSelectionModel = {
  characters: PdfSelectionCharacter[];
  lines: PdfSelectionLine[];
};

export type PdfSelectionHit = {
  /** An insertion point in the range 0..characters.length. */
  boundary: number;
  charIndex: number;
  lineIndex: number;
};

export type PdfSelectionRange = {
  start: number;
  end: number;
  rects: PdfRect[];
  text: string;
};

// Lowercase without changing the number of UTF-16 code units. Some Unicode
// characters expand when lowercased; retaining the original in that case
// keeps every normalized unit mapped to the PDF character that produced it.
function foldCharacter(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function codePointOffsets(text: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    out.push([offset, end, character]);
    offset = end;
  }
  return out;
}

function normalizedFractions(length: number, measured?: number[]): number[] {
  if (
    measured?.length === length + 1 &&
    measured.every(Number.isFinite) &&
    measured.every((value, index) => index === 0 || value >= measured[index - 1]) &&
    measured[measured.length - 1] > measured[0]
  ) {
    const first = measured[0];
    const span = measured[measured.length - 1] - first;
    return measured.map((value) => clamp((value - first) / span, 0, 1));
  }
  return Array.from({ length: length + 1 }, (_, index) => (length ? index / length : 0));
}

/**
 * Builds the selectable character map in PDF coordinates. The optional
 * fractions describe browser-measured character widths within each item; only
 * their normalized inline widths are used. Browser top/height values never
 * enter this model.
 */
export function buildPdfSelectionModel(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle>,
  boundaryFractionsByItem: Array<number[] | undefined> = []
): PdfSelectionModel {
  const sourceLines = zoteroTextLines(items, styles);
  const itemToLine = new Map<number, number>();
  sourceLines.forEach((line, lineIndex) => {
    for (const itemIndex of line.itemIndexes) itemToLine.set(itemIndex, lineIndex);
  });

  const characters: PdfSelectionCharacter[] = [];
  const lines: PdfSelectionLine[] = sourceLines.map((line) => ({ rect: line.rect, charIndexes: [] }));

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const itemBox = zoteroItemRect(item, styles[item.fontName]);
    const lineIndex = itemToLine.get(itemIndex);
    const offsets = codePointOffsets(item.str);
    if (!itemBox || lineIndex === undefined || offsets.length === 0 || item.transform.length < 6) continue;

    const [a, b, c, d, e, f] = item.transform;
    const inlineLength = Math.hypot(a, b);
    if (!inlineLength || !Number.isFinite(inlineLength)) continue;
    const ux = a / inlineLength;
    const uy = b / inlineLength;
    const [descent, ascent] = zoteroFontBounds(styles[item.fontName]);
    const fractions = normalizedFractions(offsets.length, boundaryFractionsByItem[itemIndex]);
    const rtl = item.dir === "rtl";

    for (let index = 0; index < offsets.length; index++) {
      const [startOffset, endOffset, text] = offsets[index];
      const rawStart = rtl ? 1 - fractions[index] : fractions[index];
      const rawEnd = rtl ? 1 - fractions[index + 1] : fractions[index + 1];
      const inlineStart = [e + ux * item.width * rawStart, f + uy * item.width * rawStart] as [number, number];
      const inlineEnd = [e + ux * item.width * rawEnd, f + uy * item.width * rawEnd] as [number, number];
      const corners = [
        [inlineStart[0] + c * descent, inlineStart[1] + d * descent],
        [inlineStart[0] + c * ascent, inlineStart[1] + d * ascent],
        [inlineEnd[0] + c * descent, inlineEnd[1] + d * descent],
        [inlineEnd[0] + c * ascent, inlineEnd[1] + d * ascent],
      ];
      const charIndex = characters.length;
      characters.push({
        text,
        itemIndex,
        startOffset,
        endOffset,
        lineIndex,
        rect: [
          Math.min(...corners.map((point) => point[0])),
          Math.min(...corners.map((point) => point[1])),
          Math.max(...corners.map((point) => point[0])),
          Math.max(...corners.map((point) => point[1])),
        ],
        inlineStart,
        inlineEnd,
      });
      lines[lineIndex].charIndexes.push(charIndex);
    }
  }

  return { characters, lines };
}

function pointRectDistanceSquared(x: number, y: number, rect: PdfRect): number {
  const dx = x < rect[0] ? rect[0] - x : x > rect[2] ? x - rect[2] : 0;
  const dy = y < rect[1] ? rect[1] - y : y > rect[3] ? y - rect[3] : 0;
  return dx * dx + dy * dy;
}

/** Resolve a pointer to the nearest insertion point on the nearest PDF line. */
export function hitTestPdfSelection(
  model: PdfSelectionModel,
  x: number,
  y: number,
  maxLineDistanceRatio = 1
): PdfSelectionHit | null {
  let lineIndex = -1;
  let lineDistance = Infinity;
  for (let index = 0; index < model.lines.length; index++) {
    const line = model.lines[index];
    if (line.charIndexes.length === 0) continue;
    const distance = pointRectDistanceSquared(x, y, line.rect);
    if (distance < lineDistance) {
      lineDistance = distance;
      lineIndex = index;
    }
  }
  if (lineIndex < 0) return null;
  const line = model.lines[lineIndex];
  const lineHeight = Math.max(1, line.rect[3] - line.rect[1]);
  if (Math.sqrt(lineDistance) > lineHeight * maxLineDistanceRatio) return null;

  let charIndex = line.charIndexes[0];
  let charDistance = Infinity;
  for (const index of line.charIndexes) {
    const distance = pointRectDistanceSquared(x, y, model.characters[index].rect);
    if (distance < charDistance) {
      charDistance = distance;
      charIndex = index;
    }
  }

  const character = model.characters[charIndex];
  const startDistance = (x - character.inlineStart[0]) ** 2 + (y - character.inlineStart[1]) ** 2;
  const endDistance = (x - character.inlineEnd[0]) ** 2 + (y - character.inlineEnd[1]) ** 2;
  return {
    boundary: endDistance < startDistance ? charIndex + 1 : charIndex,
    charIndex,
    lineIndex,
  };
}

export function pdfSelectionRange(
  model: PdfSelectionModel,
  anchorBoundary: number,
  focusBoundary: number
): PdfSelectionRange | null {
  const start = clamp(Math.min(anchorBoundary, focusBoundary), 0, model.characters.length);
  const end = clamp(Math.max(anchorBoundary, focusBoundary), 0, model.characters.length);
  if (start === end) return null;

  const selected = model.characters.slice(start, end);
  const byLine = new Map<number, PdfSelectionCharacter[]>();
  for (const character of selected) {
    const line = byLine.get(character.lineIndex) ?? [];
    line.push(character);
    byLine.set(character.lineIndex, line);
  }

  const rects: PdfRect[] = [];
  for (const [lineIndex, characters] of [...byLine].sort(([a], [b]) => a - b)) {
    const line = model.lines[lineIndex];
    rects.push([
      round3(Math.min(...characters.map((character) => character.rect[0]))),
      round3(line.rect[1]),
      round3(Math.max(...characters.map((character) => character.rect[2]))),
      round3(line.rect[3]),
    ]);
  }

  // Items on different lines carry no whitespace between them, so a line
  // break becomes a space — the way the browser reads the same selection.
  // A hyphen at the line's end is kept as it is: the browser does the same.
  let text = "";
  let previous: PdfSelectionCharacter | null = null;
  for (const character of selected) {
    if (previous && character.lineIndex !== previous.lineIndex && !/[\s-]$/u.test(text) && !/^\s/u.test(character.text)) {
      text += " ";
    }
    text += character.text;
    previous = character;
  }

  return { start, end, rects, text };
}

/**
 * Find quoted prose in the PDF character model and return the same exact
 * PDF-space range produced by a pointer selection. Whitespace is ignored
 * because PDF text items routinely split words and lines differently from the
 * model's quote. `occurrence` disambiguates repeated prose on one page.
 */
export function pdfSelectionRangeForText(
  model: PdfSelectionModel,
  query: string,
  occurrence = 0
): PdfSelectionRange | null {
  let normalizedQuery = "";
  for (const character of query) {
    if (!/\s/u.test(character)) normalizedQuery += foldCharacter(character);
  }
  if (!normalizedQuery) return null;

  let normalizedText = "";
  const normalizedToCharacter: number[] = [];
  for (let characterIndex = 0; characterIndex < model.characters.length; characterIndex++) {
    const character = model.characters[characterIndex].text;
    if (/^\s+$/u.test(character)) continue;
    const folded = foldCharacter(character);
    normalizedText += folded;
    for (let unit = 0; unit < folded.length; unit++) normalizedToCharacter.push(characterIndex);
  }

  const hits: number[] = [];
  for (
    let at = normalizedText.indexOf(normalizedQuery);
    at !== -1;
    at = normalizedText.indexOf(normalizedQuery, at + normalizedQuery.length)
  ) {
    hits.push(at);
  }
  const at = hits[occurrence] ?? hits[0];
  if (at === undefined) return null;
  const firstCharacter = normalizedToCharacter[at];
  const lastCharacter = normalizedToCharacter[at + normalizedQuery.length - 1];
  if (firstCharacter === undefined || lastCharacter === undefined) return null;
  return pdfSelectionRange(model, firstCharacter, lastCharacter + 1);
}

// ── A selection that runs across pages ───────────────────────────────
//
// A pointer selection has an anchor and a focus, and nothing says they sit on
// the same page. Each page contributes one range: the first page from its
// boundary to its end, every page in between whole, the last page from its
// start to its boundary — or the reverse when the selection was dragged
// upwards. The segments come back in reading order whichever way it was
// dragged, so a highlight per page and the text as one passage both fall out.

export type PdfSelectionEnd = { pageNumber: number; boundary: number };
export type PdfSelectionPage = { pageNumber: number; model: PdfSelectionModel };
export type PdfSelectionSegment = { pageNumber: number; range: PdfSelectionRange };

export function pdfSelectionAcrossPages(
  pages: PdfSelectionPage[],
  anchor: PdfSelectionEnd,
  focus: PdfSelectionEnd
): PdfSelectionSegment[] | null {
  const forward =
    anchor.pageNumber < focus.pageNumber ||
    (anchor.pageNumber === focus.pageNumber && anchor.boundary <= focus.boundary);
  const first = forward ? anchor : focus;
  const last = forward ? focus : anchor;

  const segments: PdfSelectionSegment[] = [];
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (page.pageNumber < first.pageNumber || page.pageNumber > last.pageNumber) continue;
    const start = page.pageNumber === first.pageNumber ? first.boundary : 0;
    const end = page.pageNumber === last.pageNumber ? last.boundary : page.model.characters.length;
    const range = pdfSelectionRange(page.model, start, end);
    if (range) segments.push({ pageNumber: page.pageNumber, range });
  }
  return segments.length ? segments : null;
}

// The passage as one piece of text: pages joined by a line break, since the
// last line of one page and the first of the next are never one sentence's
// worth of whitespace apart.
export function selectionSegmentsText(segments: PdfSelectionSegment[]): string {
  return segments.map((segment) => segment.range.text.trim()).filter(Boolean).join("\n");
}
