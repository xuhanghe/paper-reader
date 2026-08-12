"use client";
import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { SelectionPopover } from "./SelectionPopover";
import { HighlightPopover } from "./HighlightPopover";
import { clearMarks, markTextInContainer, rangeForText } from "@/lib/highlight-dom";
import type { Highlight } from "@/types/session";
import type { AnnotationPosition, PdfViewerHandle } from "./PdfViewer";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.15;
const FLASH_MS = 1700;

type Props = {
  html: string;
  onTextSelected: (text: string) => void;
  onAskAboutSelection: (text: string, question: string) => void;
  // Highlights on a snapshot have no PDF page or rects, so these are called
  // without a position — which is exactly what keeps them out of Zotero (see
  // the note on the highlight stylesheet below).
  onHighlight?: (text: string, pageNumber?: number, position?: AnnotationPosition, color?: string) => void;
  onNote?: (text: string, note: string, pageNumber?: number, position?: AnnotationPosition, color?: string) => void;
  onRemoveHighlight?: (id: string) => void;
  onRecolorHighlight?: (id: string, color: string) => void;
  onEditHighlightNote?: (id: string, note: string) => void;
  onHighlightClick?: (id: string) => void;
  highlights?: Highlight[];
  // Re-reads the snapshot from Zotero; absent for materials not stored there
  onReload?: () => void;
  reloading?: boolean;
};

type SelectionInfo = { text: string; rect: DOMRect };

// Highlight styling for the iframe document. The app's own stylesheet does not
// reach inside it, so the rules travel with the snapshot.
//
// Unlike the PDF viewer — where marks stay transparent and separate .pr-band
// boxes are drawn over the canvas to work around the text layer's font-metric
// offset — a snapshot's marks wrap the real text, so they can be painted
// directly. Same colour, same multiply blend, so both readers show one
// highlight effect.
const HIGHLIGHT_CSS = `
mark.pr-highlight {
  background: #ffd400;
  color: inherit;
  border-radius: 2px;
  cursor: pointer;
  mix-blend-mode: multiply;
  padding: 0;
}
mark.pr-highlight.pr-has-note {
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.35);
}
mark.pr-temp-flash {
  background: rgba(113, 173, 253, 0.4);
  color: inherit;
  border-radius: 2px;
  padding: 0;
  mix-blend-mode: multiply;
}
@keyframes pr-mark-flash {
  0%, 100% { filter: none; }
  50%      { filter: brightness(0.82); }
}
mark.pr-mark-flash { animation: pr-mark-flash 0.55s ease-in-out 3; }
/* Zotero's SELECTION_COLOR (#71ADFD) at the alpha it uses on light pages */
::selection { background: rgba(113, 173, 253, 0.4); }
::-moz-selection { background: rgba(113, 173, 253, 0.4); }
`;

