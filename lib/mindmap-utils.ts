import type { Mindmap, MindmapNode } from "@/types/session";

// Pull the mind map JSON out of a model response that may include
// code fences or surrounding prose, and validate its shape.
export function extractMindmapJson(text: string): Mindmap | null {
  if (!text) return null;

  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeMindmap(parsed);
      if (normalized) return normalized;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function normalizeMindmap(value: unknown): Mindmap | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) return null;
  const children = normalizeChildren(obj.children);
  if (children.length === 0) return null;
  return { title: obj.title.trim(), children };
}

function normalizeChildren(value: unknown, depth = 0): MindmapNode[] {
  if (!Array.isArray(value) || depth > 4) return [];
  const nodes: MindmapNode[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.label !== "string" || !obj.label.trim()) continue;
    const node: MindmapNode = { label: obj.label.trim() };
    if (typeof obj.note === "string" && obj.note.trim()) node.note = obj.note.trim();
    if (typeof obj.quote === "string" && obj.quote.trim()) node.quote = obj.quote.trim();
    if (typeof obj.page === "number" && Number.isFinite(obj.page) && obj.page >= 1) node.page = Math.floor(obj.page);
    const children = normalizeChildren(obj.children, depth + 1);
    if (children.length > 0) node.children = children;
    nodes.push(node);
  }
  return nodes;
}
