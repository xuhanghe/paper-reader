// Zotero's eight annotation colours, verbatim from its ANNOTATION_COLORS
// (Zotero app → omni.ja → src/common/defines.js), so highlights made here and
// in Zotero's own reader are indistinguishable.
export const HIGHLIGHT_COLORS = [
  { id: "yellow", hex: "#ffd400", label: "Yellow" },
  { id: "red", hex: "#ff6666", label: "Red" },
  { id: "green", hex: "#5fb236", label: "Green" },
  { id: "blue", hex: "#2ea8e5", label: "Blue" },
  { id: "purple", hex: "#a28ae5", label: "Purple" },
  { id: "magenta", hex: "#e56eee", label: "Magenta" },
  { id: "orange", hex: "#f19837", label: "Orange" },
  { id: "gray", hex: "#aaaaaa", label: "Gray" },
] as const;

export const DEFAULT_HIGHLIGHT_COLOR = "#ffd400";

export function isHighlightColor(hex: unknown): hex is string {
  return typeof hex === "string" && HIGHLIGHT_COLORS.some((c) => c.hex === hex.toLowerCase());
}

// Painted translucent so the page text stays readable underneath
export function highlightTint(hex: string, alpha = 0.4): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
