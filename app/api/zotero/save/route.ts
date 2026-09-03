import { randomUUID } from "node:crypto";
import { savesAsWebpage, webpageAttachmentMetadata, webpageItemsPayload } from "@/lib/zotero-webpage";

export const runtime = "nodejs";

const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";

// HTTP headers must be ASCII — titles with CJK (or any non-Latin script) throw
// when set directly. JSON \uXXXX escapes survive Zotero's JSON.parse intact.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

// File the session's items under the chosen target ("L1" = library root,
// "C<id>" = collection). A failure here leaves the item in the library root.
async function fileUnder(sessionID: string, target: unknown): Promise<string | undefined> {
  if (!target || typeof target !== "string") return undefined;
  const moveRes = await fetch(`${CONNECTOR_BASE}/connector/updateSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID, target, tags: "" }),
    signal: AbortSignal.timeout(10000),
  });
  return moveRes.ok
    ? undefined
    : "Saved to Zotero, but filing into the chosen collection failed — it's in your library root.";
}

// Save a PDF into Zotero via the connector API.
//
// A paper from disk goes in as a standalone attachment: Zotero runs metadata
// recognition on it and builds the bibliographic item itself, which is what
// you want for a paper.
//
// A web page rendered to PDF must not go that way. Recognition reads the text
// and looks the document up — and a blog post *about* a paper, mentioning its
// arXiv id throughout, comes back "recognised" as that paper. So a page is
// saved as a webpage item carrying its own title and URL, with the PDF
// attached to it (see lib/zotero-webpage.ts).
export async function POST(req: Request) {
  const { name, data_base64, target, source_url, as } = await req.json();

  if (!name || typeof data_base64 !== "string" || !data_base64.trim()) {
    return Response.json({ error: "name and data_base64 are required" }, { status: 400 });
  }

  const bytes = Buffer.from(data_base64.replace(/^data:application\/pdf;base64,/, ""), "base64");
  const sessionID = randomUUID().replace(/-/g, "").slice(0, 8);
  const title = String(name).replace(/\.pdf$/i, "");
  const sourceUrl = typeof source_url === "string" && source_url.trim() ? source_url.trim() : undefined;

  try {
    if (savesAsWebpage(as, sourceUrl)) {
      const save = { title, url: sourceUrl!, sessionID, connectorKey: `paper-reader-${sessionID}` };
      const itemRes = await fetch(`${CONNECTOR_BASE}/connector/saveItems`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webpageItemsPayload(save)),
        signal: AbortSignal.timeout(30000),
      });
      if (!itemRes.ok) {
        return Response.json(
          { error: `Zotero refused the page (${itemRes.status}). Is Zotero running?` },
          { status: 502 }
        );
      }
      const attachRes = await fetch(`${CONNECTOR_BASE}/connector/saveAttachment`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "X-Metadata": asciiJson(webpageAttachmentMetadata(save)) },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(30000),
      });
      const warning = attachRes.ok
        ? await fileUnder(sessionID, target)
        : `Saved the page to Zotero, but attaching the PDF failed (${attachRes.status}).`;
      return Response.json(warning ? { ok: true, warning } : { ok: true });
    }

    const saveRes = await fetch(`${CONNECTOR_BASE}/connector/saveStandaloneAttachment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Metadata": asciiJson({
          url: sourceUrl ?? `file:///${encodeURIComponent(name)}`,
          title,
          sessionID,
        }),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30000),
    });
    if (!saveRes.ok) {
      return Response.json(
        { error: `Zotero refused the save (${saveRes.status}). Is Zotero running?` },
        { status: 502 }
      );
    }
    const warning = await fileUnder(sessionID, target);
    return Response.json(warning ? { ok: true, warning } : { ok: true });
  } catch (err) {
    console.error("[zotero/save]", err);
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Saving to Zotero failed: ${detail}. If Zotero isn't running, start it and try again.` },
      { status: 502 }
    );
  }
}
