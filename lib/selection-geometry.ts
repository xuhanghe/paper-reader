import { mergeIntoLines, type Box } from "./ink-bands";

// Text-layer calibration makes browser hit-testing agree with the printed
// page, but those per-span nudges are display corrections, not PDF geometry.
// Measure a live selection with the intersected spans briefly restored to the
// coordinates PDF.js originally derived from the PDF. The reset and restore
// happen synchronously, before the browser can paint, so the user sees no jump.
export function logicalSelectionBands(range: Range, layer: HTMLElement): Box[] {
  const restored: { span: HTMLElement; top: string; left: string }[] = [];
  try {
    for (const span of Array.from(layer.querySelectorAll("span")) as HTMLElement[]) {
      if (span.dataset.prOriginalTop === undefined) continue;
      try {
        if (!range.intersectsNode(span)) continue;
      } catch {
        continue;
      }
      restored.push({ span, top: span.style.top, left: span.style.left });
      span.style.top = span.dataset.prOriginalTop;
      if (span.dataset.prOriginalLeft !== undefined) span.style.left = span.dataset.prOriginalLeft;
    }
    return mergeIntoLines(
      Array.from(range.getClientRects())
        .filter((r) => r.width > 0.5 && r.height > 0.5)
        .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))
    );
  } finally {
    for (const { span, top, left } of restored) {
      span.style.top = top;
      span.style.left = left;
    }
  }
}
