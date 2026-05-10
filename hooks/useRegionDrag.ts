"use client";
import { useState, useCallback, useRef } from "react";

export type DragRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionResult = {
  imageDataUrl: string;
  rect: DOMRect;
};

export function useRegionDrag(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragRegion, setDragRegion] = useState<DragRegion | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent, pageCanvas: HTMLCanvasElement, pageContainer: HTMLDivElement) => {
      if (!e.altKey) return;
      e.preventDefault();
      const rect = pageContainer.getBoundingClientRect();
      startPos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      containerRef.current = pageContainer;
      setIsDragging(true);
      setDragRegion({ x: startPos.current.x, y: startPos.current.y, width: 0, height: 0 });
    },
    []
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent, pageContainer: HTMLDivElement) => {
      if (!isDragging || !startPos.current) return;
      const rect = pageContainer.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;
      setDragRegion({
        x: Math.min(startPos.current.x, currentX),
        y: Math.min(startPos.current.y, currentY),
        width: Math.abs(currentX - startPos.current.x),
        height: Math.abs(currentY - startPos.current.y),
      });
    },
    [isDragging]
  );

  const onMouseUp = useCallback(
    (
      e: React.MouseEvent,
      pageCanvas: HTMLCanvasElement,
      pageContainer: HTMLDivElement,
      onCapture: (result: RegionResult) => void
    ) => {
      if (!isDragging || !dragRegion || dragRegion.width < 10 || dragRegion.height < 10) {
        setIsDragging(false);
        setDragRegion(null);
        startPos.current = null;
        return;
      }

      // Scale from CSS pixels to canvas pixels
      const containerRect = pageContainer.getBoundingClientRect();
      const scaleX = pageCanvas.width / containerRect.width;
      const scaleY = pageCanvas.height / containerRect.height;

      const sx = dragRegion.x * scaleX;
      const sy = dragRegion.y * scaleY;
      const sw = dragRegion.width * scaleX;
      const sh = dragRegion.height * scaleY;

      // Crop the canvas region
      const offscreen = document.createElement("canvas");
      offscreen.width = sw;
      offscreen.height = sh;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      const imageDataUrl = offscreen.toDataURL("image/png");

      const captureRect = new DOMRect(
        containerRect.left + dragRegion.x,
        containerRect.top + dragRegion.y,
        dragRegion.width,
        dragRegion.height
      );

      setIsDragging(false);
      setDragRegion(null);
      startPos.current = null;

      onCapture({ imageDataUrl, rect: captureRect });
    },
    [isDragging, dragRegion]
  );

  return { isDragging, dragRegion, onMouseDown, onMouseMove, onMouseUp };
}
