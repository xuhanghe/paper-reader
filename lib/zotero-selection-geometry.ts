// Zotero builds highlight rectangles from PDF character geometry, not from a
// browser Range. PDF.js exposes enough of that geometry in TextContent for us
// to use the same vertical line boxes while retaining the Range's exact
// horizontal selection bounds.

export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  dir?: string;
};

export type PdfTextStyle = {
  ascent: number;
  descent: number;
  vertical: boolean;
};

export type PdfRect = [number, number, number, number];

export type ZoteroTextLine = {
  rect: PdfRect;
  itemIndexes: number[];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function zoteroFontBounds(style: PdfTextStyle | undefined): [number, number] {
  let ascent = style?.ascent;
  let descent = style?.descent;

  // These are the same fallbacks and guards used by Zotero's PDF worker when
  // it turns glyphs into selection characters.
  if (descent !== undefined && descent > 0) descent = -descent;
  if (ascent && descent) {
    if (ascent > 1) ascent = 0.75;
    if (descent < -0.5) descent = -0.25;
  } else {
    ascent = 0.75;
    descent = -0.25;
  }
  return [descent, ascent];
}

export function zoteroItemRect(item: PdfTextItem, style: PdfTextStyle | undefined): PdfRect | null {
  if (!item.str || item.transform.length < 6) return null;
  const [a, b, c, d, e, f] = item.transform;
  const inlineLength = Math.hypot(a, b);
  const blockLength = Math.hypot(c, d);
  if (!Number.isFinite(inlineLength) || !Number.isFinite(blockLength) || inlineLength === 0 || blockLength === 0) {
    return null;
  }

  const [descent, ascent] = zoteroFontBounds(style);
  const ux = a / inlineLength;
  const uy = b / inlineLength;
  const start = [e, f] as const;
  const end = [e + ux * item.width, f + uy * item.width] as const;
  const corners = [
    [start[0] + c * descent, start[1] + d * descent],
    [start[0] + c * ascent, start[1] + d * ascent],
    [end[0] + c * descent, end[1] + d * descent],
    [end[0] + c * ascent, end[1] + d * ascent],
  ];
  return [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
}

export function zoteroTextLines(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle>
): ZoteroTextLine[] {
  const lines: ZoteroTextLine[] = [];
  let line: ZoteroTextLine | null = null;

  const finishLine = () => {
    if (line) lines.push(line);
    line = null;
  };

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const rect = zoteroItemRect(item, styles[item.fontName]);
    if (rect) {
      if (!line) {
        line = { rect, itemIndexes: [itemIndex] };
      } else {
        const lineHeight = line.rect[3] - line.rect[1];
        const rectHeight = rect[3] - rect[1];
        const centreDistance = Math.abs((line.rect[1] + line.rect[3] - rect[1] - rect[3]) / 2);
        // Some PDFs omit hasEOL. A baseline jump larger than half a line is a
        // reliable boundary, while mixed fonts on one line remain together.
        if (centreDistance > Math.max(lineHeight, rectHeight) * 0.55) {
          finishLine();
          line = { rect, itemIndexes: [itemIndex] };
        } else {
          line.rect = [
            Math.min(line.rect[0], rect[0]),
            Math.min(line.rect[1], rect[1]),
            Math.max(line.rect[2], rect[2]),
            Math.max(line.rect[3], rect[3]),
          ];
          line.itemIndexes.push(itemIndex);
        }
      }
    }
    if (item.hasEOL) finishLine();
  }
  finishLine();
  return lines;
}

export function zoteroLineRects(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle>
): PdfRect[] {
  return zoteroTextLines(items, styles).map((line) => line.rect);
}

export function alignRectsToZoteroLines(
  rects: number[][],
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle>
): number[][] {
  const lines = zoteroLineRects(items, styles);
  if (!lines.length) return rects;

  return rects.map((rect) => {
    if (rect.length < 4) return rect;
    const [x1, y1, x2, y2] = rect;
    const centre = (y1 + y2) / 2;
    let best: PdfRect | null = null;
    let bestScore = Infinity;
    for (const line of lines) {
      const overlap = Math.min(x2, line[2]) - Math.max(x1, line[0]);
      const distance = Math.abs(centre - (line[1] + line[3]) / 2);
      const reach = Math.max(y2 - y1, line[3] - line[1]) * 1.25;
      if (overlap <= 0 || distance > reach) continue;
      // Prefer the line vertically nearest the Range. Horizontal overlap is a
      // tie-breaker for dense tables and multi-column layouts.
      const score = distance - Math.min(overlap, x2 - x1) * 0.001;
      if (score < bestScore) {
        best = line;
        bestScore = score;
      }
    }
    return best
      ? [round3(x1), round3(best[1]), round3(x2), round3(best[3])]
      : rect.map(round3);
  });
}
