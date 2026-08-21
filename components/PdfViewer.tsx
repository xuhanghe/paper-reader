"use client";
import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFViewer as PdfJsViewer, PDFLinkService, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { SelectionPopover } from "./SelectionPopover";
import { useTextSelection } from "@/hooks/useTextSelection";
import { useRegionDrag } from "@/hooks/useRegionDrag";
import { RegionResult } from "@/hooks/useRegionDrag";
import { markTextInContainer, clearMarks, rangeForText, findIgnoringWhitespace, occurrenceAt } from "@/lib/highlight-dom";
import { chooseInkRun } from "@/lib/ink-bands";
import { highlightTint, DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import { HighlightPopover } from "./HighlightPopover";
import type { Highlight } from "@/types/session";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

// A selection band grows this many pixels beyond the glyph boxes, so lines of
// mixed font sizes still read as one even ribbon
const SELECTION_PAD = 1.5;

type SelectionRect = { left: number; top: number; width: number; height: number };

// A band that has been matched to the glyphs, carrying where the ink actually
// ended. A wash can be a little taller than the letters without looking wrong,
// but a rule drawn under the band's own bottom edge lands wherever the text
// layer's box happens to end — and pdf.js boxes reach down into the following
// line, which is how an underline came to sit beneath the wrong sentence.
type SnappedBand = SelectionRect & { inkBottom?: number };

// The browser paints ::selection once per element, and pdf.js gives every glyph
// run its own absolutely positioned span — so a native selection comes out as a
// row of mismatched boxes with gaps between them. Merging the range's client
// rects into one box per line gives the smooth ribbon Zotero's reader draws.
//
// Two things have to be handled or the merge runs away: pdf.js keeps a
// page-sized `.endOfContent` div inside the text layer, which lands in the
// range as one enormous rect, and a band's tolerance has to stay pinned to the
// line it started on rather than growing as the band does.
function mergeIntoLines(rects: SelectionRect[]): SelectionRect[] {
  if (rects.length === 0) return [];

  // Drop structural rects (endOfContent, whole-page boxes) by height
  const heights = rects.map((r) => r.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const lines = rects
    .filter((r) => r.height <= median * 2.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const bands: (SelectionRect & { centre: number; lineHeight: number })[] = [];
  for (const r of lines) {
    const centre = r.top + r.height / 2;
    const band = bands[bands.length - 1];
    // Compare against the band's founding line, not its grown bounds
    if (!band || Math.abs(centre - band.centre) > Math.min(r.height, band.lineHeight) * 0.5) {
      bands.push({ ...r, centre, lineHeight: r.height });
      continue;
    }
    const left = Math.min(band.left, r.left);
    const top = Math.min(band.top, r.top);
    band.left = left;
    band.top = top;
    band.width = Math.max(band.left + band.width, r.left + r.width) - left;
    band.height = Math.max(band.top + band.height, r.top + r.height) - top;
  }
  return bands.map(({ left, top, width, height }) => ({ left, top, width, height }));
}

// A pixel counts as ink below this luminance
const INK_LUMA = 150;
// A row is part of a glyph line once this share of it is ink
const INK_ROW_SHARE = 0.015;
// How far above/below a text-layer box to look for the glyphs it stands for
const INK_SEARCH_ABOVE = 1.0;
const INK_SEARCH_BELOW = 0.5;
// Floor on band height, as a share of the text-layer box (i.e. the font size)
const MIN_BAND_RATIO = 0.82;
// How long a jumped-to passage stays lit
const FLASH_MS = 1600;
// Zotero draws its annotations with globalAlpha 0.5 and multiply blending
const HIGHLIGHT_ALPHA = 0.5;

type HighlightBand = SelectionRect & { id: string; color: string; underline?: boolean; inkBottom?: number };

// A passage that has a conversation attached to it. Drawn as a rule under the
// line rather than a wash over it, so it reads as a different kind of mark from
// a Zotero highlight and the two can sit on the same words without muddying.
// A passage with something attached to it: one you asked about, or one the
// model cited in an answer. Drawn the same way, in different colours — the
// point of marking them at all is knowing which is which at a glance.
export type AskedPassage = {
  id: string;
  text: string;
  pageNumber?: number;
  label?: string;
  kind?: "asked" | "cited";
  // Which of the identical passages on the page this is; see Highlight
  occurrence?: number;
};

// Snaps a selection band to the glyphs it covers.
//
// pdf.js positions its text layer with the browser's fallback fonts
// (font-family: sans-serif/monospace on every span), while the page canvas is
// drawn with the PDF's embedded fonts. When their metrics disagree — routinely,
// for CJK documents — the invisible boxes sit a half-line off the visible text,
// and anything drawn from them looks detached. Reading the rendered pixels is
// the only source of truth for where the text actually is.
function snapBandToInk(band: SelectionRect, canvas: HTMLCanvasElement, canvasRect: DOMRect): SnappedBand {
  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;
  const x0 = Math.max(0, Math.floor((band.left - canvasRect.left) * scaleX));
  const x1 = Math.min(canvas.width, Math.ceil((band.left + band.width - canvasRect.left) * scaleX));
  const y0 = Math.max(0, Math.floor((band.top - canvasRect.top - band.height * INK_SEARCH_ABOVE) * scaleY));
  const y1 = Math.min(
    canvas.height,
    Math.ceil((band.top + band.height * (1 + INK_SEARCH_BELOW) - canvasRect.top) * scaleY)
  );
  if (x1 - x0 < 1 || y1 - y0 < 1) return band;

  let image: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return band;
    image = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  } catch {
    return band; // tainted or zero-sized canvas
  }

  // Group inked rows into runs — one run per line of text in the window
  const runs: { first: number; last: number }[] = [];
  for (let row = 0; row < image.height; row++) {
    let ink = 0;
    for (let col = 0; col < image.width; col++) {
      const i = (row * image.width + col) * 4;
      const luma = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
      if (luma < INK_LUMA) ink++;
    }
    const inked = ink > image.width * INK_ROW_SHARE;
    const open = runs[runs.length - 1];
    if (inked && open && open.last === row - 1) open.last = row;
    else if (inked) runs.push({ first: row, last: row });
  }
  // No ink (blank area, or light text on dark) — keep the text-layer geometry
  if (runs.length === 0) return band;

  // The window reaches into neighbouring lines, so take the run this band
  // actually belongs to — see lib/ink-bands.ts for why overlap decides it
  const bandTop = (band.top - canvasRect.top) * scaleY - y0;
  const bandBottom = (band.top + band.height - canvasRect.top) * scaleY - y0;
  const run = chooseInkRun(runs, bandTop, bandBottom);
  if (!run) return band;

  const inkTop = canvasRect.top + (y0 + run.first) / scaleY;
  const inkHeight = (run.last + 1 - run.first) / scaleY;
  const inkBottom = inkTop + inkHeight;
  // Ignore implausible reads, e.g. a figure bleeding into the search window.
  // The ink is still the best guess at where the letters stop, so an underline
  // can use it even when the wash keeps the text layer's own geometry.
  if (inkHeight > band.height * 1.8 || inkHeight < band.height * 0.25) return { ...band, inkBottom };

  // Ink alone would make a line of lowercase latin a much thinner ribbon than
  // one of CJK, so keep a floor tied to the font's em box and centre it on the
  // glyphs — even bands, still aligned with what's on the page.
  const height = Math.max(inkHeight, band.height * MIN_BAND_RATIO);
  return { ...band, top: inkTop + inkHeight / 2 - height / 2, height, inkBottom };
}

const WHEEL_SENSITIVITY = 0.008;
// Zoom gestures CSS-scale instantly; pages redraw at full resolution after this pause
const DRAWING_DELAY_MS = 250;
const BUTTON_ZOOM_FACTOR = 1.35;

type Props = {
  pdfDataUrl: string;
  onTextSelected: (text: string, pageNumber?: number, occurrence?: number) => void;
  onAskAboutSelection: (text: string, question: string, pageNumber?: number, occurrence?: number) => void;
  onRegionCaptured: (result: RegionResult) => void;
  // `occurrence` is which of the identical passages on that page was selected.
  // Without it a phrase that appears twice — an abstract and a contributions
  // list saying the same words — is always painted on the first one.
  onHighlight?: (text: string, pageNumber?: number, position?: AnnotationPosition, color?: string, occurrence?: number) => void;
  onNote?: (text: string, note: string, pageNumber?: number, position?: AnnotationPosition, color?: string, occurrence?: number) => void;
  onRemoveHighlight?: (id: string) => void;
  onRecolorHighlight?: (id: string, color: string) => void;
  onEditHighlightNote?: (id: string, note: string) => void;
  // Fires alongside the popover, so the Notes panel can reveal the same entry
  onHighlightClick?: (id: string) => void;
  highlights?: Highlight[];
  // Passages you have asked about — marked in the page, not just reachable
  // through the panel's "view in PDF" button
  askedPassages?: AskedPassage[];
  onAskedClick?: (id: string) => void;
  // Re-reads the document from Zotero; absent for materials not stored there
  onReload?: () => void;
  reloading?: boolean;
};

// Zotero-compatible annotation position: PDF-space rects on a zero-based page
export type AnnotationPosition = { pageIndex: number; rects: number[][] };

export type PdfViewerHandle = {
  // Resolves true when the passage was found and lit up, false when only the
  // page could be reached — the caller decides what to say about that
  highlightText: (pageNumber: number, text: string) => boolean | Promise<boolean> | void;
  // Which page a passage is actually on, read from the document's own text.
  // A citation whose page number is wrong is still a citation worth following.
  locateText?: (text: string) => Promise<number | null>;
  // Scrolls a painted highlight into view by id. Resolves false when the mark
  // can't be found, so the caller can fall back to a text search.
  scrollToHighlight?: (id: string, pageNumber?: number) => Promise<boolean>;
  getDocumentText: (maxChars?: number) => Promise<string | null>;
  // Renders pages to JPEG snapshots (for multimodal paper context).
  // Returns [] for page numbers out of range or when no document is loaded.
  renderPageImages?: (pageNumbers: number[], scale?: number) => Promise<{ n: number; dataUrl: string }[]>;
  // Where the reader is in the document, and how to put them back there —
  // what "go back to where I came from" needs from this pane
  getScroll?: () => number;
  setScroll?: (top: number) => void;
};

// Built on the official PDF.js viewer component (the same one Overleaf uses):
// virtualized page rendering, cursor-anchored CSS-first zoom with delayed
// redraw, and a find controller for jump-and-highlight.
export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { pdfDataUrl, onTextSelected, onAskAboutSelection, onRegionCaptured, onHighlight, onNote, onRemoveHighlight, onRecolorHighlight, onEditHighlightNote, onHighlightClick, highlights = [], askedPassages = [], onAskedClick, onReload, reloading },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfJsViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [displayScale, setDisplayScale] = useState(1);
  const [captureMode, setCaptureMode] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; rect: DOMRect } | null>(null);

  const { selection, handleMouseUp, clearSelection } = useTextSelection(containerRef);
  const { isDragging, dragRegion, onMouseDown, onMouseMove, onMouseUp } = useRegionDrag(
    useRef<HTMLCanvasElement>(null)
  );
  const dragPageRef = useRef<HTMLDivElement | null>(null);

  // ── Persistent highlights on the text layer ─────────────────────
  const highlightsRef = useRef<Highlight[]>(highlights);
  highlightsRef.current = highlights;
  const askedRef = useRef<AskedPassage[]>(askedPassages);
  askedRef.current = askedPassages;

  // Highlights are drawn as bands, exactly like the selection — the <mark>
  // elements stay in the text layer only to carry ids and take clicks.
  const [highlightBands, setHighlightBands] = useState<Record<number, HighlightBand[]>>({});

  const paintPageHighlights = useCallback((pageNumber: number) => {
    const container = containerRef.current;
    const pageEl = container?.querySelector(`.page[data-page-number="${pageNumber}"]`);
    const layer = pageEl?.querySelector(".textLayer") as HTMLElement | null;
    if (!container || !pageEl || !layer) return;
    clearMarks(layer, "pr-highlight");
    clearMarks(layer, "pr-asked");
    for (const a of askedRef.current) {
      if (a.pageNumber && a.pageNumber !== pageNumber) continue;
      const cited = a.kind === "cited";
      const title = cited
        ? a.label
          ? `Cited in: ${a.label}`
          : "The model cited this — click to open the answer"
        : a.label
          ? `Asked about: ${a.label}`
          : "You asked about this — click to open the conversation";
      markTextInContainer(layer, a.text, "pr-asked", title, { id: a.id, occurrence: a.occurrence });
    }
    for (const h of highlightsRef.current) {
      if (h.pageNumber && h.pageNumber !== pageNumber) continue;
      const cls = ["pr-highlight", h.note ? "pr-has-note" : ""].filter(Boolean).join(" ");
      markTextInContainer(
        layer,
        h.text,
        cls,
        h.note ? `Note: ${h.note} — click to edit` : "Click to recolour or remove",
        { id: h.id, occurrence: h.occurrence }
      );
    }
    // Everything marked on this page, measured once, from raw geometry.
    //
    // A highlight and a passage with a conversation attached differ in how they
    // are painted — a wash across the words, or a rule under them — and in
    // nothing else. The marks themselves are invisible; they carry ids and take
    // clicks. Each line's text-layer rect is snapped to the ink exactly once,
    // and that one decision moves the marks and places the band together.
    //
    // It used to be two passes: nudge the marks onto the ink, then measure the
    // nudged marks and snap again. A wrong choice in the first pass put the
    // marks squarely on the wrong line's ink, so the second pass confirmed it —
    // the mistake was self-certifying, and everything drawn sat a line low.
    const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement | null;
    const canvasRect = canvas?.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const debug = typeof localStorage !== "undefined" && !!localStorage.getItem("pr-debug-bands");

    const marked = [
      ...highlightsRef.current.map((h) => ({
        id: h.id,
        selector: "pr-highlight",
        color: highlightTint(h.color || DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA),
        underline: false,
      })),
      ...askedRef.current.map((a) => ({
        id: a.id,
        selector: "pr-asked",
        color: a.kind === "cited" ? "var(--quote)" : "var(--accent)",
        underline: true,
      })),
    ];

    // Measure first, all of it, before any mark moves — every rect below is
    // the text layer's own geometry
    type Line = { rect: SelectionRect; marks: HTMLElement[] };
    const measured: { item: (typeof marked)[number]; lines: Line[] }[] = [];
    for (const item of marked) {
      const marks = Array.from(
        layer.querySelectorAll(`mark.${item.selector}[data-highlight-id="${CSS.escape(item.id)}"]`)
      ) as HTMLElement[];
      if (marks.length === 0) continue;
      const lines: Line[] = [];
      for (const mark of marks) {
        const r = mark.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) continue;
        // A passage both highlighted and asked about is wrapped twice; the
        // inner mark rides along with its parent, so only the outer is nudged
        const nested = !!mark.parentElement?.closest("mark.pr-highlight, mark.pr-asked");
        const line = lines.find(
          (l) =>
            Math.abs(r.top + r.height / 2 - (l.rect.top + l.rect.height / 2)) <
            Math.min(r.height, l.rect.height) * 0.5
        );
        if (!line) {
          lines.push({
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            marks: nested ? [] : [mark],
          });
          continue;
        }
        const left = Math.min(line.rect.left, r.left);
        const top = Math.min(line.rect.top, r.top);
        line.rect = {
          left,
          top,
          width: Math.max(line.rect.left + line.rect.width, r.right) - left,
          height: Math.max(line.rect.top + line.rect.height, r.bottom) - top,
        };
        if (!nested) line.marks.push(mark);
      }
      measured.push({ item, lines });
    }

    // Then decide and apply — one snap per line, shared by marks and band
    const bands: HighlightBand[] = [];
    for (const { item, lines } of measured) {
      for (const line of lines) {
        const snapped: SnappedBand = canvas && canvasRect ? snapBandToInk(line.rect, canvas, canvasRect) : line.rect;
        const shift = snapped.top + snapped.height / 2 - (line.rect.top + line.rect.height / 2);
        if (debug) {
          console.log(
            `[pr-band] ${item.underline ? "rule" : "wash"} ${item.id.slice(0, 8)}`,
            { rawTop: +line.rect.top.toFixed(1), rawH: +line.rect.height.toFixed(1), shift: +shift.toFixed(1), inkBottom: snapped.inkBottom && +snapped.inkBottom.toFixed(1) }
          );
        }
        if (Math.abs(shift) >= 0.5) {
          for (const mark of line.marks) {
            mark.style.position = "relative";
            mark.style.top = `${shift.toFixed(1)}px`;
          }
        }
        bands.push({
          id: item.id,
          color: item.color,
          underline: item.underline,
          left: snapped.left - box.left + container.scrollLeft,
          top: snapped.top - box.top + container.scrollTop,
          width: snapped.width,
          height: snapped.height,
          // Where the letters stop, when the pixels could say. The wash can be
          // a little taller than the glyphs without looking wrong; a rule
          // cannot, so it is drawn from this rather than from the band's edge.
          inkBottom:
            snapped.inkBottom === undefined
              ? undefined
              : snapped.inkBottom - box.top + container.scrollTop,
        });
      }
    }
    setHighlightBands((prev) => ({ ...prev, [pageNumber]: bands }));
  }, []);

  // Clicking an existing highlight opens its recolour / remove menu and points
  // the Notes panel at the same entry
  const clickRef = useRef(onHighlightClick);
  useEffect(() => {
    clickRef.current = onHighlightClick;
  }, [onHighlightClick]);
  const askedClickRef = useRef(onAskedClick);
  useEffect(() => {
    askedClickRef.current = onAskedClick;
  }, [onAskedClick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // mouseup rather than click: once pdf.js parks `.endOfContent` over the
    // text layer, the browser stops firing click there entirely — the second
    // click on a highlight never reached us.
    const onMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return; // finishing a drag-select
      const hit = (sel: string) => {
        const direct = (e.target as HTMLElement)?.closest?.(sel) as HTMLElement | null;
        if (direct) return direct;
        // pdf.js parks a page-sized `.endOfContent` div over the text layer
        // once a selection has been made, and it swallows the hit — so look
        // through everything under the pointer, not just the top element.
        return (
          (document
            .elementsFromPoint(e.clientX, e.clientY)
            .map((el) => (el as HTMLElement).closest?.(sel))
            .find(Boolean) as HTMLElement | undefined) ?? null
        );
      };

      const mark = hit("mark.pr-highlight");
      const id = mark?.dataset.highlightId;
      if (!mark || !id) {
        setHighlightMenu(null);
        // A passage you asked about carries a conversation, not a colour — open
        // it rather than the recolour menu. Checked second so a highlight on the
        // same words still wins.
        const asked = hit("mark.pr-asked");
        const askedId = asked?.dataset.highlightId;
        if (askedId) askedClickRef.current?.(askedId);
        return;
      }
      setHighlightMenu({ id, rect: mark.getBoundingClientRect() });
      clickRef.current?.(id);
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Re-paint all currently rendered pages when highlights change
  useEffect(() => {
    containerRef.current?.querySelectorAll(".page[data-page-number]").forEach((page) => {
      paintPageHighlights(parseInt(page.getAttribute("data-page-number")!));
    });
  }, [highlights, askedPassages, paintPageHighlights]);

  // ── Selection ribbon ────────────────────────────────────────────
  // Drawn by us instead of ::selection (see mergeIntoLines). Coordinates are
  // relative to the scroll container's content, so the bands scroll with the
  // pages; they're recomputed on zoom, which moves everything.
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);

  // Bands pulsed briefly after jumping to a passage — the same visual language
  // as the selection, so the reader only ever shows one kind of highlight
  const [flashRects, setFlashRects] = useState<SelectionRect[]>([]);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Snap viewport-space bands onto the glyphs of whichever page they fall on
  const snapBands = useCallback((bands: SelectionRect[]): SelectionRect[] => {
    const container = containerRef.current;
    if (!container) return bands;
    const canvases = Array.from(container.querySelectorAll(".page canvas")).map((c) => ({
      canvas: c as HTMLCanvasElement,
      rect: c.getBoundingClientRect(),
    }));
    return bands.map((band) => {
      const cy = band.top + band.height / 2;
      const cx = band.left + band.width / 2;
      const page = canvases.find(
        ({ rect }) => cy >= rect.top && cy <= rect.bottom && cx >= rect.left && cx <= rect.right
      );
      return page ? snapBandToInk(band, page.canvas, page.rect) : band;
    });
  }, []);

  // Viewport coordinates → the scroll container's content space
  const toContentSpace = useCallback((bands: SelectionRect[]): SelectionRect[] => {
    const container = containerRef.current;
    if (!container) return bands;
    const box = container.getBoundingClientRect();
    return bands.map((b) => ({
      ...b,
      left: b.left - box.left + container.scrollLeft,
      top: b.top - box.top + container.scrollTop,
    }));
  }, []);

  const flashBands = useCallback(
    (clientRects: DOMRect[] | SelectionRect[]) => {
      const bands = mergeIntoLines(
        Array.from(clientRects)
          .filter((r) => r.width > 0.5 && r.height > 0.5)
          .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))
      );
      if (bands.length === 0) return;
      setFlashRects(toContentSpace(snapBands(bands)));
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashRects([]), FLASH_MS);
    },
    [snapBands, toContentSpace]
  );

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const paintSelection = useCallback(() => {
    const container = containerRef.current;
    const sel = window.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelectionRects([]);
      return;
    }
    const anchor = sel.anchorNode;
    const node = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (!node || !container.contains(node)) {
      setSelectionRects([]);
      return;
    }

    // Merge in viewport coordinates, where the page canvases can be consulted,
    // then translate into the scroll container's content space to render
    const bands = mergeIntoLines(
      Array.from(sel.getRangeAt(0).getClientRects())
        .filter((r) => r.width > 0.5 && r.height > 0.5)
        .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))
    );
    setSelectionRects(toContentSpace(snapBands(bands)));
  }, [snapBands, toContentSpace]);

  // selectionchange fires on every mousemove of a drag; one paint per frame
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paintSelection);
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
    };
  }, [paintSelection]);

  // ── Viewer lifecycle ────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setHighlightBands({}); // bands belong to the outgoing document

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PdfJsViewer({ container, eventBus, linkService, findController });
    linkService.setViewer(viewer);
    eventBusRef.current = eventBus;
    viewerRef.current = viewer;

    eventBus.on("pagesinit", () => {
      // Skip if the container has been unmounted/detached (fast paper switch,
      // dev remount) — pdf.js would try to scroll a detached element.
      if (cancelled || !container.isConnected) return;
      viewer.currentScaleValue = "page-width";
    });
    eventBus.on("scalechanging", (e: { scale: number }) => {
      if (cancelled) return;
      setDisplayScale(e.scale);
      // Pages just moved under the bands. The selection can be redrawn at once;
      // highlight bands are cleared and come back with the next text layer,
      // rather than sitting at stale positions through the zoom animation.
      requestAnimationFrame(paintSelection);
      setHighlightBands({});
    });
    // Text layers rebuild on zoom/virtualization — re-paint highlights each time
    eventBus.on("textlayerrendered", (e: { pageNumber: number }) => {
      if (!cancelled) paintPageHighlights(e.pageNumber);
    });

    const loadingTask = getDocument(pdfDataUrl);
    loadingTask.promise.then(
      (pdf) => {
        if (cancelled) return;
        pdfDocRef.current = pdf;
        viewer.setDocument(pdf);
        linkService.setDocument(pdf);
        setNumPages(pdf.numPages);
        setLoadError(false);
      },
      () => { if (!cancelled) setLoadError(true); }
    );

    return () => {
      cancelled = true;
      // Tear the viewer down so no in-flight page setup fires against a
      // detached DOM ("offsetParent is not set" console errors)
      try {
        // pdf.js supports null for teardown; its TS types don't declare it
        viewer.setDocument(null as unknown as PDFDocumentProxy);
        linkService.setDocument(null);
      } catch {
        // viewer may not have received a document yet
      }
      loadingTask.destroy().catch(() => {});
      pdfDocRef.current = null;
      viewerRef.current = null;
      eventBusRef.current = null;
    };
  }, [pdfDataUrl, paintPageHighlights, paintSelection]);

  // ── Zoom ────────────────────────────────────────────────────────
  // pdf.js re-anchors the scroll to the current page on every scale change,
  // which cancels any panning done mid-gesture. We suppress that by doing the
  // cursor-anchored scroll maths ourselves right after the scale is applied,
  // so pinch-zooming and two-finger panning work at the same time.
  const zoomBy = useCallback((factor: number, origin?: [number, number]) => {
    const viewer = viewerRef.current;
    const el = containerRef.current;
    if (!viewer || !el) return;

    const rect = el.getBoundingClientRect();
    const ox = origin ? origin[0] - rect.left : rect.width / 2;
    const oy = origin ? origin[1] - rect.top : rect.height / 2;
    const beforeLeft = el.scrollLeft;
    const beforeTop = el.scrollTop;
    const prevScale = viewer.currentScale;

    viewer.updateScale({ scaleFactor: factor, drawingDelay: DRAWING_DELAY_MS });

    const ratio = viewer.currentScale / prevScale;
    if (Number.isFinite(ratio) && ratio > 0) {
      el.scrollLeft = (beforeLeft + ox) * ratio - ox;
      el.scrollTop = (beforeTop + oy) * ratio - oy;
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * WHEEL_SENSITIVITY), [e.clientX, e.clientY]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const zoomReset = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScaleValue = "page-width";
  }, []);

  // ── Selection → explain / ask ───────────────────────────────────
  const getSelectionPageNumber = useCallback((): number | undefined => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return undefined;
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const page = el?.closest(".page");
    const num = page?.getAttribute("data-page-number");
    return num ? parseInt(num) : undefined;
  }, []);

  const selectionPageRef = useRef<number | undefined>(undefined);
  const selectionPositionRef = useRef<AnnotationPosition | undefined>(undefined);
  const selectionOccurrenceRef = useRef(0);

  // Which of the identical passages on this page the selection sits on,
  // measured against the page's own text layer while the selection still exists
  const computeSelectionOccurrence = useCallback((text: string): number => {
    const sel = window.getSelection();
    const pageNum = selectionPageRef.current;
    if (!sel || sel.rangeCount === 0 || !pageNum || !containerRef.current) return 0;
    const layer = containerRef.current.querySelector(
      `.page[data-page-number="${pageNum}"] .textLayer`
    ) as HTMLElement | null;
    if (!layer) return 0;
    const range = sel.getRangeAt(0);
    return occurrenceAt(layer, text, range.startContainer, range.startOffset);
  }, []);

  // Convert the browser selection's client rects to PDF-space coordinates so
  // highlights can be written back to Zotero as real annotations
  const computeSelectionPosition = useCallback((): AnnotationPosition | undefined => {
    const sel = window.getSelection();
    const pageNum = selectionPageRef.current;
    const viewer = viewerRef.current;
    if (!sel || sel.isCollapsed || !pageNum || !viewer) return undefined;
    const pageView = viewer.getPageView(pageNum - 1) as
      | { viewport?: { convertToPdfPoint: (x: number, y: number) => number[] }; div?: HTMLElement }
      | undefined;
    const wrapper = pageView?.div?.querySelector(".canvasWrapper");
    if (!pageView?.viewport || !wrapper) return undefined;
    const pageRect = wrapper.getBoundingClientRect();
    const rects: number[][] = [];
    for (const r of Array.from(sel.getRangeAt(0).getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const [ax, ay] = pageView.viewport.convertToPdfPoint(r.left - pageRect.left, r.bottom - pageRect.top);
      const [bx, by] = pageView.viewport.convertToPdfPoint(r.right - pageRect.left, r.top - pageRect.top);
      rects.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]);
    }
    return rects.length ? { pageIndex: pageNum - 1, rects } : undefined;
  }, []);

  useEffect(() => {
    if (selection) {
      selectionPageRef.current = getSelectionPageNumber();
      selectionPositionRef.current = computeSelectionPosition();
      selectionOccurrenceRef.current = computeSelectionOccurrence(selection.text);
    }
  }, [selection, getSelectionPageNumber, computeSelectionPosition, computeSelectionOccurrence]);

  const handleExplain = useCallback(() => {
    if (selection) {
      onTextSelected(selection.text, selectionPageRef.current, selectionOccurrenceRef.current);
      clearSelection();
    }
  }, [selection, onTextSelected, clearSelection]);

  const handleAsk = useCallback(
    (question: string) => {
      if (selection) {
        onAskAboutSelection(selection.text, question, selectionPageRef.current, selectionOccurrenceRef.current);
        clearSelection();
      }
    },
    [selection, onAskAboutSelection, clearSelection]
  );

  const handleHighlight = useCallback(
    (color: string) => {
      if (selection && onHighlight) {
        onHighlight(selection.text, selectionPageRef.current, selectionPositionRef.current, color, selectionOccurrenceRef.current);
        clearSelection();
      }
    },
    [selection, onHighlight, clearSelection]
  );

  const handleNote = useCallback(
    (note: string, color: string) => {
      if (selection && onNote) {
        onNote(selection.text, note, selectionPageRef.current, selectionPositionRef.current, color, selectionOccurrenceRef.current);
        clearSelection();
      }
    },
    [selection, onNote, clearSelection]
  );

  // ── Figure region capture ───────────────────────────────────────
  const findPageParts = useCallback((target: EventTarget | null) => {
    const el = target instanceof Element ? target : null;
    const page = el?.closest(".page") as HTMLDivElement | null;
    // canvasWrapper exactly matches the canvas, so coordinate math is exact
    const wrapper = page?.querySelector(".canvasWrapper") as HTMLDivElement | null;
    const canvas = wrapper?.querySelector("canvas") as HTMLCanvasElement | null;
    return canvas && wrapper ? { canvas, wrapper } : null;
  }, []);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    const parts = findPageParts(e.target);
    if (!parts) return;
    if (captureMode) e.preventDefault();
    onMouseDown(e, parts.canvas, parts.wrapper, captureMode);
    dragPageRef.current = parts.wrapper;
  }, [findPageParts, onMouseDown, captureMode]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragPageRef.current) onMouseMove(e, dragPageRef.current);
  }, [isDragging, onMouseMove]);

  const handleContainerMouseUp = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragPageRef.current) {
      const wrapper = dragPageRef.current;
      const canvas = wrapper.querySelector("canvas") as HTMLCanvasElement | null;
      if (canvas) {
        onMouseUp(e, canvas, wrapper, (result) => {
          setCaptureMode(false);
          onRegionCaptured(result);
        });
      }
      dragPageRef.current = null;
      return;
    }
    handleMouseUp();
  }, [isDragging, onMouseUp, onRegionCaptured, handleMouseUp]);

  // Viewport position of the drag rectangle (dragRegion is page-relative)
  const dragRect = (() => {
    if (!isDragging || !dragRegion || !dragPageRef.current) return null;
    const pageRect = dragPageRef.current.getBoundingClientRect();
    return {
      left: pageRect.left + dragRegion.x,
      top: pageRect.top + dragRegion.y,
      width: dragRegion.width,
      height: dragRegion.height,
    };
  })();

  // ── Imperative handle ───────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    getScroll: () => containerRef.current?.scrollTop ?? 0,
    setScroll: (top: number) => containerRef.current?.scrollTo({ top, behavior: "smooth" }),
    // Jumps to a passage by searching the page's text layer ourselves. pdf.js's
    // find controller used to do this, but it paints its own per-span highlight
    // — a second, ragged highlight style on top of ours — and its matching
    // fails on CJK for the same whitespace reasons ours once did.
    async highlightText(pageNumber: number, text: string): Promise<boolean> {
      const viewer = viewerRef.current;
      const container = containerRef.current;
      if (!viewer || !container || !text.trim()) return false;
      if (pageNumber >= 1 && pageNumber <= viewer.pagesCount) {
        viewer.currentPageNumber = pageNumber;
      }
      for (let attempt = 0; attempt < 25; attempt++) {
        const layer = container.querySelector(
          `.page[data-page-number="${pageNumber}"] .textLayer`
        ) as HTMLElement | null;
        const range = layer ? rangeForText(layer, text) : null;
        if (range) {
          const rects: DOMRect[] = Array.from(range.getClientRects());
          const first = rects.find((r) => r.width > 0.5 && r.height > 0.5);
          if (first) {
            const target = container.querySelector(
              `.page[data-page-number="${pageNumber}"]`
            ) as HTMLElement | null;
            const box = container.getBoundingClientRect();
            container.scrollTo({
              top: container.scrollTop + (first.top - box.top) - container.clientHeight / 2,
              behavior: target ? "smooth" : "auto",
            });
            flashBands(rects);
          }
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return false;
    },

    // Scans the document's own text rather than the rendered layers: only a
    // few pages are ever rendered, so anything else would miss.
    async locateText(text: string): Promise<number | null> {
      const doc = pdfDocRef.current;
      if (!doc || !text.trim()) return null;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        if (findIgnoringWhitespace(pageText, text)) return p;
      }
      return null;
    },

    // Jumps to the exact passage rather than the top of its page: the painted
    // <mark> already sits at the right spot, so scroll to that. The page has to
    // be brought into view first for its text layer to exist at all.
    async scrollToHighlight(id: string, pageNumber?: number) {
      const viewer = viewerRef.current;
      const container = containerRef.current;
      if (!viewer || !container) return false;
      const selector = `mark.pr-highlight[data-highlight-id="${CSS.escape(id)}"]`;

      if (!container.querySelector(selector) && pageNumber && pageNumber >= 1 && pageNumber <= viewer.pagesCount) {
        viewer.currentPageNumber = pageNumber;
      }
      // Text layers render asynchronously after a page change
      for (let attempt = 0; attempt < 25; attempt++) {
        const marks = Array.from(container.querySelectorAll(selector)) as HTMLElement[];
        if (marks.length > 0) {
          marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
          flashBands(marks.map((m) => m.getBoundingClientRect()));
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return false;
    },

    async getDocumentText(maxChars = 60000) {
      const doc = pdfDocRef.current;
      if (!doc) return null;
      let text = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\u0000/g, " ")
          .replace(/\s+/g, " ");
        text += `\n\n[page ${p}]\n${pageText}`;
        if (text.length >= maxChars) break;
      }
      return text.slice(0, maxChars);
    },

    async renderPageImages(pageNumbers: number[], scale = 1.35) {
      const doc = pdfDocRef.current;
      if (!doc) return [];
      const out: { n: number; dataUrl: string }[] = [];
      for (const n of pageNumbers) {
        if (n < 1 || n > doc.numPages) continue;
        try {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          out.push({ n, dataUrl: canvas.toDataURL("image/jpeg", 0.75) });
        } catch {
          // page render failed — skip it
        }
      }
      return out;
    },
  }));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
        <span className="pill-group">
        <button onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)} className="btn-icon w-6 h-6 text-base leading-none" title="Zoom out (⌘/Ctrl+scroll or pinch)">−</button>
        <button onClick={zoomReset} className="btn-icon px-2 py-0.5 text-xs min-w-[44px] text-center tabular-nums" title="Fit page width">
          {Math.round(displayScale * 100)}%
        </button>
        <button onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)} className="btn-icon w-6 h-6 text-base leading-none" title="Zoom in (⌘/Ctrl+scroll or pinch)">+</button>
        </span>

        <button
          onClick={() => setCaptureMode((v) => !v)}
          className="text-xs px-2.5 py-1 rounded-full transition-all"
          style={captureMode
            ? { background: "linear-gradient(180deg, var(--accent-bright), var(--accent))", color: "#fff", boxShadow: "0 1px 6px rgba(232,120,76,0.4)" }
            : { border: "1px solid var(--border)", color: "var(--ink-muted)" }}
          title="Capture a figure or graph: click, then drag over the region (or ⌥ Option + drag anytime)"
        >
          ✂ Capture figure
        </button>
        {captureMode && (
          <span className="text-[11px] pr-fade-up" style={{ color: "var(--accent)" }}>drag over a region…</span>
        )}

        {onReload && (
          <button
            onClick={onReload}
            disabled={reloading}
            className="btn-icon w-7 h-7 text-sm leading-none"
            style={reloading ? { opacity: 0.5 } : undefined}
            title="Reload this document and its annotations from Zotero"
          >
            <span className={reloading ? "pr-spin inline-block" : "inline-block"}>↻</span>
          </button>
        )}

        {numPages > 0 && (
          <span
            className="ml-auto text-[11px] tabular-nums px-2 py-0.5 rounded-full"
            style={{ color: "var(--ink-faint)", border: "1px solid var(--border-light)" }}
          >
            {numPages} pages
          </span>
        )}
      </div>

      {/* Viewer */}
      <div className="flex-1 relative" style={{ background: "var(--parchment)" }}>
        {highlightMenu && (() => {
          const h = highlights.find((x) => x.id === highlightMenu.id);
          return (
            <HighlightPopover
              rect={highlightMenu.rect}
              color={h?.color}
              note={h?.note}
              onRecolor={(c) => { onRecolorHighlight?.(highlightMenu.id, c); setHighlightMenu(null); }}
              onEditNote={(n) => { onEditHighlightNote?.(highlightMenu.id, n); setHighlightMenu(null); }}
              onRemove={() => { onRemoveHighlight?.(highlightMenu.id); setHighlightMenu(null); }}
              onDismiss={() => setHighlightMenu(null)}
            />
          );
        })()}

        {selection && !isDragging && (
          <SelectionPopover
            rect={selection.rect}
            selectedText={selection.text}
            onExplain={handleExplain}
            onAsk={handleAsk}
            onHighlight={handleHighlight}
            onNote={handleNote}
            onDismiss={clearSelection}
          />
        )}

        {dragRect && (
          <div
            style={{
              position: "fixed",
              ...dragRect,
              border: "2px dashed var(--accent)",
              background: "rgba(232,120,76,0.08)",
              pointerEvents: "none",
              zIndex: 40,
            }}
          />
        )}

        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: "#F87171" }}>
            Failed to load PDF
          </div>
        )}

        <div
          ref={containerRef}
          className="absolute inset-0 overflow-auto"
          style={{ cursor: captureMode || isDragging ? "crosshair" : "default" }}
          onMouseDown={handleContainerMouseDown}
          onMouseMove={handleContainerMouseMove}
          onMouseUp={handleContainerMouseUp}
        >
          <div className="pdfViewer" />
          {/* One band, two ways of painting it: a rule under the words, or a
              wash across them. Nothing else differs. */}
          {Object.values(highlightBands).flat().map((b, i) =>
            b.underline ? (
              <div
                key={`ask-${b.id}-${i}`}
                className="pr-band pr-asked-rule"
                style={{ left: b.left, top: (b.inkBottom ?? b.top + b.height) + 1, width: b.width, height: 2, background: b.color }}
              />
            ) : (
              <div
                key={`hl-${b.id}-${i}`}
                className="pr-band"
                style={{ left: b.left, top: b.top - SELECTION_PAD, width: b.width, height: b.height + SELECTION_PAD * 2, background: b.color }}
              />
            )
          )}
          {selectionRects.map((r, i) => (
            <div
              key={i}
              className="pr-band pr-selection"
              style={{
                left: r.left,
                top: r.top - SELECTION_PAD,
                width: r.width,
                height: r.height + SELECTION_PAD * 2,
              }}
            />
          ))}
          {flashRects.map((r, i) => (
            <div
              key={`flash-${i}`}
              className="pr-band pr-selection pr-flash"
              style={{
                left: r.left,
                top: r.top - SELECTION_PAD,
                width: r.width,
                height: r.height + SELECTION_PAD * 2,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