// Renders a Zotero HTML snapshot in a sandboxed iframe (scripts disabled).
// Selection events are read from the iframe document and mapped to viewport
// coordinates so the same explain/ask/highlight popovers work as for PDFs.
export const HtmlViewer = forwardRef<PdfViewerHandle, Props>(function HtmlViewer(
  {
    html,
    onTextSelected,
    onAskAboutSelection,
    onHighlight,
    onNote,
    onRemoveHighlight,
    onRecolorHighlight,
    onEditHighlightNote,
    onHighlightClick,
    highlights = [],
    onReload,
    reloading,
  },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [zoom, setZoom] = useState(1);

  // Read from event handlers that must not be re-bound every time a highlight
  // changes — the listeners live on the iframe document, rebuilt only on load
  const highlightsRef = useRef<Highlight[]>(highlights);
  highlightsRef.current = highlights;
  const clickRef = useRef(onHighlightClick);
  useEffect(() => {
    clickRef.current = onHighlightClick;
  }, [onHighlightClick]);

  const applyZoom = useCallback((z: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    setZoom(clamped);
    const body = iframeRef.current?.contentDocument?.body;
    if (body) (body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(clamped);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges();
  }, []);

  // Content coordinates → page viewport, so the popovers (which live in the
  // parent document) land on the passage
  const toViewport = useCallback((rect: DOMRect): DOMRect => {
    const frame = iframeRef.current?.getBoundingClientRect();
    return new DOMRect(rect.left + (frame?.left ?? 0), rect.top + (frame?.top ?? 0), rect.width, rect.height);
  }, []);

  // ── Persistent highlights ───────────────────────────────────────
  const paintHighlights = useCallback(() => {
    const body = iframeRef.current?.contentDocument?.body;
    if (!body) return;
    clearMarks(body, "pr-highlight");
    for (const h of highlightsRef.current) {
      if (!h.text?.trim()) continue;
      markTextInContainer(
        body,
        h.text,
        ["pr-highlight", h.note ? "pr-has-note" : ""].filter(Boolean).join(" "),
        h.note || undefined,
        { id: h.id, color: h.color }
      );
    }
  }, []);

  useEffect(() => {
    paintHighlights();
  }, [highlights, paintHighlights]);

  const flashMarks = useCallback((id: string) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const marks = Array.from(
      doc.querySelectorAll(`mark.pr-highlight[data-highlight-id="${CSS.escape(id)}"]`)
    ) as HTMLElement[];
    marks.forEach((m) => m.classList.add("pr-mark-flash"));
    setTimeout(() => marks.forEach((m) => m.classList.remove("pr-mark-flash")), FLASH_MS);
  }, []);

  // Login walls and modal overlays get frozen into fetched snapshots (scripts
  // are disabled in the iframe, so their close buttons are dead) — remove them
  // and unlock scrolling.
  const stripOverlays = useCallback((doc: Document) => {
    const win = doc.defaultView;
    if (!win || !doc.body) return;
    const kill = (el: Element) => {
      if (el === doc.body || el === doc.documentElement) return;
      el.remove();
    };

    doc
      .querySelectorAll(
        '[role="dialog"], [class*="Modal"], [class*="signFlow"], [class*="LoginBar"], [class*="login-modal"], [class*="Popover-backdrop"], [class*="backdrop"]'
      )
      .forEach(kill);

    // Generic catch-all: fixed overlays near the body root covering most of the viewport
    const vw = win.innerWidth || 1;
    const vh = win.innerHeight || 1;
    doc.body.querySelectorAll(":scope > div, :scope > div > div").forEach((el) => {
      if (win.getComputedStyle(el).position !== "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.5 && r.height >= vh * 0.5) kill(el);
    });

    // Undo the scroll lock modals leave behind
    doc.documentElement.style.setProperty("overflow", "auto", "important");
    doc.body.style.setProperty("overflow", "auto", "important");
  }, []);

  const handleFrameLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.body.style.background = "#fff";
    stripOverlays(doc);

    const style = doc.createElement("style");
    style.textContent = HIGHLIGHT_CSS;
    (doc.head || doc.documentElement).appendChild(style);

    // Marks are wrapped into the snapshot after the overlay strip, so a reload
    // (or switching papers) repaints onto the fresh document
    paintHighlights();

    doc.addEventListener("mouseup", (e) => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        setHighlightMenu(null);
        setSelection({
          text: sel.toString().trim(),
          rect: toViewport(sel.getRangeAt(0).getBoundingClientRect()),
        });
        return;
      }
      setSelection(null);
      // A plain click on an existing highlight opens its menu and reveals the
      // matching entry in the Notes panel
      const mark = (e.target as HTMLElement)?.closest?.("mark.pr-highlight") as HTMLElement | null;
      const id = mark?.dataset.highlightId;
      if (!mark || !id) {
        setHighlightMenu(null);
        return;
      }
      setHighlightMenu({ id, rect: toViewport(mark.getBoundingClientRect()) });
      clickRef.current?.(id);
    });
  }, [stripOverlays, paintHighlights, toViewport]);

  useImperativeHandle(ref, () => ({
    // Flash a passage that has no persistent highlight — a mindmap quote, or a
    // highlight whose text no longer matches the snapshot
    highlightText(_pageNumber: number, text: string) {
      const body = iframeRef.current?.contentDocument?.body;
      if (!body) return;
      clearMarks(body, "pr-temp-flash");
      const range = rangeForText(body, text);
      if (!range) {
        const win = iframeRef.current?.contentWindow;
        (win as (Window & { find?: (...args: unknown[]) => boolean }) | null)?.find?.(
          text, false, false, true, false, false, false
        );
        return;
      }
      (range.startContainer.parentElement ?? body).scrollIntoView({ behavior: "smooth", block: "center" });
      markTextInContainer(body, text, "pr-temp-flash");
      setTimeout(() => {
        const stillThere = iframeRef.current?.contentDocument?.body;
        if (stillThere) clearMarks(stillThere, "pr-temp-flash");
      }, FLASH_MS);
    },
    async scrollToHighlight(id: string) {
      const doc = iframeRef.current?.contentDocument;
      const mark = doc?.querySelector(`mark.pr-highlight[data-highlight-id="${CSS.escape(id)}"]`);
      if (!mark) return false;
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      flashMarks(id);
      return true;
    },
    async getDocumentText(maxChars = 60000) {
      const body = iframeRef.current?.contentDocument?.body;
      if (!body) return null;
      return body.innerText.replace(/\u0000/g, " ").replace(/\n{3,}/g, "\n\n").slice(0, maxChars);
    },
  }));

  const menuHighlight = highlightMenu ? highlights.find((h) => h.id === highlightMenu.id) : undefined;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
        <span className="text-[10px] uppercase tracking-widest mr-1" style={{ color: "var(--ink-faint)" }}>Zoom</span>
        <button onClick={() => applyZoom(zoom / ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} className="btn-icon w-7 h-7 text-base leading-none" title="Zoom out">−</button>
        <button onClick={() => applyZoom(1)} className="btn-icon px-2 py-0.5 text-xs min-w-[44px] text-center tabular-nums" title="Reset zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => applyZoom(zoom * ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} className="btn-icon w-7 h-7 text-base leading-none" title="Zoom in">+</button>
        {onReload && (
          <button
            onClick={onReload}
            disabled={reloading}
            className="btn-icon w-7 h-7 text-sm leading-none ml-1"
            style={reloading ? { opacity: 0.5 } : undefined}
            title="Reload this snapshot from Zotero"
          >
            <span className={reloading ? "pr-spin inline-block" : "inline-block"}>↻</span>
          </button>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>HTML snapshot</span>
      </div>

      {selection && (
        <SelectionPopover
          rect={selection.rect}
          selectedText={selection.text}
          onExplain={() => { onTextSelected(selection.text); clearSelection(); }}
          onAsk={(q) => { onAskAboutSelection(selection.text, q); clearSelection(); }}
          onHighlight={onHighlight && ((color) => { onHighlight(selection.text, undefined, undefined, color); clearSelection(); })}
          onNote={onNote && ((note, color) => { onNote(selection.text, note, undefined, undefined, color); clearSelection(); })}
          onDismiss={clearSelection}
        />
      )}

      {highlightMenu && (
        <HighlightPopover
          rect={highlightMenu.rect}
          color={menuHighlight?.color}
          note={menuHighlight?.note}
          onRecolor={(color) => { onRecolorHighlight?.(highlightMenu.id, color); setHighlightMenu(null); }}
          onEditNote={(note) => { onEditHighlightNote?.(highlightMenu.id, note); setHighlightMenu(null); }}
          onRemove={() => { onRemoveHighlight?.(highlightMenu.id); setHighlightMenu(null); }}
          onDismiss={() => setHighlightMenu(null)}
        />
      )}

      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-same-origin"
        onLoad={handleFrameLoad}
        className="flex-1 w-full"
        style={{ border: "none", background: "#fff" }}
        title="HTML snapshot"
      />
    </div>
  );
});
