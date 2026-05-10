"use client";
import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { SelectionPopover } from "./SelectionPopover";
import { useTextSelection } from "@/hooks/useTextSelection";
import { useRegionDrag } from "@/hooks/useRegionDrag";
import { RegionResult } from "@/hooks/useRegionDrag";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const BASE_WIDTH = 700;
const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

type Props = {
  pdfDataUrl: string;
  onTextSelected: (text: string, pageNumber?: number) => void;
  onRegionCaptured: (result: RegionResult) => void;
};

export type PdfViewerHandle = {
  highlightText: (pageNumber: number, text: string) => void;
};

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { pdfDataUrl, onTextSelected, onRegionCaptured },
  ref
) {
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageCanvases = useRef<Record<number, HTMLCanvasElement>>({});
  const pageContainers = useRef<Record<number, HTMLDivElement>>({});

  const pageWidth = Math.round(BASE_WIDTH * zoom);

  const { selection, handleMouseUp, clearSelection } = useTextSelection(containerRef);
  const { isDragging, dragRegion, onMouseDown, onMouseMove, onMouseUp } = useRegionDrag(
    useRef<HTMLCanvasElement>(null)
  );

  const zoomIn    = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))), []);
  const zoomOut   = useCallback(() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))), []);
  const zoomReset = useCallback(() => setZoom(1), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => {
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + delta).toFixed(2)));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Detect which page number the current selection lives in
  const getSelectionPageNumber = useCallback((): number | undefined => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return undefined;
    const anchor = sel.anchorNode;
    for (const [num, container] of Object.entries(pageContainers.current)) {
      if (container.contains(anchor)) return parseInt(num);
    }
    return undefined;
  }, []);

  const handleExplain = useCallback(() => {
    if (selection) {
      const pageNumber = getSelectionPageNumber();
      onTextSelected(selection.text, pageNumber);
      clearSelection();
    }
  }, [selection, onTextSelected, clearSelection, getSelectionPageNumber]);

  // Imperative handle: scroll to page then use window.find() to highlight the text
  useImperativeHandle(ref, () => ({
    highlightText(pageNumber: number, text: string) {
      const container = pageContainers.current[pageNumber];
      if (!container) return;

      container.scrollIntoView({ behavior: "smooth", block: "center" });

      // After scroll settles, place cursor in the page's text layer then search
      setTimeout(() => {
        const textLayer = container.querySelector(".react-pdf__Page__textContent");
        const firstNode = textLayer?.firstChild;
        if (firstNode) {
          const range = document.createRange();
          range.setStart(firstNode, 0);
          range.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        // window.find(text, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
        (window as any).find(text, false, false, false, false, false, false);
      }, 350);
    },
  }));

  const handlePageMouseDown = useCallback((e: React.MouseEvent, pageNum: number) => {
    const canvas = pageCanvases.current[pageNum];
    const container = pageContainers.current[pageNum];
    if (canvas && container) onMouseDown(e, canvas, container);
  }, [onMouseDown]);

  const handlePageMouseMove = useCallback((e: React.MouseEvent, pageNum: number) => {
    const container = pageContainers.current[pageNum];
    if (container) onMouseMove(e, container);
  }, [onMouseMove]);

  const handlePageMouseUp = useCallback((e: React.MouseEvent, pageNum: number) => {
    const canvas = pageCanvases.current[pageNum];
    const container = pageContainers.current[pageNum];
    if (canvas && container) onMouseUp(e, canvas, container, onRegionCaptured);
  }, [onMouseUp, onRegionCaptured]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
        <span className="text-[10px] uppercase tracking-widest mr-1" style={{ color: "var(--ink-faint)" }}>Zoom</span>
        <button onClick={zoomOut} disabled={zoom <= ZOOM_MIN} className="btn-icon w-7 h-7 text-base leading-none" title="Zoom out (Ctrl+scroll)">−</button>
        <button onClick={zoomReset} className="btn-icon px-2 py-0.5 text-xs min-w-[44px] text-center tabular-nums" title="Reset zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={zoomIn} disabled={zoom >= ZOOM_MAX} className="btn-icon w-7 h-7 text-base leading-none" title="Zoom in (Ctrl+scroll)">+</button>
        {numPages > 0 && (
          <span className="ml-auto text-xs tabular-nums" style={{ color: "var(--ink-faint)" }}>{numPages}p</span>
        )}
      </div>

      {/* Scrollable PDF area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-auto p-6"
        onMouseUp={handleMouseUp}
        style={{ background: "var(--parchment)", cursor: isDragging ? "crosshair" : "default" }}
      >
        {selection && !isDragging && (
          <SelectionPopover rect={selection.rect} onExplain={handleExplain} onDismiss={clearSelection} />
        )}

        <Document
          file={pdfDataUrl}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={<div className="flex items-center justify-center h-48 text-sm" style={{ color: "var(--ink-faint)" }}>Loading PDF…</div>}
          error={<div className="flex items-center justify-center h-48 text-sm" style={{ color: "#F87171" }}>Failed to load PDF</div>}
        >
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
            <div
              key={pageNum}
              ref={(el) => { if (el) pageContainers.current[pageNum] = el; }}
              className="relative bg-white select-text inline-block mb-5"
              style={{ boxShadow: "0 2px 16px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.4)" }}
              onMouseDown={(e) => handlePageMouseDown(e, pageNum)}
              onMouseMove={(e) => handlePageMouseMove(e, pageNum)}
              onMouseUp={(e) => handlePageMouseUp(e, pageNum)}
            >
              <Page
                pageNumber={pageNum}
                width={pageWidth}
                renderTextLayer={true}
                renderAnnotationLayer={false}
                canvasRef={(canvas) => { if (canvas) pageCanvases.current[pageNum] = canvas; }}
              />

              {isDragging && dragRegion && (
                <div
                  style={{
                    position: "absolute",
                    left: dragRegion.x, top: dragRegion.y,
                    width: dragRegion.width, height: dragRegion.height,
                    border: "2px dashed var(--accent)",
                    background: "rgba(232,120,76,0.08)",
                    pointerEvents: "none",
                  }}
                />
              )}

              <div className="absolute bottom-1 right-2 text-[10px] select-none tabular-nums" style={{ color: "var(--ink-faint)" }}>
                {pageNum}/{numPages}
              </div>
            </div>
          ))}
        </Document>

        {numPages > 0 && (
          <p className="text-center text-xs pb-4" style={{ color: "var(--ink-faint)" }}>
            Hold <kbd className="px-1 rounded text-[11px]" style={{ background: "var(--border)", color: "var(--ink-muted)" }}>Alt</kbd> + drag to capture a figure or graph
          </p>
        )}
      </div>
    </div>
  );
});
