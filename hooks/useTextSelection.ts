"use client";
import { useState, useCallback } from "react";

export type SelectionInfo = {
  text: string;
  rect: DOMRect;
};

export function useTextSelection(containerRef: React.RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  // PdfViewer's PDF-coordinate selection controller supplies the same small
  // view model as the native fallback. Keeping the state here means the
  // popover and its consumers do not need to know which selection path won.
  const setSelectionInfo = useCallback((next: SelectionInfo | null) => {
    setSelection(next);
  }, []);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      setSelection(null);
      return;
    }

    // Only trigger if the selection is inside the container
    if (containerRef.current) {
      const range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      if (!containerRef.current.contains(ancestor)) {
        setSelection(null);
        return;
      }
    }

    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setSelection({ text, rect });
  }, [containerRef]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { selection, setSelectionInfo, handleMouseUp, clearSelection };
}
