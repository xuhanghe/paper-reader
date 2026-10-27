// A paper's PDF as a data URL, wherever it lives: in this session's cache, in
// Zotero, or in a local Reader session. Shared by the Workspace's viewer and
// its "copy into the folder", and with the Reader through the cache, so
// crossing surfaces reuses the bytes already fetched.
//
// Client-only.
import type { MaterialTab } from "@/components/MaterialTabs";
import { cacheDocument, getCachedDocument } from "@/lib/document-cache";

export function safePdfName(name: string) {
  const stem = name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "paper";
  return `${stem}.pdf`;
}

export async function responseAsDataUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the PDF."));
    reader.readAsDataURL(blob);
  });
}

export async function loadPaperData(paper: MaterialTab): Promise<{ data: string; attachmentKey?: string }> {
  // Shared with the Reader, so crossing surfaces reuses the bytes already
  // fetched rather than pulling the whole PDF from Zotero again
  const cached = getCachedDocument(paper.id);
  if (cached) return { data: cached, attachmentKey: paper.attachmentKey };
  if (paper.zoteroKey) {
    const response = await fetch(`/api/zotero/file?key=${encodeURIComponent(paper.zoteroKey)}`);
    if (!response.ok) throw new Error("Could not load this paper from Zotero.");
    const data = await responseAsDataUrl(response);
    cacheDocument(paper.id, data);
    return { data, attachmentKey: response.headers.get("X-Attachment-Key") || paper.attachmentKey };
  }
  const response = await fetch(`/api/sessions?id=${encodeURIComponent(paper.id)}`);
  if (!response.ok) throw new Error("This local paper is no longer available.");
  const payload = await response.json();
  if (!payload.state?.pdfDataUrl) throw new Error("This local paper has no saved document data.");
  cacheDocument(paper.id, payload.state.pdfDataUrl);
  return { data: payload.state.pdfDataUrl, attachmentKey: paper.attachmentKey };
}

/** A PDF in the workspace folder, by its path there; `id` keys it in the cache. */
export async function loadWorkspacePdf(root: string, path: string, id: string): Promise<string> {
  const cached = getCachedDocument(id);
  if (cached) return cached;
  const response = await fetch(`/api/workspaces/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&raw=1`);
  if (!response.ok) throw new Error("Could not read this workspace PDF.");
  const data = await responseAsDataUrl(response);
  cacheDocument(id, data);
  return data;
}
