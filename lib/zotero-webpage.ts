// What a web page rendered to PDF becomes in Zotero.
//
// Handing Zotero a bare PDF (saveStandaloneAttachment) makes it run its
// metadata recogniser, which reads the text and looks the document up — and a
// blog post *about* a paper, mentioning its arXiv id thirty-eight times, is
// "recognised" as that paper. A Zhihu note on MoE quantisation came back as
// a preprint titled "CAMERA: Multi-Matrix Joint Compression…", twice.
//
// A rendered page is a web page, so it is saved as one: a webpage item with
// the page's own title and URL, and the PDF attached to it. The connector does
// this in two calls — saveItems for the item, then saveAttachment with the
// bytes — joined by a session id, the attachment finding its parent by the
// connector key we gave the item. Nothing here triggers recognition.

export type WebpageSave = {
  title: string;
  url: string;
  sessionID: string;
  /** The key saveAttachment uses to find the item within the session */
  connectorKey: string;
  now?: Date;
};

export function webpageItemsPayload({ title, url, sessionID, connectorKey, now = new Date() }: WebpageSave) {
  return {
    sessionID,
    uri: url,
    items: [
      {
        id: connectorKey,
        itemType: "webpage",
        title: title.trim() || url,
        url,
        accessDate: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        attachments: [],
      },
    ],
  };
}

export function webpageAttachmentMetadata({ url, sessionID, connectorKey }: WebpageSave) {
  return {
    sessionID,
    parentItemID: connectorKey,
    title: "Rendered page (PDF)",
    url,
  };
}

// A page fetched from the web is a web page; a file from disk is not. The
// client says which when it knows; the URL decides otherwise.
export function savesAsWebpage(as: unknown, sourceUrl: unknown): boolean {
  if (as === "webpage") return true;
  if (as === "document") return false;
  return typeof sourceUrl === "string" && /^https?:\/\//i.test(sourceUrl.trim());
}
