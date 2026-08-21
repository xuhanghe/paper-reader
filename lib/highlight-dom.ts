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

// Every place `query` occurs in `full`, ignoring whitespace and case on both
// sides, in *raw* `full` indices.
//
// All of them, not just the first: a phrase can appear more than once on a
// page — "operator-level granularities" in an abstract and again in the
// contributions — and painting the first match means highlighting a passage
// the reader did not select.
export function findAllIgnoringWhitespace(full: string, query: string): { start: number; end: number }[] {
  let q = "";
  for (const ch of query) if (!/\s/.test(ch)) q += foldChar(ch);
  if (!q) return [];

  // Whitespace-free, lowercased string → raw index mapping
  let norm = "";
  const normToRaw: number[] = [];
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (/\s/.test(ch)) continue;
    norm += foldChar(ch);
    normToRaw.push(i);
  }

  const hits: { start: number; end: number }[] = [];
  // Overlapping occurrences are not distinct places to a reader, so each
  // search resumes past the one just found
  for (let at = norm.indexOf(q); at !== -1; at = norm.indexOf(q, at + q.length)) {
    hits.push({ start: normToRaw[at], end: normToRaw[at + q.length - 1] + 1 });
  }
  return hits;
}

// Locate `query` in `full`. `occurrence` picks which one; out of range falls
// back to the first, so a highlight whose page has changed still appears.
export function findIgnoringWhitespace(
  full: string,
  query: string,
  occurrence = 0
): { start: number; end: number } | null {
  const hits = findAllIgnoringWhitespace(full, query);
  return hits[occurrence] ?? hits[0] ?? null;
}

// Tags whose text content is code, not prose. HTML snapshots carry inline
// <script> and <style> blocks inside the body; matching in them would both
// invent highlights the reader can't see and corrupt the tag by wrapping a
// <mark> around part of it.
const NON_PROSE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);

// Where a passage sits in a container: the text nodes it spans, and its
// start/end offsets in their concatenated text
function textNodesIn(container: HTMLElement, skipSelector?: string) {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentNode as Element | null;
      if (NON_PROSE.has(parent?.nodeName ?? "")) return NodeFilter.FILTER_REJECT;
      // Regions that show the passage rather than contain it — a chip echoing a
      // quote must not be mistaken for the place it was quoted from
      if (skipSelector && parent?.closest?.(skipSelector)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: { node: Text; start: number }[] = [];
  let full = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, start: full.length });
    full += node.data;
  }
  return { nodes, full };
}

// Which occurrence of `query` a position in the container falls on — the
// selection's own place among the identical ones, recorded when a highlight is
// made so it can be painted back onto the same words later.
export function occurrenceAt(
  container: HTMLElement,
  query: string,
  node: Node,
  offsetInNode: number,
  skipSelector?: string
): number {
  const { nodes, full } = textNodesIn(container, skipSelector);
  const entry = nodes.find((n) => n.node === node);
  // A selection anchored somewhere with no text of its own (an element node)
  // cannot be placed; the first occurrence is as good a guess as any
  if (!entry) return 0;
  const rawOffset = entry.start + offsetInNode;
  const hits = findAllIgnoringWhitespace(full, query);
  const index = hits.findIndex((h) => h.end > rawOffset);
  return index === -1 ? 0 : index;
}

function locateText(
  container: HTMLElement,
  query: string,
  skipSelector?: string,
  occurrence = 0
): { nodes: { node: Text; start: number }[]; rawStart: number; rawEnd: number } | null {
  const { nodes, full } = textNodesIn(container, skipSelector);
  const match = findIgnoringWhitespace(full, query, occurrence);
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
  options?: { id?: string; color?: string; skipSelector?: string; occurrence?: number }
): boolean {
  const found = locateText(container, query, options?.skipSelector, options?.occurrence);
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
