"use client";
import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFViewer as PdfJsViewer, PDFLinkService, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { SelectionPopover } from "./SelectionPopover";
import { CollectionChip } from "./CollectionChip";
import { loadReadingPosition, saveReadingPosition } from "@/lib/reading-position";
import { useTextSelection } from "@/hooks/useTextSelection";
import { useRegionDrag } from "@/hooks/useRegionDrag";
import { RegionResult } from "@/hooks/useRegionDrag";
import { markTextInContainer, clearMarks, rangeForText, findIgnoringWhitespace, occurrenceAt } from "@/lib/highlight-dom";
import { chooseInkRun, mergeIntoLines, nearestInkRun, nearestStoredLine, relativeToPage, type InkRun } from "@/lib/ink-bands";
import { logicalSelectionBands } from "@/lib/selection-geometry";
import { alignRectsToZoteroLines, type PdfTextItem, type PdfTextStyle } from "@/lib/zotero-selection-geometry";
import {
  buildPdfSelectionModel,
  hitTestPdfSelection,
  pdfSelectionRange,
  type PdfSelectionModel,
  type PdfSelectionRange,
} from "@/lib/pdf-selection-model";
import { alignReferenceLink, referenceRectFractions } from "@/lib/pdf-reference-geometry";
import { verticalNudge, horizontalNudge } from "@/lib/text-layer-calibration";
import { highlightTint, DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import { isHighlightDeleteKey, isTextEditingTarget } from "@/lib/keys";
import { nextZoomFrameScale, wheelDeltaPixels, wheelZoomTarget } from "@/lib/pdf-zoom";
import { HighlightPopover } from "./HighlightPopover";
import type { Highlight } from "@/types/session";

type PageTextContent = {
  items: Array<PdfTextItem | { type: string; id: string }>;
  styles: Record<string, PdfTextStyle>;
};

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

// Viewport-space padding used only by the brief jump-to-passage flash.
const SELECTION_PAD = 1.5;

type SelectionRect = { left: number; top: number; width: number; height: number };

// A band that has been matched to the glyphs, carrying where the ink actually
// ended. A wash can be a little taller than the letters without looking wrong,
// but a rule drawn under the band's own bottom edge lands wherever the text
// layer's box happens to end — and pdf.js boxes reach down into the following
// line, which is how an underline came to sit beneath the wrong sentence.
type SnappedBand = SelectionRect & { inkBottom?: number; inkFound?: boolean };

// A pixel counts as ink below this luminance
const INK_LUMA = 150;
// A row is part of a glyph line once this share of it is ink
const INK_ROW_SHARE = 0.015;
// How far above/below a text-layer box to look for the glyphs it stands for
const INK_SEARCH_ABOVE = 1.0;
const INK_SEARCH_BELOW = 0.5;
// Floor on band height, as a share of the text-layer box (i.e. the font size).
// Raster ink is thinner than the typographic glyph box; retaining almost all
// of the box makes Zotero's stored rectangle cover ascenders and descenders.
const MIN_BAND_RATIO = 0.96;
// How long a jumped-to passage stays lit
const FLASH_MS = 1600;
// Zotero draws its annotations with globalAlpha 0.5 and multiply blending
const HIGHLIGHT_ALPHA = 0.5;

type HighlightBand = SelectionRect & { id: string; color: string; underline?: boolean; inkBottom?: number };

type ReferenceLinkBand = SelectionRect & {
  id: string;
  destination?: string | unknown[];
  url?: string;
  label: string;
  reference: boolean;
};

type PdfLinkAnnotation = {
  id: string;
  subtype: string;
  rect: number[];
  dest?: string | unknown[];
  url?: string;
  overlaidText?: string;
};

type ReferencePreviewData = {
  imageUrl: string;
  pageNumber: number;
};

type ReferencePreviewState = {
  anchor: DOMRect;
  destination: string;
  label: string;
  loading: boolean;
  data?: ReferencePreviewData;
  error?: string;
};

// Persistent annotations live inside the PDF page itself, in fractions of its
// width/height. PDF.js can CSS-scale the page immediately and redraw it later;
// the annotation and canvas therefore move as one object with no pixel-space
// repaint race during zoom.
function renderPageBands(wrapper: HTMLElement, bands: HighlightBand[]) {
  let overlay = Array.from(wrapper.children).find((el) => el.classList.contains("pr-page-bands")) as
    | HTMLDivElement
    | undefined;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pr-page-bands";
    overlay.setAttribute("aria-hidden", "true");
    wrapper.appendChild(overlay);
  }

  const fragment = document.createDocumentFragment();
  for (const band of bands) {
    const el = document.createElement("div");
    el.dataset.highlightId = band.id;
    el.className = band.underline ? "pr-band pr-asked-rule" : "pr-band";
    const pad = band.underline ? 0 : band.height * 0.16;
    const top = band.underline
      ? (band.inkBottom ?? band.top + band.height) + band.height * 0.1
      : band.top - pad;
    const height = band.underline ? band.height * 0.14 : band.height + pad * 2;
    Object.assign(el.style, {
      left: `${band.left * 100}%`,
      top: `${top * 100}%`,
      width: `${band.width * 100}%`,
      height: `${height * 100}%`,
      background: band.color,
    });
    fragment.appendChild(el);
  }
  overlay.replaceChildren(fragment);
}

// The live browser selection belongs to the PDF page for the same reason a
// saved annotation does. Keeping it in page-relative coordinates means CSS
// zoom scales the canvas and ribbon as one object; no viewport-pixel repaint
// can race PDF.js's delayed canvas/text-layer rebuild.
function renderPageSelection(wrapper: HTMLElement, bands: SelectionRect[]) {
  let overlay = Array.from(wrapper.children).find((el) => el.classList.contains("pr-page-selection")) as
    | HTMLDivElement
    | undefined;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pr-page-selection";
    overlay.setAttribute("aria-hidden", "true");
    wrapper.appendChild(overlay);
  }

  const fragment = document.createDocumentFragment();
  for (const band of bands) {
    const el = document.createElement("div");
    el.className = "pr-band pr-selection";
    const pad = band.height * 0.14;
    Object.assign(el.style, {
      left: `${band.left * 100}%`,
      top: `${(band.top - pad) * 100}%`,
      width: `${band.width * 100}%`,
      height: `${(band.height + pad * 2) * 100}%`,
    });
    fragment.appendChild(el);
  }
  overlay.replaceChildren(fragment);
}

function renderPageReferenceLinks(
  wrapper: HTMLElement,
  bands: ReferenceLinkBand[],
  onEnter: (band: ReferenceLinkBand, anchor: DOMRect) => void,
  onLeave: () => void,
  onOpen: (band: ReferenceLinkBand) => void
) {
  let overlay = Array.from(wrapper.children).find((el) => el.classList.contains("pr-page-reference-links")) as
    | HTMLDivElement
    | undefined;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pr-page-reference-links";
    overlay.setAttribute("aria-label", "References on this page");
    wrapper.appendChild(overlay);
  }

  const fragment = document.createDocumentFragment();
  for (const band of bands) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pr-reference-link";
    button.dataset.annotationId = band.id;
    if (typeof band.destination === "string") button.dataset.destination = band.destination;
    button.setAttribute(
      "aria-label",
      band.reference ? `Preview reference ${band.label || "citation"}` : `Open PDF link ${band.label || ""}`
    );
    button.title = band.reference ? `Preview ${band.label || "reference"}` : `Open ${band.label || "link"}`;
    Object.assign(button.style, {
      left: `${band.left * 100}%`,
      top: `${band.top * 100}%`,
      width: `${band.width * 100}%`,
      height: `${band.height * 100}%`,
    });
    if (band.reference) {
      button.addEventListener("pointerenter", () => onEnter(band, button.getBoundingClientRect()));
      button.addEventListener("pointerleave", onLeave);
      button.addEventListener("focus", () => onEnter(band, button.getBoundingClientRect()));
      button.addEventListener("blur", onLeave);
    }
    button.addEventListener("mousedown", (event) => {
      // This target sits above the PDF text layer. Do not let its click begin a
      // text selection in the viewer underneath it.
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpen(band);
    });
    fragment.appendChild(button);
  }
  overlay.replaceChildren(fragment);
}

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
  // Where it sits, recorded when it was selected; see Highlight
  position?: AnnotationPosition;
};

// Snaps a selection band to the glyphs it covers.
//
// pdf.js positions its text layer with the browser's fallback fonts
// (font-family: sans-serif/monospace on every span), while the page canvas is
// drawn with the PDF's embedded fonts. When their metrics disagree — routinely,
// for CJK documents — the invisible boxes sit a half-line off the visible text,
// and anything drawn from them looks detached. Reading the rendered pixels is
// the only source of truth for where the text actually is.
function snapBandToInk(
  band: SelectionRect,
  canvas: HTMLCanvasElement,
  canvasRect: DOMRect,
  calibratedSelection = false
): SnappedBand {
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
  // A fresh selection comes from spans already calibrated onto the page, so
  // nearest centre preserves its line. Legacy text matches can still carry the
  // old downward drift and retain the directional chooseInkRun fallback.
  const run = calibratedSelection
    ? nearestInkRun(runs, bandTop, bandBottom)
    : chooseInkRun(runs, bandTop, bandBottom);
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
  return { ...band, top: inkTop + inkHeight / 2 - height / 2, height, inkBottom, inkFound: true };
}

