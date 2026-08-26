export type ZoteroTextPosition = {
  text: string;
  pageIndex: number;
  rects: number[][];
};

export type ZoteroHighlightOptions = {
  comment?: string;
  color?: string;
};

export function standardHighlightRequest(
  attachmentKey: string,
  selection: ZoteroTextPosition,
  options: ZoteroHighlightOptions = {}
) {
  const { text, pageIndex, rects } = selection;
  return {
    attachmentKey,
    selection: { text, position: { pageIndex, rects } },
    options,
  };
}

// The client-facing operation for a normal Zotero highlight. Callers provide
// the selected text position; Zotero item fields, page labels, sort indexes,
// default colour, and serialization stay behind the endpoint.
export async function createZoteroHighlight(
  attachmentKey: string,
  selection: ZoteroTextPosition,
  options: ZoteroHighlightOptions = {}
): Promise<{ key: string }> {
  const res = await fetch("/api/zotero/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(standardHighlightRequest(attachmentKey, selection, options)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.key !== "string") {
    throw new Error(data.error || "This highlight could not be saved to Zotero.");
  }
  return { key: data.key };
}
