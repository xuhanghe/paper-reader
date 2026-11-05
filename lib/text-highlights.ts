// Painting over text that React renders, without changing it: the CSS Custom
// Highlight API styles ranges of the page as it is (Safari 17.2+, Chrome 105+).
// A <mark> wrapped around part of an answer cut React's text nodes; the next
// time that answer changed, React updated nodes that were no longer there.
//
// A painted range is not an element, so it has no events of its own: what is
// under the pointer is found from the point. Client-only.

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => boolean };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && typeof Highlight === "function" ? { highlights: css.highlights, Highlight } : null;
}

export const canPaintRanges = () => registry() !== null;

/** Paints `ranges` under `name` (see ::highlight(name) in the CSS); none clears it. */
export function paintRanges(name: string, ranges: Range[]): void {
  const api = registry();
  if (!api) return;
  if (ranges.length) api.highlights.set(name, new api.Highlight(...ranges));
  else api.highlights.delete(name);
}

/** A range still over the text it was made for: both ends on the page, something covered. */
export const rangeIsLive = (range: Range) => !range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected;

/** The text position under a point on the screen, if there is text there. */
export function positionAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof d.caretPositionFromPoint === "function") {
    const at = d.caretPositionFromPoint(x, y);
    return at ? { node: at.offsetNode, offset: at.offset } : null;
  }
  if (typeof d.caretRangeFromPoint === "function") {
    const at = d.caretRangeFromPoint(x, y);
    return at ? { node: at.startContainer, offset: at.startOffset } : null;
  }
  return null;
}

/** Which of the painted groups a text position falls in. */
export function groupAt(groups: Map<string, Range[]>, at: { node: Node; offset: number } | null): string | null {
  if (!at) return null;
  for (const [id, ranges] of groups) {
    for (const range of ranges) {
      try {
        if (rangeIsLive(range) && range.isPointInRange(at.node, at.offset)) return id;
      } catch {
        // a position in another document, or in a node a range cannot hold
      }
    }
  }
  return null;
}