// Zoom gestures CSS-scale instantly; pages redraw at full resolution after this pause
const DRAWING_DELAY_MS = 250;
const BUTTON_ZOOM_FACTOR = 1.2;
// These are PDF.js's own scale limits. Keeping the animation target inside the
// same range prevents it from chasing a value the viewer can never reach.
const PDF_MIN_SCALE = 0.1;
const PDF_MAX_SCALE = 10;

type Props = {
  pdfDataUrl: string;
  onTextSelected: (text: string, pageNumber?: number, occurrence?: number, position?: AnnotationPosition) => void;
  onAskAboutSelection: (text: string, question: string, pageNumber?: number, occurrence?: number, position?: AnnotationPosition) => void;
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
  // Zotero item key for the open paper — names its collection in the toolbar
  zoteroKey?: string;
  onRevealCollection?: (collectionKey: string) => void;
  // Identity to remember scroll offset and zoom against. Absent means this
  // document is not worth resuming (a preview, a one-off render).
  positionKey?: string;
};

// Zotero-compatible annotation position: PDF-space rects on a zero-based page
export type AnnotationPosition = { pageIndex: number; rects: number[][] };

type SelectionPageEntry = {
  pageNumber: number;
  layer: HTMLElement;
  spans: Array<HTMLElement | null>;
  model: PdfSelectionModel;
};

type ActivePdfSelection = {
  entry: SelectionPageEntry;
  anchorBoundary: number;
  focusBoundary: number;
};

type ControlledPdfSelection = {
  pageNumber: number;
  position: AnnotationPosition;
  range: PdfSelectionRange;
  text: string;
};

type PdfPageView = {
  viewport?: {
    width: number;
    height: number;
    convertToPdfPoint: (x: number, y: number) => number[];
    convertToViewportPoint: (x: number, y: number) => number[];
  };
  div?: HTMLElement;
  _textHighlighter?: {
    textDivs?: HTMLElement[];
    textContentItemsStr?: string[];
  };
};

function textPointAtOffset(root: HTMLElement, wantedOffset: number): [Node, number] | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = wantedOffset;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }
  return last ? [last, last.data.length] : null;
}

function itemBoundaryFractions(span: HTMLElement | null, text: string): number[] | undefined {
  if (!span?.isConnected || !text) return undefined;
  const offsets = [0];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    offsets.push(offset);
  }
  const start = textPointAtOffset(span, 0);
  if (!start) return undefined;
  const widths: number[] = [];
  for (const endOffset of offsets) {
    const end = textPointAtOffset(span, endOffset);
    if (!end) return undefined;
    const range = document.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    widths.push(range.getBoundingClientRect().width);
  }
  return widths[widths.length - 1] > 0 ? widths : undefined;
}

