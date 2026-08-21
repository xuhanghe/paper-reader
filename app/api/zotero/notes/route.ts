import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";

// Annotations are read by paging the whole library (see fetchAnnotations)
const ANNOTATION_PAGE = 100;
const ANNOTATION_PAGE_LIMIT = 25;

type ZoteroChild = {
  key: string;
  data: {
    itemType?: string;
    note?: string;
    contentType?: string;
    parentItem?: string;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPosition?: string;
  };
};

async function fetchJson(url: string): Promise<{ body: ZoteroChild[]; total: number } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!res.ok) return null;
  return { body: (await res.json()) as ZoteroChild[], total: Number(res.headers.get("Total-Results") || 0) };
}

async function fetchChildren(key: string): Promise<ZoteroChild[]> {
  const r = await fetchJson(`${ZOTERO_BASE}/items/${encodeURIComponent(key)}/children`);
  return r?.body || [];
}

// Zotero's local API answers /items/<key>/children with notes and attachments
// only — annotations are never included, for any item. The only way to reach
// them locally is to page over the library's annotation items and keep the ones
// parented to this attachment. Requests are local and cheap (~25ms each).
async function fetchAnnotations(attachmentKey: string): Promise<ZoteroChild[]> {
  const out: ZoteroChild[] = [];
  for (let page = 0; page < ANNOTATION_PAGE_LIMIT; page++) {
    const start = page * ANNOTATION_PAGE;
    const r = await fetchJson(
      `${ZOTERO_BASE}/items?itemType=annotation&limit=${ANNOTATION_PAGE}&start=${start}`
    );
    if (!r) break;
    out.push(...r.body.filter((c) => c.data?.parentItem === attachmentKey));
    if (r.body.length < ANNOTATION_PAGE || start + r.body.length >= r.total) break;
  }
  return out;
}

// Child notes on an item, plus PDF annotations (highlights/notes made in
// Zotero's reader, or written back by this app) with their page and colour
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")?.trim();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  try {
    const item = (await fetchJson(`${ZOTERO_BASE}/items/${encodeURIComponent(key)}`)) as
      | { body: unknown }
      | null;
    const itemData = (item?.body as ZoteroChild | undefined)?.data;

    // A PDF saved without metadata recognition is a *standalone attachment*:
    // it has no children, and its annotations hang directly off it.
    const standalone = itemData?.itemType === "attachment";
    const children = standalone ? [] : await fetchChildren(key);

    const notes = children
      .filter((c) => c.data?.itemType === "note" && c.data.note?.trim())
      .map((c) => ({ key: c.key, html: c.data.note! }));

    const attachmentKey = standalone
      ? key
      : children.find((c) => c.data?.contentType === "application/pdf")?.key;

    const annotations = attachmentKey
      ? (await fetchAnnotations(attachmentKey))
          .filter((c) => c.data.annotationText?.trim() || c.data.annotationComment?.trim())
          .map((c) => {
            let page: number | undefined;
            let position: { pageIndex: number; rects: number[][] } | undefined;
            try {
              const pos = JSON.parse(c.data.annotationPosition || "{}");
              if (typeof pos.pageIndex === "number") {
                page = pos.pageIndex + 1;
                // Zotero's own rects say exactly where the annotation sits —
                // the reader paints from them instead of re-deriving the spot
                // from text matching
                if (Array.isArray(pos.rects) && pos.rects.length) {
                  position = { pageIndex: pos.pageIndex, rects: pos.rects };
                }
              }
            } catch {
              // position unavailable — jump will fall back to text search
            }
            return {
              key: c.key,
              text: c.data.annotationText || "",
              comment: c.data.annotationComment || "",
              page,
              position,
              type: c.data.annotationType || "highlight",
              color: c.data.annotationColor || undefined,
            };
          })
      : [];

    return Response.json({ notes, annotations });
  } catch {
    // Reported as a failure, not as "no annotations" — the reader treats an
    // empty successful read as evidence that annotations were deleted
    return Response.json({ error: "Could not reach Zotero.", notes: [], annotations: [] }, { status: 502 });
  }
}
