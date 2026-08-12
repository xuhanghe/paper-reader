// Paints persistent highlights onto a text container by wrapping the matching
// text in <mark> elements. Used for both the PDF.js text layer and the body of
// an HTML snapshot inside its iframe — every DOM object is created from the
// container's *own* document, because ranges and nodes cannot cross documents.
//
// Matching ignores whitespace entirely on both sides. A selection and the text
// layer rarely agree about it: pdf.js gives every glyph run its own absolutely
// positioned span, and the browser inserts line breaks between them at its own
// discretion — CJK text, where each character is its own span, gets breaks in
// places the DOM has no whitespace at all ("暮易\nIntro" for "暮易Intro").
// Collapsing runs of whitespace is not enough; they have to be dropped.

export function clearMarks(container: HTMLElement, className: string) {
  container.querySelectorAll(`mark.${className}`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

// Lowercase a single character without ever changing its length, so the
// normalized string stays index-aligned with the raw one (a few characters,
// e.g. "İ", lowercase to two code units).
function foldChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

// Locate `query` in `full`, ignoring whitespace and case on both sides.
// Returns the range in *raw* `full` indices, or null when there is no match.
export function findIgnoringWhitespace(
  full: string,
  query: string
): { start: number; end: number } | null {
  let q = "";
  for (const ch of query) if (!/\s/.test(ch)) q += foldChar(ch);
  if (!q) return null;

  // Whitespace-free, lowercased string → raw index mapping
  let norm = "";
  const normToRaw: number[] = [];
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (/\s/.test(ch)) continue;
    norm += foldChar(ch);
    normToRaw.push(i);
  }

  const idx = norm.indexOf(q);
  if (idx === -1) return null;
  return { start: normToRaw[idx], end: normToRaw[idx + q.length - 1] + 1 };
}

// Tags whose text content is code, not prose. HTML snapshots carry inline
// <script> and <style> blocks inside the body; matching in them would both
// invent highlights the reader can't see and corrupt the tag by wrapping a
// <mark> around part of it.
const NON_PROSE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);

// Where a passage sits in a container: the text nodes it spans, and its
// start/end offsets in their concatenated text
function locateText(
  container: HTMLElement,
  query: string
): { nodes: { node: Text; start: number }[]; rawStart: number; rawEnd: number } | null {
  // Snapshot text nodes with their offsets in the concatenated raw string
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      NON_PROSE.has((node.parentNode as Element | null)?.nodeName ?? "")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Text; start: number }[] = [];
  let full = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, start: full.length });
    full += node.data;
  }
  const match = findIgnoringWhitespace(full, query);
  return match ? { nodes, rawStart: match.start, rawEnd: match.end } : null;
}

// A live Range over the passage, for measuring where it is on the page
export function rangeForText(container: HTMLElement, query: string): Range | null {
  const found = locateText(container, query);
  if (!found) return null;
  const { nodes, rawStart, rawEnd } = found;
  const startNode = nodes.find(({ node, start }) => rawStart < start + node.data.length);
  const endNode = [...nodes].reverse().find(({ start }) => rawEnd > start);
  if (!startNode || !endNode) return null;
  const range = container.ownerDocument.createRange();
  range.setStart(startNode.node, Math.max(0, rawStart - startNode.start));
  range.setEnd(endNode.node, Math.min(endNode.node.data.length, rawEnd - endNode.start));
  return range;
}

export function markTextInContainer(
  container: HTMLElement,
  query: string,
  className: string,
  title?: string,
  options?: { id?: string; color?: string }
): boolean {
  const found = locateText(container, query);
  if (!found) return false;
  const { nodes, rawStart, rawEnd } = found;
  const doc = container.ownerDocument;

  // Wrap the covered portion of each overlapped text node. Each range lives
  // inside a single text node, so surroundContents cannot fail on boundaries.
  for (const { node, start } of nodes) {
    const nodeEnd = start + node.data.length;
    const s = Math.max(rawStart, start);
    const e = Math.min(rawEnd, nodeEnd);
    if (s >= e) continue;
    const range = doc.createRange();
    range.setStart(node, s - start);
    range.setEnd(node, e - start);
    const mark = doc.createElement("mark");
    mark.className = className;
    if (title) mark.title = title;
    // The id lets a click on the mark resolve back to its highlight
    if (options?.id) mark.dataset.highlightId = options.id;
    if (options?.color) mark.style.background = options.color;
    try {
      range.surroundContents(mark);
    } catch {
      // skip un-wrappable fragments rather than break the layer
    }
  }
  return true;
}