function selectionBoundaryPoint(entry: SelectionPageEntry, boundary: number): [Node, number] | null {
  const characters = entry.model.characters;
  if (!characters.length) return null;
  const bounded = Math.min(characters.length, Math.max(0, boundary));

  // An insertion point normally belongs to the character on its right. If
  // that PDF item has no DOM span (empty/unattached items are legal), walk to
  // the nearest connected item without changing the PDF boundary itself.
  for (let index = bounded; index < characters.length; index++) {
    const character = characters[index];
    const span = entry.spans[character.itemIndex];
    const point = span && textPointAtOffset(span, character.startOffset);
    if (point) return point;
  }
  for (let index = Math.min(bounded - 1, characters.length - 1); index >= 0; index--) {
    const character = characters[index];
    const span = entry.spans[character.itemIndex];
    const point = span && textPointAtOffset(span, character.endOffset);
    if (point) return point;
  }
  return null;
}

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
  { pdfDataUrl, onTextSelected, onAskAboutSelection, onRegionCaptured, onHighlight, onNote, onRemoveHighlight, onRecolorHighlight, onEditHighlightNote, onHighlightClick, highlights = [], askedPassages = [], onAskedClick, onReload, reloading, zoteroKey, onRevealCollection, positionKey },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfJsViewer | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const textContentCacheRef = useRef<Map<number, Promise<PageTextContent>>>(new Map());
  const selectionPageCacheRef = useRef<Map<number, SelectionPageEntry>>(new Map());
  const referenceModelCacheRef = useRef<Map<number, Promise<PdfSelectionModel>>>(new Map());
  const linkAnnotationCacheRef = useRef<Map<number, Promise<PdfLinkAnnotation[]>>>(new Map());
  const referencePreviewCacheRef = useRef<Map<string, Promise<ReferencePreviewData | null>>>(new Map());
  const selectionPreparationJobsRef = useRef<Map<number, () => void>>(new Map());
  const referenceHoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoveredReferenceRef = useRef<string | null>(null);
  const activePdfSelectionRef = useRef<ActivePdfSelection | null>(null);
  const controlledPdfSelectionRef = useRef<ControlledPdfSelection | null>(null);
  const zoomPercentRef = useRef<HTMLButtonElement>(null);
  const zoomFrameRef = useRef(0);
  const zoomTargetScaleRef = useRef<number | null>(null);
  const zoomOriginRef = useRef<[number, number] | undefined>(undefined);
  const zoomLabelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectionPaintFrameRef = useRef(0);

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [displayScale, setDisplayScale] = useState(1);
  // Read inside the long-lived viewer effect, which must not re-run when the
  // open document changes identity
  const positionKeyRef = useRef(positionKey);
  useEffect(() => { positionKeyRef.current = positionKey; }, [positionKey]);
  const recordPositionRef = useRef<(() => void) | null>(null);
  const [captureMode, setCaptureMode] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [referencePreview, setReferencePreview] = useState<ReferencePreviewState | null>(null);

  const {
    selection,
    setSelectionInfo,
    handleMouseUp: handleNativeMouseUp,
    clearSelection: clearNativeSelection,
  } = useTextSelection(containerRef);
  const { isDragging, dragRegion, onMouseDown, onMouseMove, onMouseUp } = useRegionDrag(
    useRef<HTMLCanvasElement>(null)
  );
  const dragPageRef = useRef<HTMLDivElement | null>(null);

  // ── Persistent highlights on the text layer ─────────────────────
  const highlightsRef = useRef<Highlight[]>(highlights);
  highlightsRef.current = highlights;
  const askedRef = useRef<AskedPassage[]>(askedPassages);
  askedRef.current = askedPassages;

  // ── Text-layer calibration ──────────────────────────────────────
  // Some PDFs' text layers ride off the printed glyphs (old Type 1 fonts,
  // metrics pdf.js has to guess), and the error is per-span — one span half a
  // line low while its neighbour sits high. The browser hit-tests against the
  // layer, so selection, copy and clicks all lie with it: sweeping the upper
  // half of a printed line selects the line above. Each span is measured
  // against the rendered ink and nudged onto it, vertically and horizontally,
  // before anything is painted. Spans of a metrically clean PDF measure ~0 and
  // are left untouched.
  const paintPageRef = useRef<((n: number, allowCalibration?: boolean) => void) | null>(null);

  const calibrateTextLayer = useCallback((layer: HTMLElement, pageEl: Element, pageNumber: number) => {
    const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const key = String(viewerRef.current?.currentScale ?? 1);
    if (layer.dataset.prCalibrated === key) return;
    // Embedded fonts still loading means the span geometry is about to change
    // under us — measure once they settle
    if (typeof document !== "undefined" && document.fonts && document.fonts.status !== "loaded") {
      document.fonts.ready.then(() => {
        delete layer.dataset.prCalibrated;
        paintPageRef.current?.(pageNumber, true);
      });
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    if (canvasRect.width === 0) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let image: ImageData;
    try {
      image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      return; // tainted or unfinished canvas — nothing to measure against
    }

    const W = image.width;
    const data = image.data;
    const inkAt = (row: number, col: number) => {
      const at = (row * W + col) * 4;
      return 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2] < INK_LUMA;
    };
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;

    // pdf.js positions spans in % of the layer (older versions used px);
    // a nudge in css px is converted to whichever unit the span speaks
    const layerRect = layer.getBoundingClientRect();
    const shiftBy = (el: HTMLElement, prop: "top" | "left", deltaPx: number, base: number) => {
      const value = el.style[prop];
      if (value.endsWith("px")) el.style[prop] = `${(parseFloat(value) + deltaPx).toFixed(2)}px`;
      else if (value.endsWith("%")) el.style[prop] = `${(parseFloat(value) + (deltaPx / base) * 100).toFixed(4)}%`;
    };
    const adjustable = (v: string) => v.endsWith("px") || v.endsWith("%");

    // PDF.js reuses the same spans when the scale changes. Always measure a
    // zoom level from PDF.js's original coordinates, not from the correction
    // applied at the previous scale, or small rounding errors accumulate until
    // the selectable layer and its highlights drift away from the page.
    const spans = Array.from(layer.querySelectorAll("span")) as HTMLElement[];
    for (const span of spans) {
      if (span.dataset.prOriginalTop === undefined) {
        span.dataset.prOriginalTop = span.style.top;
        span.dataset.prOriginalLeft = span.style.left;
      } else {
        span.style.top = span.dataset.prOriginalTop;
        span.style.left = span.dataset.prOriginalLeft ?? span.style.left;
      }
    }

    let sawInk = false;
    let nudged = 0;
    const magnitudes: number[] = [];
    for (const span of spans) {
      if (!(span.textContent || "").trim()) continue;
      if (!adjustable(span.style.top) || !adjustable(span.style.left)) continue;
      const r = span.getBoundingClientRect();
      if (r.width < 8 || r.height < 4) continue;
      const x0 = Math.max(0, Math.floor((r.left - canvasRect.left) * scaleX));
      const x1 = Math.min(canvas.width, Math.ceil((r.right - canvasRect.left) * scaleX));
      const yTop = (r.top - canvasRect.top) * scaleY;
      const yBot = (r.bottom - canvasRect.top) * scaleY;
      const h = yBot - yTop;
      const y0 = Math.max(0, Math.floor(yTop - h * 0.8));
      const y1 = Math.min(canvas.height, Math.ceil(yBot + h * 0.8));
      if (x1 - x0 < 8 || y1 - y0 < 4) continue;

      const runs: InkRun[] = [];
      for (let row = y0; row < y1; row++) {
        let ink = 0;
        for (let col = x0; col < x1; col++) if (inkAt(row, col)) ink++;
        const inked = ink > (x1 - x0) * INK_ROW_SHARE;
        const open = runs[runs.length - 1];
        if (inked && open && open.last === row - 1) open.last = row;
        else if (inked) runs.push({ first: row, last: row });
      }
      if (runs.length > 0) sawInk = true;
      const dyCanvas = verticalNudge(runs, yTop, yBot, h * 0.55);
      if (dyCanvas === null) continue;

      // The run it belongs to, for the horizontal extent of its own line
      const centre = (yTop + yBot) / 2 + dyCanvas;
      const own = runs.reduce((best, run) =>
        Math.abs((run.first + run.last + 1) / 2 - centre) < Math.abs((best.first + best.last + 1) / 2 - centre) ? run : best
      );
      const hx0 = Math.max(0, Math.floor(x0 - h));
      const hx1 = Math.min(canvas.width, Math.ceil(x1 + h));
      let inkLeft: number | null = null;
      let inkRight: number | null = null;
      for (let col = hx0; col < hx1; col++) {
        let hit = false;
        for (let row = own.first; row <= own.last; row++) if (inkAt(row, col)) { hit = true; break; }
        if (hit) {
          if (inkLeft === null) inkLeft = col;
          inkRight = col + 1;
        }
      }
      const dxCanvas = horizontalNudge(x0, x1, inkLeft, inkRight, h);

      const dy = dyCanvas / scaleY;
      const dx = dxCanvas === null ? 0 : dxCanvas / scaleX;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
      if (Math.abs(dy) >= 1) shiftBy(span, "top", dy, layerRect.height);
      if (Math.abs(dx) >= 1) shiftBy(span, "left", dx, layerRect.width);
      nudged++;
      magnitudes.push(Math.max(Math.abs(dy), Math.abs(dx)));
    }
    // textlayerrendered may beat pagerendered during zoom. A blank canvas is
    // not a successful calibration: leave the key unset so the later canvas
    // event gets a real attempt instead of accepting zero corrections forever.
    if (sawInk) layer.dataset.prCalibrated = key;
    else delete layer.dataset.prCalibrated;
    if (nudged > 3) {
      const median = magnitudes.sort((a, b) => a - b)[Math.floor(magnitudes.length / 2)].toFixed(1);
      console.info(
        `[paper-reader] page ${pageNumber}: aligned ${nudged} text spans onto their glyphs (median ${median}px) — this PDF's selectable text sits off its print`
      );
    }
  }, []);

  const paintPageHighlights = useCallback((pageNumber: number, allowCalibration = false) => {
    const container = containerRef.current;
    const pageEl = container?.querySelector(`.page[data-page-number="${pageNumber}"]`);
    const layer = pageEl?.querySelector(".textLayer") as HTMLElement | null;
    if (!container || !pageEl || !layer) return;
    // During delayed zoom PDF.js hides and reuses the text layer. Its marks
    // have zero-sized client rects in that window; repainting from them would
    // replace valid bands with an empty page and leave the highlight missing.
    if (layer.hidden) return;
    const pageHighlights = highlightsRef.current.filter(
      (highlight) => !highlight.pageNumber || highlight.pageNumber === pageNumber
    );
    const pageAsked = askedRef.current.filter(
      (passage) => !passage.pageNumber || passage.pageNumber === pageNumber
    );
    const wrapper = pageEl.querySelector(".canvasWrapper") as HTMLElement | null;
    if (pageHighlights.length === 0 && pageAsked.length === 0) {
      clearMarks(layer, "pr-highlight");
      clearMarks(layer, "pr-asked");
      if (wrapper) renderPageBands(wrapper, []);
      return;
    }

    // Stored PDF rectangles need neither raster inspection nor calibrated DOM
    // metrics. The expensive full-canvas pass is reserved for old records that
    // have no PDF position, and only after the page canvas has finished.
    const needsLegacyCalibration = [...pageHighlights, ...pageAsked].some((item) => !item.position);
    if (allowCalibration && needsLegacyCalibration) {
      calibrateTextLayer(layer, pageEl, pageNumber);
    }
    clearMarks(layer, "pr-highlight");
    clearMarks(layer, "pr-asked");
    for (const a of pageAsked) {
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
    for (const h of pageHighlights) {
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
    const debug = typeof localStorage !== "undefined" && !!localStorage.getItem("pr-debug-bands");

    // Stored geometry, when a record carries it: the position was written down
    // at selection time (or came with the Zotero annotation), in PDF space.
    // Converted through the current viewport it is exact at any zoom, and the
    // text layer has no say in where the band goes.
    const pageView = viewerRef.current?.getPageView(pageNumber - 1) as
      | { viewport?: { width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] }; div?: HTMLElement }
      | undefined;
    const pageWrapper = pageView?.div?.querySelector(".canvasWrapper") as HTMLElement | null;
    const wrapperRect = pageWrapper?.getBoundingClientRect();
    type StoredLines = { client: SelectionRect[]; relative: SelectionRect[] };
    const storedLinesFor = (position?: AnnotationPosition): StoredLines | null => {
      if (!position || position.pageIndex !== pageNumber - 1) return null;
      const viewport = pageView?.viewport;
      if (!viewport || !wrapperRect || viewport.width <= 0 || viewport.height <= 0) return null;
      const relative = mergeIntoLines(position.rects.map(([x1, y1, x2, y2]) => {
        const [ax, ay] = pageView.viewport!.convertToViewportPoint(x1, y1);
        const [bx, by] = pageView.viewport!.convertToViewportPoint(x2, y2);
        return {
          left: Math.min(ax, bx) / viewport.width,
          top: Math.min(ay, by) / viewport.height,
          width: Math.abs(bx - ax) / viewport.width,
          height: Math.abs(by - ay) / viewport.height,
        };
      }));
      if (relative.length === 0) return null;
      const client = relative.map((r) => ({
        left: wrapperRect.left + r.left * wrapperRect.width,
        top: wrapperRect.top + r.top * wrapperRect.height,
        width: r.width * wrapperRect.width,
        height: r.height * wrapperRect.height,
      }));
      return { client, relative };
    };

    const marked = [
      ...pageHighlights.map((h) => ({
        id: h.id,
        selector: "pr-highlight",
        color: highlightTint(h.color || DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA),
        underline: false,
        stored: storedLinesFor(h.position),
      })),
      ...pageAsked.map((a) => ({
        id: a.id,
        selector: "pr-asked",
        color: a.kind === "cited" ? "var(--quote)" : "var(--accent)",
        underline: true,
        stored: storedLinesFor(a.position),
      })),
    ];

    // Measure first, all of it, before any mark moves — every rect below is
    // the text layer's own geometry
    type Line = { rect: SelectionRect; marks: HTMLElement[] };
    const measured: { item: (typeof marked)[number]; lines: Line[] }[] = [];
    for (const item of marked) {
      // A legacy text-only record needs raster calibration. Do not make it
      // compete with the page's first paint; the pagerendered pass handles it.
      if (!item.stored && !allowCalibration) continue;
      const marks = Array.from(
        layer.querySelectorAll(`mark.${item.selector}[data-highlight-id="${CSS.escape(item.id)}"]`)
      ) as HTMLElement[];
      // With stored geometry the band does not need the text at all, so a
      // failed text match no longer makes the highlight vanish
      if (marks.length === 0 && !item.stored) continue;
      const lines: Line[] = [];
      for (const mark of marks) {
        const measuredRects: SelectionRect[] = item.stored
          ? (() => {
              const r = mark.getBoundingClientRect();
              return [{ left: r.left, top: r.top, width: r.width, height: r.height }];
            })()
          : (() => {
              const range = document.createRange();
              range.selectNodeContents(mark);
              return logicalSelectionBands(range, layer);
            })();
        // A passage both highlighted and asked about is wrapped twice; the
        // inner mark rides along with its parent, so only the outer is nudged
        const nested = !!mark.parentElement?.closest("mark.pr-highlight, mark.pr-asked");
        for (const r of measuredRects) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          const line = lines.find(
            (l) =>
              Math.abs(r.top + r.height / 2 - (l.rect.top + l.rect.height / 2)) <
              Math.min(r.height, l.rect.height) * 0.5
          );
          if (!line) {
            lines.push({ rect: r, marks: nested ? [] : [mark] });
            continue;
          }
          const left = Math.min(line.rect.left, r.left);
          const top = Math.min(line.rect.top, r.top);
          line.rect = {
            left,
            top,
            width: Math.max(line.rect.left + line.rect.width, r.left + r.width) - left,
            height: Math.max(line.rect.top + line.rect.height, r.top + r.height) - top,
          };
          if (!nested && !line.marks.includes(mark)) line.marks.push(mark);
        }
      }
      measured.push({ item, lines });
    }

    // Then decide and apply. Stored PDF rectangles are the complete visual
    // record, so every stored line is painted exactly once; measured marks only
    // provide invisible click targets. For legacy records without rectangles,
    // the text layer + ink remains the fallback.
    const bands: HighlightBand[] = [];
    for (const { item, lines } of measured) {
      if (item.stored) {
        // Keep click targets on the stored line when the text match is nearby,
        // but never let a missing or partial text match drop stored rectangles.
        for (const line of lines) {
          const stored = nearestStoredLine(
            item.stored.client,
            line.rect.top + line.rect.height / 2,
            line.rect.height * 1.5
          );
          if (!stored) continue;
          const shift = stored.top + stored.height / 2 - (line.rect.top + line.rect.height / 2);
          if (Math.abs(shift) >= 0.5) {
            for (const mark of line.marks) {
              mark.style.position = "relative";
              mark.style.top = `${shift.toFixed(1)}px`;
            }
          }
        }
        for (const r of item.stored.relative) {
          bands.push({
            id: item.id,
            color: item.color,
            underline: item.underline,
            ...r,
            inkBottom: r.top + r.height,
          });
        }
        continue;
      }

      for (const line of lines) {
        const snapped: SnappedBand = canvas && canvasRect
          ? snapBandToInk(line.rect, canvas, canvasRect, true)
          : line.rect;
        const displayRect = line.marks[0]?.getBoundingClientRect();
        const shift = displayRect
          ? snapped.top + snapped.height / 2 - (displayRect.top + displayRect.height / 2)
          : 0;
        if (debug) {
          console.log(
            `[pr-band] ${item.underline ? "rule" : "wash"} ${item.id.slice(0, 8)}`,
            { rawTop: +line.rect.top.toFixed(1), rawH: +line.rect.height.toFixed(1), shift: +shift.toFixed(1), inkBottom: snapped.inkBottom && +snapped.inkBottom.toFixed(1) }
          );
        }
        for (const mark of line.marks) {
          const r = mark.getBoundingClientRect();
          const markShift = snapped.top + snapped.height / 2 - (r.top + r.height / 2);
          if (Math.abs(markShift) < 0.5) continue;
          mark.style.position = "relative";
          mark.style.top = `${markShift.toFixed(1)}px`;
        }
        if (!wrapperRect || wrapperRect.width <= 0 || wrapperRect.height <= 0) continue;
        const relative = relativeToPage(snapped, {
          left: wrapperRect.left,
          top: wrapperRect.top,
          width: wrapperRect.width,
          height: wrapperRect.height,
        });
        bands.push({
          id: item.id,
          color: item.color,
          underline: item.underline,
          ...relative,
          // Where the letters stop, when the pixels could say. The wash can be
          // a little taller than the glyphs without looking wrong; a rule
          // cannot, so it is drawn from this rather than from the band's edge.
          inkBottom:
            snapped.inkBottom === undefined
              ? undefined
              : (snapped.inkBottom - wrapperRect.top) / wrapperRect.height,
        });
      }
    }
    // Keep the previous page-relative overlay during the short CSS-only zoom
    // window. A legacy text-only annotation needs the finished canvas to be
    // recalibrated; replacing it with an incomplete set here causes a flash.
    if (pageWrapper && (allowCalibration || !needsLegacyCalibration)) {
      renderPageBands(pageWrapper, bands);
    }
  }, [calibrateTextLayer]);

  useEffect(() => {
    paintPageRef.current = paintPageHighlights;
  });

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

  // The popover is also the selection indicator for a saved highlight. Keep
  // the keyboard action global so it works after selecting text in the PDF,
  // but never steal Delete/Backspace from an editor or form control.
  useEffect(() => {
    if (!highlightMenu || !onRemoveHighlight) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHighlightDeleteKey(event)) return;
      if (isTextEditingTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      const id = highlightMenu.id;
      setHighlightMenu(null);
      onRemoveHighlight(id);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [highlightMenu, onRemoveHighlight]);

  const repaintRenderedPages = useCallback(() => {
    containerRef.current?.querySelectorAll(".page[data-page-number]").forEach((page) => {
      paintPageHighlights(parseInt(page.getAttribute("data-page-number")!), true);
    });
  }, [paintPageHighlights]);

  // Repaint all currently rendered pages when highlights change.
  useEffect(() => {
    repaintRenderedPages();
  }, [highlights, askedPassages, repaintRenderedPages]);

  // ── Selection ribbon ────────────────────────────────────────────
  // Bands pulsed briefly after jumping to a passage — the same visual language
  // as the selection, so the reader only ever shows one kind of highlight
  const [flashRects, setFlashRects] = useState<SelectionRect[]>([]);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Snap viewport-space bands onto the glyphs of whichever page they fall on
  const snapBands = useCallback((bands: SelectionRect[], logicalSelection = false): SelectionRect[] => {
    const container = containerRef.current;
    if (!container) return bands;
    const scaleKey = String(viewerRef.current?.currentScale ?? 1);
    const canvases = Array.from(container.querySelectorAll(".page")).flatMap((page) => {
      const canvas = page.querySelector("canvas") as HTMLCanvasElement | null;
      const layer = page.querySelector(".textLayer") as HTMLElement | null;
      return canvas
        ? [{ canvas, rect: canvas.getBoundingClientRect(), calibrated: layer?.dataset.prCalibrated === scaleKey }]
        : [];
    });
    return bands.map((band) => {
      const cy = band.top + band.height / 2;
      const cx = band.left + band.width / 2;
      const page = canvases.find(
        ({ rect }) => cy >= rect.top && cy <= rect.bottom && cx >= rect.left && cx <= rect.right
      );
      return page
        ? snapBandToInk(band, page.canvas, page.rect, logicalSelection || page.calibrated)
        : band;
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

  const getPageTextContent = useCallback((pageNumber: number): Promise<PageTextContent> | null => {
    const doc = pdfDocRef.current;
    if (!doc) return null;
    let pending = textContentCacheRef.current.get(pageNumber);
    if (!pending) {
      pending = doc.getPage(pageNumber).then(async (page) => (
        await page.getTextContent({ includeMarkedContent: true, disableNormalization: true }) as PageTextContent
      ));
      textContentCacheRef.current.set(pageNumber, pending);
    }
    return pending;
  }, []);

  const prepareSelectionPage = useCallback(async (pageNumber: number): Promise<SelectionPageEntry | null> => {
    const viewer = viewerRef.current;
    const pageView = viewer?.getPageView(pageNumber - 1) as PdfPageView | undefined;
    const layer = pageView?.div?.querySelector(".textLayer") as HTMLElement | null;
    if (!pageView || !layer || layer.hidden) return null;

    const cached = selectionPageCacheRef.current.get(pageNumber);
    if (cached?.layer === layer) return cached;
    const pending = getPageTextContent(pageNumber);
    if (!pending) return null;

    try {
      const content = await pending;
      const items = content.items.filter((item) => "str" in item) as PdfTextItem[];
      const highlighter = pageView._textHighlighter;
      const divs = highlighter?.textDivs;
      const strings = highlighter?.textContentItemsStr;
      if (!divs || divs.length !== items.length || !strings || strings.length !== items.length) return null;
      if (strings.some((text, index) => text !== items[index].str)) return null;

      const spans = divs.map((div) => div?.isConnected ? div : null);
      const fractions = items.map((item, index) => itemBoundaryFractions(spans[index], item.str));
      const entry: SelectionPageEntry = {
        pageNumber,
        layer,
        spans,
        model: buildPdfSelectionModel(items, content.styles as Record<string, PdfTextStyle>, fractions),
      };
      selectionPageCacheRef.current.set(pageNumber, entry);
      layer.dataset.prSelectionReady = String(entry.model.characters.length);
      return entry;
    } catch {
      textContentCacheRef.current.delete(pageNumber);
      selectionPageCacheRef.current.delete(pageNumber);
      return null;
    }
  }, [getPageTextContent]);

  const scheduleSelectionPreparation = useCallback((pageNumber: number) => {
    selectionPreparationJobsRef.current.get(pageNumber)?.();
    selectionPreparationJobsRef.current.delete(pageNumber);
    // Fast scrolling can render many transient pages. Keep at most the two
    // newest idle jobs so stopping after a long fling does not unleash a queue
    // of character-measurement passes for pages that are already off-screen.
    while (selectionPreparationJobsRef.current.size >= 2) {
      const oldestPage = selectionPreparationJobsRef.current.keys().next().value as number | undefined;
      if (oldestPage === undefined) break;
      selectionPreparationJobsRef.current.get(oldestPage)?.();
      selectionPreparationJobsRef.current.delete(oldestPage);
    }
    const run = () => {
      selectionPreparationJobsRef.current.delete(pageNumber);
      void prepareSelectionPage(pageNumber);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run);
      selectionPreparationJobsRef.current.set(pageNumber, () => window.cancelIdleCallback(id));
    } else {
      const id = window.setTimeout(run, 80);
      selectionPreparationJobsRef.current.set(pageNumber, () => window.clearTimeout(id));
    }
  }, [prepareSelectionPage]);

  const getReferenceModel = useCallback((pageNumber: number): Promise<PdfSelectionModel> | null => {
    let pending = referenceModelCacheRef.current.get(pageNumber);
    if (pending) return pending;
    const contentPromise = getPageTextContent(pageNumber);
    if (!contentPromise) return null;
    pending = contentPromise.then((content) => {
      const items = content.items.filter((item) => "str" in item) as PdfTextItem[];
      return buildPdfSelectionModel(items, content.styles as Record<string, PdfTextStyle>);
    }).catch((error) => {
      referenceModelCacheRef.current.delete(pageNumber);
      throw error;
    });
    referenceModelCacheRef.current.set(pageNumber, pending);
    return pending;
  }, [getPageTextContent]);

  const loadReferencePreview = useCallback((destination: string): Promise<ReferencePreviewData | null> => {
    const doc = pdfDocRef.current;
    if (!doc) return Promise.resolve(null);
    let pending = referencePreviewCacheRef.current.get(destination);
    if (pending) return pending;

    pending = (async () => {
      const explicit = await doc.getDestination(destination) as unknown[] | null;
      if (!explicit?.length || pdfDocRef.current !== doc) return null;
      const target = explicit[0];
      const pageIndex = typeof target === "number"
        ? target
        : await doc.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      const page = await doc.getPage(pageIndex + 1);
      const scale = 1.8;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      await page.render({
        canvasContext: context,
        viewport,
        canvas,
        annotationMode: AnnotationMode.DISABLE,
      }).promise;
      if (pdfDocRef.current !== doc) return null;

      const kind = (explicit[1] as { name?: string } | undefined)?.name;
      const pdfTop = typeof (kind === "XYZ" ? explicit[3] : explicit[2]) === "number"
        ? Number(kind === "XYZ" ? explicit[3] : explicit[2])
        : page.view[3];
      const [, destinationY] = viewport.convertToViewportPoint(page.view[0], pdfTop);
      // Bibliography entries occupy the central text block. Include a few
      // neighbours, like Zotero, so a grouped citation remains understandable.
      const cropX = Math.max(0, Math.floor(viewport.width * 0.075));
      const cropWidth = Math.min(canvas.width - cropX, Math.ceil(viewport.width * 0.85));
      const cropHeight = Math.min(canvas.height, Math.ceil(220 * scale));
      const cropY = Math.max(0, Math.min(canvas.height - cropHeight, Math.floor(destinationY - 24 * scale)));
      const crop = document.createElement("canvas");
      crop.width = cropWidth;
      crop.height = cropHeight;
      const cropContext = crop.getContext("2d");
      if (!cropContext) return null;
      cropContext.fillStyle = "#fff";
      cropContext.fillRect(0, 0, crop.width, crop.height);
      cropContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      return { imageUrl: crop.toDataURL("image/jpeg", 0.9), pageNumber: pageIndex + 1 };
    })().catch(() => null);
    referencePreviewCacheRef.current.set(destination, pending);
    return pending;
  }, []);

  const endReferenceHover = useCallback(() => {
    clearTimeout(referenceHoverTimerRef.current);
    hoveredReferenceRef.current = null;
    setReferencePreview(null);
  }, []);

  const beginReferenceHover = useCallback((band: ReferenceLinkBand, anchor: DOMRect) => {
    if (typeof band.destination !== "string") return;
    const destination = band.destination;
    clearTimeout(referenceHoverTimerRef.current);
    hoveredReferenceRef.current = destination;
    referenceHoverTimerRef.current = setTimeout(() => {
      if (hoveredReferenceRef.current !== destination) return;
      setReferencePreview({
        anchor,
        destination,
        label: band.label,
        loading: true,
      });
      void loadReferencePreview(destination).then((data) => {
        if (hoveredReferenceRef.current !== destination) return;
        setReferencePreview({
          anchor,
          destination,
          label: band.label,
          loading: false,
          data: data ?? undefined,
          error: data ? undefined : "Reference preview unavailable",
        });
      });
    }, 140);
  }, [loadReferencePreview]);

  const openPdfLink = useCallback((band: ReferenceLinkBand) => {
    endReferenceHover();
    if (band.url) {
      window.open(band.url, "_blank", "noopener,noreferrer");
    } else if (band.destination) {
      void linkServiceRef.current?.goToDestination(band.destination);
    }
  }, [endReferenceHover]);

  const paintReferenceLinks = useCallback(async (pageNumber: number) => {
    const doc = pdfDocRef.current;
    const viewer = viewerRef.current;
    if (!doc || !viewer) return;
    const pageView = viewer.getPageView(pageNumber - 1) as PdfPageView | undefined;
    const wrapper = pageView?.div?.querySelector(".canvasWrapper") as HTMLElement | null;
    const viewport = pageView?.viewport;
    if (!pageView?.div || !wrapper || !viewport) return;

    let annotationsPromise = linkAnnotationCacheRef.current.get(pageNumber);
    if (!annotationsPromise) {
      annotationsPromise = doc.getPage(pageNumber).then(async (page) => (
        await page.getAnnotations({ intent: "display" }) as PdfLinkAnnotation[]
      ));
      linkAnnotationCacheRef.current.set(pageNumber, annotationsPromise);
    }
    const annotations = await annotationsPromise;
    if (pdfDocRef.current !== doc || !wrapper.isConnected) return;

    const links = annotations.filter(
      (annotation) => annotation.subtype === "Link" && Boolean(annotation.dest || annotation.url)
    );
    const needsReferenceGeometry = links.some(
      (annotation) => typeof annotation.dest === "string" && annotation.dest.startsWith("cite.")
    );
    const modelPromise = needsReferenceGeometry ? getReferenceModel(pageNumber) : null;
    const model = modelPromise ? await modelPromise : null;
    if (pdfDocRef.current !== doc || !wrapper.isConnected) return;
    const bands: ReferenceLinkBand[] = [];
    for (const annotation of links) {
      const reference = typeof annotation.dest === "string" && annotation.dest.startsWith("cite.");
      const aligned = reference && model
        ? alignReferenceLink(model, annotation.rect, annotation.overlaidText)
        : null;
      // Hyperref's inline x bounds are accurate; the broken part is its line.
      // Preserve those exact horizontal bounds and repair only the vertical
      // line from the lightweight PDF model. This avoids DOM character
      // measurement without making the hover target less precise.
      const rect = aligned
        ? [annotation.rect[0], aligned.rect[1], annotation.rect[2], aligned.rect[3]]
        : annotation.rect;
      if (rect.length < 4) continue;
      const fractions = referenceRectFractions(
        [rect[0], rect[1], rect[2], rect[3]],
        viewport
      );
      bands.push({
        id: annotation.id,
        destination: annotation.dest,
        url: annotation.url,
        label: aligned?.label ?? annotation.overlaidText?.trim() ?? "",
        reference,
        ...fractions,
      });
    }
    renderPageReferenceLinks(wrapper, bands, beginReferenceHover, endReferenceHover, openPdfLink);
  }, [getReferenceModel, beginReferenceHover, endReferenceHover, openPdfLink]);

  useEffect(() => () => {
    clearTimeout(referenceHoverTimerRef.current);
  }, []);

  const paintSelection = useCallback(() => {
    const container = containerRef.current;
    const clear = () => container?.querySelectorAll(".pr-page-selection").forEach((overlay) => overlay.remove());
    const controlled = controlledPdfSelectionRef.current;
    if (container && controlled) {
      clear();
      const pageView = viewerRef.current?.getPageView(controlled.pageNumber - 1) as PdfPageView | undefined;
      const wrapper = pageView?.div?.querySelector(".canvasWrapper") as HTMLElement | null;
      const viewport = pageView?.viewport;
      if (!wrapper || !viewport || viewport.width <= 0 || viewport.height <= 0) return;
      const bands = controlled.position.rects.map((rect) => {
        const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
        const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
        return {
          left: Math.min(ax, bx) / viewport.width,
          top: Math.min(ay, by) / viewport.height,
          width: Math.abs(bx - ax) / viewport.width,
          height: Math.abs(by - ay) / viewport.height,
        };
      });
      renderPageSelection(wrapper, bands);
      return;
    }

    const sel = window.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      clear();
      return;
    }
    const anchor = sel.anchorNode;
    const node = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (!node || !container.contains(node)) {
      clear();
      return;
    }

    // Measure every intersected text span from PDF.js's logical coordinates,
    // snap only within that line, then freeze the result as fractions of its
    // page. The page and ribbon now share one zoom coordinate system.
    const range = sel.getRangeAt(0);
    const bands = snapBands(logicalSelectionBands(range, container), true);
    clear();
    const pages = Array.from(container.querySelectorAll(".page .canvasWrapper")).map((wrapper) => ({
      wrapper: wrapper as HTMLElement,
      rect: wrapper.getBoundingClientRect(),
      bands: [] as SelectionRect[],
    }));
    for (const band of bands) {
      const cx = band.left + band.width / 2;
      const cy = band.top + band.height / 2;
      const page = pages.find(({ rect }) => cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom);
      if (!page || page.rect.width <= 0 || page.rect.height <= 0) continue;
      page.bands.push(relativeToPage(band, page.rect));
    }
    for (const page of pages) if (page.bands.length > 0) renderPageSelection(page.wrapper, page.bands);
  }, [snapBands]);

  const scheduleSelectionPaint = useCallback(() => {
    cancelAnimationFrame(selectionPaintFrameRef.current);
    selectionPaintFrameRef.current = requestAnimationFrame(() => {
      selectionPaintFrameRef.current = 0;
      paintSelection();
    });
  }, [paintSelection]);

  // selectionchange fires on every mousemove of a drag; one paint per frame
  useEffect(() => {
    document.addEventListener("selectionchange", scheduleSelectionPaint);
    return () => {
      cancelAnimationFrame(selectionPaintFrameRef.current);
      document.removeEventListener("selectionchange", scheduleSelectionPaint);
    };
  }, [scheduleSelectionPaint]);

  // ── Viewer lifecycle ────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const textContentCache = textContentCacheRef.current;
    const selectionPageCache = selectionPageCacheRef.current;
    const referenceModelCache = referenceModelCacheRef.current;
    const linkAnnotationCache = linkAnnotationCacheRef.current;
    const referencePreviewCache = referencePreviewCacheRef.current;
    const selectionPreparationJobs = selectionPreparationJobsRef.current;
    let cancelled = false;
    container.querySelectorAll(".pr-page-bands").forEach((overlay) => overlay.remove());
    container.querySelectorAll(".pr-page-reference-links").forEach((overlay) => overlay.remove());
    endReferenceHover();

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    // PDF link borders are producer-supplied annotation appearances and can be
    // painted directly into the page canvas (CSS cannot remove that copy). The
    // custom link layer above preserves navigation and reference previews, so
    // omit every raw annotation appearance from both canvas and DOM layers.
    const viewer = new PdfJsViewer({
      container,
      eventBus,
      linkService,
      findController,
      annotationMode: AnnotationMode.DISABLE,
    });
    linkService.setViewer(viewer);
    linkServiceRef.current = linkService;
    eventBusRef.current = eventBus;
    viewerRef.current = viewer;

    eventBus.on("pagesinit", () => {
      // Skip if the container has been unmounted/detached (fast paper switch,
      // dev remount) — pdf.js would try to scroll a detached element.
      if (cancelled || !container.isConnected) return;
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = 0;
      zoomTargetScaleRef.current = null;
      // Resume where this paper was left, at the zoom it was left at. The
      // scale has to be applied before the scroll: page-width and a numeric
      // scale give different document heights, so scrolling first would land
      // somewhere else entirely.
      const resume = positionKeyRef.current ? loadReadingPosition(positionKeyRef.current) : null;
      viewer.currentScaleValue = typeof resume?.scale === "number" ? String(resume.scale) : "page-width";
      if (resume && resume.scrollTop > 0) {
        // One frame later: pdf.js sizes the pages during this event, so the
        // container is not yet tall enough to accept the offset.
        requestAnimationFrame(() => {
          if (!cancelled && container.isConnected) container.scrollTop = resume.scrollTop;
        });
      }
    });
    eventBus.on("scalechanging", (e: { scale: number }) => {
      if (cancelled) return;
      // Updating one text node avoids rerendering this large client component
      // for every animation frame of a pinch gesture.
      if (zoomPercentRef.current) zoomPercentRef.current.textContent = `${Math.round(e.scale * 100)}%`;
      clearTimeout(zoomLabelCommitTimerRef.current);
      zoomLabelCommitTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        setDisplayScale(e.scale);
        recordPositionRef.current?.();
      }, 120);
      // Saved annotations and the live selection are both page-relative; the
      // page itself scales them together with the canvas.
    });
    eventBus.on("pagechanging", (e: { pageNumber: number }) => {
      if (!cancelled && Number.isInteger(e.pageNumber)) setCurrentPage(e.pageNumber);
    });
    // Text layers rebuild on zoom/virtualization — re-paint highlights each time
    eventBus.on("textlayerrendered", (e: { pageNumber: number }) => {
      if (!cancelled) {
        paintPageHighlights(e.pageNumber);
        scheduleSelectionPreparation(e.pageNumber);
        void paintReferenceLinks(e.pageNumber);
        scheduleSelectionPaint();
      }
    });
    // The text layer can finish before the canvas has any ink on it, and a
    // band snapped against a blank canvas silently keeps the text layer's raw
    // geometry. Repaint once the pixels exist.
    eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      if (!cancelled) {
        const needsCanvasAlignment = [...highlightsRef.current, ...askedRef.current].some(
          (item) => (!item.pageNumber || item.pageNumber === e.pageNumber) && !item.position
        );
        if (needsCanvasAlignment) paintPageHighlights(e.pageNumber, true);
        const pageView = viewer.getPageView(e.pageNumber - 1) as PdfPageView | undefined;
        if (!pageView?.div?.querySelector(".pr-page-reference-links")) {
          void paintReferenceLinks(e.pageNumber);
        }
        scheduleSelectionPaint();
      }
    });

    const loadingTask = getDocument(pdfDataUrl);
    loadingTask.promise.then(
      (pdf) => {
        if (cancelled) return;
        pdfDocRef.current = pdf;
        textContentCache.clear();
        selectionPageCache.clear();
        referenceModelCache.clear();
        linkAnnotationCache.clear();
        referencePreviewCache.clear();
        viewer.setDocument(pdf);
        linkService.setDocument(pdf);
        setNumPages(pdf.numPages);
        setCurrentPage(1);
        setLoadError(false);
      },
      () => { if (!cancelled) setLoadError(true); }
    );

    return () => {
      cancelled = true;
      // Tear the viewer down so no in-flight page setup fires against a
      // detached DOM ("offsetParent is not set" console errors)
      try {
        // Stop the render queue before the document goes away. Without this a
        // page draw already in flight resumes against a reset page view and
        // pdf.js throws "pdfPage is not loaded" — which is what closing a tab
        // mid-render used to produce.
        const queue = (viewer as unknown as { renderingQueue?: { renderHighestPriority?: () => void } }).renderingQueue;
        if (queue) queue.renderHighestPriority = () => {};
        // pdf.js supports null for teardown; its TS types don't declare it
        viewer.setDocument(null as unknown as PDFDocumentProxy);
        linkService.setDocument(null);
      } catch {
        // viewer may not have received a document yet
      }
      // Destroy only once the viewer has let go: destroying underneath a live
      // page view is the other half of the same race.
      loadingTask.promise.catch(() => {}).finally(() => { void loadingTask.destroy().catch(() => {}); });
      pdfDocRef.current = null;
      textContentCache.clear();
      selectionPageCache.clear();
      referenceModelCache.clear();
      linkAnnotationCache.clear();
      referencePreviewCache.clear();
      selectionPreparationJobs.forEach((cancel) => cancel());
      selectionPreparationJobs.clear();
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = 0;
      zoomTargetScaleRef.current = null;
      clearTimeout(zoomLabelCommitTimerRef.current);
      cancelAnimationFrame(selectionPaintFrameRef.current);
      endReferenceHover();
      activePdfSelectionRef.current = null;
      controlledPdfSelectionRef.current = null;
      viewerRef.current = null;
      linkServiceRef.current = null;
      eventBusRef.current = null;
    };
  }, [pdfDataUrl, paintPageHighlights, scheduleSelectionPaint, scheduleSelectionPreparation, paintReferenceLinks, endReferenceHover]);

  // ── Zoom ────────────────────────────────────────────────────────
  // Apply one inexpensive CSS-first PDF.js scale step. The high-resolution
  // canvas redraw remains delayed until no more steps arrive.
  const applyZoomFactor = useCallback((factor: number, origin?: [number, number]) => {
    const viewer = viewerRef.current;
    const el = containerRef.current;
    if (!viewer || !el || !Number.isFinite(factor) || factor <= 0) return;

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

  // PDF.js rounds every requested scale to two decimals. Driving it directly
  // from tiny trackpad events therefore drops motion, while a mouse-wheel tick
  // can jump several dozen percent. Hold an exact target and approach it once
  // per animation frame in bounded steps: both input types become continuous.
  const stepZoomAnimation = useCallback(function stepZoomAnimationFrame() {
    zoomFrameRef.current = 0;
    const viewer = viewerRef.current;
    const target = zoomTargetScaleRef.current;
    if (!viewer || target === null) return;

    const before = viewer.currentScale;
    const next = nextZoomFrameScale(before, target);
    applyZoomFactor(next / before, zoomOriginRef.current);
    const after = viewer.currentScale;

    // If PDF.js rounded away a sub-percent step, retain the exact target so the
    // next trackpad event accumulates onto it instead of losing that movement.
    if (after === before) return;
    const remaining = Math.abs(Math.log(target / after));
    if (remaining <= 0.0025) {
      zoomTargetScaleRef.current = null;
      return;
    }
    zoomFrameRef.current = requestAnimationFrame(stepZoomAnimationFrame);
  }, [applyZoomFactor]);

  const queueZoomTarget = useCallback((requested: number, origin?: [number, number]) => {
    const viewer = viewerRef.current;
    if (!viewer || !Number.isFinite(requested)) return;
    // Never let a burst of wheel events build a long animation backlog. The
    // target advances again as the viewer catches up on following frames.
    const current = viewer.currentScale;
    const nearby = Math.max(current / 1.45, Math.min(current * 1.45, requested));
    zoomTargetScaleRef.current = Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, nearby));
    zoomOriginRef.current = origin;
    if (!zoomFrameRef.current) {
      zoomFrameRef.current = requestAnimationFrame(stepZoomAnimation);
    }
  }, [stepZoomAnimation]);

  // Record where reading got to. Debounced while scrolling, and flushed on
  // teardown so crossing to the other surface captures the last position
  // rather than the one from a second earlier.
  const recordPosition = useCallback(() => {
    const container = containerRef.current;
    const viewer = viewerRef.current;
    const key = positionKeyRef.current;
    if (!container || !viewer || !key) return;
    // "page-width" is a rule, not a number: storing the number it happens to
    // resolve to would freeze the paper at one window size.
    const scale = viewer.currentScaleValue === "page-width" ? "page-width" : viewer.currentScale;
    saveReadingPosition(key, { scrollTop: container.scrollTop, scale, page: viewer.currentPageNumber });
  }, []);

  useEffect(() => { recordPositionRef.current = recordPosition; }, [recordPosition]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer = 0;
    const onScroll = () => {
      clearTimeout(timer);
      timer = window.setTimeout(recordPosition, 400);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      container.removeEventListener("scroll", onScroll);
      recordPosition();
    };
  }, [recordPosition]);

  const zoomBy = useCallback((factor: number, origin?: [number, number]) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const base = zoomTargetScaleRef.current ?? viewer.currentScale;
    queueZoomTarget(base * factor, origin);
  }, [queueZoomTarget]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const viewer = viewerRef.current;
      if (!viewer) return;
      const base = zoomTargetScaleRef.current ?? viewer.currentScale;
      const delta = wheelDeltaPixels(e.deltaY, e.deltaMode, el.clientHeight);
      queueZoomTarget(wheelZoomTarget(base, delta), [e.clientX, e.clientY]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = 0;
    };
  }, [queueZoomTarget]);

  const zoomReset = useCallback(() => {
    cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = 0;
    zoomTargetScaleRef.current = null;
    zoomOriginRef.current = undefined;
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScaleValue = "page-width";
  }, []);

  // ── Selection → explain / ask ───────────────────────────────────
  const getSelectionPageNumber = useCallback((): number | undefined => {
    if (controlledPdfSelectionRef.current) return controlledPdfSelectionRef.current.pageNumber;
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
  const selectionPositionPromiseRef = useRef<Promise<AnnotationPosition | undefined> | null>(null);
  const selectionOccurrenceRef = useRef(0);

  const clearSelection = useCallback(() => {
    activePdfSelectionRef.current = null;
    controlledPdfSelectionRef.current = null;
    selectionPageRef.current = undefined;
    selectionPositionRef.current = undefined;
    selectionPositionPromiseRef.current = null;
    containerRef.current?.querySelectorAll(".pr-page-selection").forEach((overlay) => overlay.remove());
    clearNativeSelection();
  }, [clearNativeSelection]);

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
    if (controlledPdfSelectionRef.current) return controlledPdfSelectionRef.current.position;
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
    const layer = pageView.div?.querySelector(".textLayer") as HTMLElement | null;
    if (!layer) return undefined;
    // Freeze the line the PDF says was selected, not the display-time nudge
    // applied to its invisible span. Ink may tighten that line's band, but the
    // sub-line guard in nearestInkRun prevents it from becoming a neighbour.
    const lines = snapBands(logicalSelectionBands(sel.getRangeAt(0), layer), true) as SnappedBand[];
    // Ink-tightened geometry is preferable, but the original PDF.js span is a
    // stable logical PDF position even when the canvas is blank or the ink is
    // ambiguous. Always store it: omitting position would make this highlight
    // a zoom-dependent legacy record reconstructed from display calibration.
    if (lines.length === 0) return undefined;
    // A selection reaching onto another page would convert against this
    // page's frame; keep the lines that are actually on it
    const onPage = lines.filter(
      (l) => l.top + l.height / 2 >= pageRect.top && l.top + l.height / 2 <= pageRect.bottom
    );
    if (onPage.length !== lines.length) return undefined;
    const rects: number[][] = [];
    for (const r of onPage) {
      const [ax, ay] = pageView.viewport.convertToPdfPoint(r.left - pageRect.left, r.top + r.height - pageRect.top);
      const [bx, by] = pageView.viewport.convertToPdfPoint(r.left + r.width - pageRect.left, r.top - pageRect.top);
      rects.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]);
    }
    return rects.length ? { pageIndex: pageNum - 1, rects } : undefined;
  }, [snapBands]);

  // Zotero derives highlight bands from PDF character boxes. Refine the
  // synchronous Range position with the same line geometry before an action is
  // saved; this removes browser-font metrics from the exported annotation.
  const alignSelectionPosition = useCallback(async (
    position: AnnotationPosition | undefined
  ): Promise<AnnotationPosition | undefined> => {
    if (!pdfDocRef.current || !position) return position;
    const pageNumber = position.pageIndex + 1;
    const contentPromise = getPageTextContent(pageNumber);
    if (!contentPromise) return position;
    try {
      const content = await contentPromise;
      const items = content.items.filter((item) => "str" in item) as PdfTextItem[];
      return {
        ...position,
        rects: alignRectsToZoteroLines(
          position.rects,
          items,
          content.styles as Record<string, PdfTextStyle>
        ),
      };
    } catch {
      textContentCacheRef.current.delete(pageNumber);
      return position;
    }
  }, [getPageTextContent]);

  useEffect(() => {
    if (selection) {
      const controlled = controlledPdfSelectionRef.current;
      selectionPageRef.current = controlled?.pageNumber ?? getSelectionPageNumber();
      if (controlled) {
        selectionPositionRef.current = controlled.position;
        selectionPositionPromiseRef.current = Promise.resolve(controlled.position);
        selectionOccurrenceRef.current = computeSelectionOccurrence(selection.text);
        return;
      }
      const position = computeSelectionPosition();
      selectionPositionRef.current = position;
      const pending = alignSelectionPosition(position);
      selectionPositionPromiseRef.current = pending;
      void pending.then((aligned) => {
        if (selectionPositionPromiseRef.current === pending) selectionPositionRef.current = aligned;
      });
      selectionOccurrenceRef.current = computeSelectionOccurrence(selection.text);
    } else {
      selectionPositionPromiseRef.current = null;
    }
  }, [selection, getSelectionPageNumber, computeSelectionPosition, computeSelectionOccurrence, alignSelectionPosition]);

  const resolvedSelectionPosition = useCallback(async () => {
    return selectionPositionPromiseRef.current
      ? await selectionPositionPromiseRef.current
      : selectionPositionRef.current;
  }, []);

  const handleExplain = useCallback(async () => {
    if (selection) {
      const position = await resolvedSelectionPosition();
      onTextSelected(selection.text, selectionPageRef.current, selectionOccurrenceRef.current, position);
      clearSelection();
    }
  }, [selection, onTextSelected, clearSelection, resolvedSelectionPosition]);

  const handleAsk = useCallback(
    async (question: string) => {
      if (selection) {
        const position = await resolvedSelectionPosition();
        onAskAboutSelection(selection.text, question, selectionPageRef.current, selectionOccurrenceRef.current, position);
        clearSelection();
      }
    },
    [selection, onAskAboutSelection, clearSelection, resolvedSelectionPosition]
  );

  const handleHighlight = useCallback(
    async (color: string) => {
      if (selection && onHighlight) {
        const position = await resolvedSelectionPosition();
        onHighlight(selection.text, selectionPageRef.current, position, color, selectionOccurrenceRef.current);
        clearSelection();
      }
    },
    [selection, onHighlight, clearSelection, resolvedSelectionPosition]
  );

  const handleNote = useCallback(
    async (note: string, color: string) => {
      if (selection && onNote) {
        const position = await resolvedSelectionPosition();
        onNote(selection.text, note, selectionPageRef.current, position, color, selectionOccurrenceRef.current);
        clearSelection();
      }
    },
    [selection, onNote, clearSelection, resolvedSelectionPosition]
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

  const pdfPointForMouse = useCallback((entry: SelectionPageEntry, e: React.MouseEvent): [number, number] | null => {
    const pageView = viewerRef.current?.getPageView(entry.pageNumber - 1) as PdfPageView | undefined;
    const wrapper = pageView?.div?.querySelector(".canvasWrapper") as HTMLElement | null;
    if (!pageView?.viewport || !wrapper) return null;
    const box = wrapper.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    // convertToPdfPoint expects viewport pixels. During PDF.js's CSS-first zoom
    // the wrapper may already have its new size while the viewport is awaiting
    // redraw, so normalize through both dimensions rather than assuming 1 CSS
    // pixel is always 1 viewport unit.
    return pageView.viewport.convertToPdfPoint(
      ((e.clientX - box.left) / box.width) * pageView.viewport.width,
      ((e.clientY - box.top) / box.height) * pageView.viewport.height
    ) as [number, number];
  }, []);

  const clientRectForPosition = useCallback((position: AnnotationPosition): DOMRect | null => {
    const pageView = viewerRef.current?.getPageView(position.pageIndex) as PdfPageView | undefined;
    const wrapper = pageView?.div?.querySelector(".canvasWrapper") as HTMLElement | null;
    const viewport = pageView?.viewport;
    if (!wrapper || !viewport || !position.rects.length) return null;
    const box = wrapper.getBoundingClientRect();
    const clientRects = position.rects.map((rect) => {
      const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
      const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
      const left = box.left + (Math.min(ax, bx) / viewport.width) * box.width;
      const top = box.top + (Math.min(ay, by) / viewport.height) * box.height;
      const right = box.left + (Math.max(ax, bx) / viewport.width) * box.width;
      const bottom = box.top + (Math.max(ay, by) / viewport.height) * box.height;
      return { left, top, right, bottom };
    });
    const left = Math.min(...clientRects.map((rect) => rect.left));
    const top = Math.min(...clientRects.map((rect) => rect.top));
    const right = Math.max(...clientRects.map((rect) => rect.right));
    const bottom = Math.max(...clientRects.map((rect) => rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  }, []);

  const updatePdfSelection = useCallback((active: ActivePdfSelection): ControlledPdfSelection | null => {
    const selected = pdfSelectionRange(active.entry.model, active.anchorBoundary, active.focusBoundary);
    if (!selected) {
      controlledPdfSelectionRef.current = null;
      const point = selectionBoundaryPoint(active.entry, active.anchorBoundary);
      const domSelection = window.getSelection();
      if (point && domSelection) {
        const range = document.createRange();
        range.setStart(point[0], point[1]);
        range.collapse(true);
        domSelection.removeAllRanges();
        domSelection.addRange(range);
      }
      paintSelection();
      return null;
    }

    const anchor = selectionBoundaryPoint(active.entry, active.anchorBoundary);
    const focus = selectionBoundaryPoint(active.entry, active.focusBoundary);
    const domSelection = window.getSelection();
    if (anchor && focus && domSelection) {
      try {
        domSelection.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
      } catch {
        const range = document.createRange();
        const forward = active.anchorBoundary <= active.focusBoundary;
        range.setStart(...(forward ? anchor : focus));
        range.setEnd(...(forward ? focus : anchor));
        domSelection.removeAllRanges();
        domSelection.addRange(range);
      }
    }

    const text = domSelection?.toString().trim() || selected.text.trim();
    if (!text) return null;
    const controlled: ControlledPdfSelection = {
      pageNumber: active.entry.pageNumber,
      position: { pageIndex: active.entry.pageNumber - 1, rects: selected.rects },
      range: selected,
      text,
    };
    controlledPdfSelectionRef.current = controlled;
    active.entry.layer.dataset.prSelectionText = text;
    active.entry.layer.dataset.prSelectionRects = JSON.stringify(selected.rects);
    paintSelection();
    return controlled;
  }, [paintSelection]);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    const parts = findPageParts(e.target);
    if (!parts) return;
    if (captureMode || e.altKey) {
      e.preventDefault();
      onMouseDown(e, parts.canvas, parts.wrapper, captureMode);
      dragPageRef.current = parts.wrapper;
      return;
    }
    if (e.button !== 0) return;

    const page = parts.wrapper.closest(".page");
    const pageNumber = Number(page?.getAttribute("data-page-number"));
    const entry = pageNumber ? selectionPageCacheRef.current.get(pageNumber) : undefined;
    if (!entry || !entry.layer.isConnected) {
      if (pageNumber) void prepareSelectionPage(pageNumber);
      return; // native browser selection remains the safe loading fallback
    }
    const point = pdfPointForMouse(entry, e);
    const hit = point && hitTestPdfSelection(entry.model, point[0], point[1], 0.8);
    if (!hit) return;

    e.preventDefault();
    clearSelection();
    setHighlightMenu(null);
    const active = { entry, anchorBoundary: hit.boundary, focusBoundary: hit.boundary };
    activePdfSelectionRef.current = active;
    updatePdfSelection(active);
  }, [findPageParts, captureMode, onMouseDown, prepareSelectionPage, pdfPointForMouse, clearSelection, updatePdfSelection]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragPageRef.current) {
      onMouseMove(e, dragPageRef.current);
      return;
    }
    const active = activePdfSelectionRef.current;
    if (!active) return;
    const point = pdfPointForMouse(active.entry, e);
    const hit = point && hitTestPdfSelection(active.entry.model, point[0], point[1], 4);
    if (!hit) return;
    e.preventDefault();
    active.focusBoundary = hit.boundary;
    updatePdfSelection(active);
  }, [isDragging, onMouseMove, pdfPointForMouse, updatePdfSelection]);

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
    const active = activePdfSelectionRef.current;
    if (active) {
      const point = pdfPointForMouse(active.entry, e);
      const hit = point && hitTestPdfSelection(active.entry.model, point[0], point[1], 4);
      if (hit) active.focusBoundary = hit.boundary;
      const controlled = updatePdfSelection(active);
      activePdfSelectionRef.current = null;
      if (!controlled) {
        clearSelection();
        return;
      }
      const rect = clientRectForPosition(controlled.position);
      if (!rect) {
        clearSelection();
        return;
      }
      e.preventDefault();
      selectionPageRef.current = controlled.pageNumber;
      selectionPositionRef.current = controlled.position;
      selectionPositionPromiseRef.current = Promise.resolve(controlled.position);
      selectionOccurrenceRef.current = computeSelectionOccurrence(controlled.text);
      setSelectionInfo({ text: controlled.text, rect });
      return;
    }
    handleNativeMouseUp();
  }, [isDragging, onMouseUp, onRegionCaptured, pdfPointForMouse, updatePdfSelection, clientRectForPosition, clearSelection, computeSelectionOccurrence, setSelectionInfo, handleNativeMouseUp]);

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
        <button ref={zoomPercentRef} onClick={zoomReset} className="btn-icon px-2 py-0.5 text-xs min-w-[44px] text-center tabular-nums" title="Fit page width">
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

        <span className="ml-auto flex items-center gap-2">
          {numPages > 0 && (
            <span
              className="text-[11px] tabular-nums px-2 py-0.5 rounded-full"
              style={{ color: "var(--ink-faint)", border: "1px solid var(--border-light)" }}
            >
              Page {currentPage} / {numPages}
            </span>
          )}
          <CollectionChip zoteroKey={zoteroKey} onReveal={onRevealCollection} />
        </span>
      </div>

      {/* Viewer */}
      <div className="flex-1 relative" style={{ background: "var(--parchment)" }}>
        {referencePreview && (() => {
          const width = Math.min(680, window.innerWidth - 24);
          const expectedHeight = referencePreview.data ? Math.min(390, window.innerHeight * 0.52) : 190;
          const left = Math.max(12, Math.min(referencePreview.anchor.left, window.innerWidth - width - 12));
          const below = referencePreview.anchor.bottom + 10;
          const top = below + expectedHeight <= window.innerHeight - 12
            ? below
            : Math.max(12, referencePreview.anchor.top - expectedHeight - 10);
          return (
            <div
              className="pr-reference-preview"
              role="tooltip"
              style={{ position: "fixed", left, top, width, zIndex: 80 }}
            >
              <div className="pr-reference-preview-label">
                <span>{referencePreview.label || "Reference"}</span>
                {referencePreview.data && <span>Bibliography page {referencePreview.data.pageNumber}</span>}
              </div>
              {referencePreview.loading ? (
                <div className="pr-reference-preview-loading">Loading reference…</div>
              ) : referencePreview.data ? (
                // The image is a local, in-memory crop rendered from the open PDF.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={referencePreview.data.imageUrl} alt={`Bibliography around ${referencePreview.label || "this reference"}`} />
              ) : (
                <div className="pr-reference-preview-loading">{referencePreview.error}</div>
              )}
            </div>
          );
        })()}

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
