import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";

type ZoteroCreator = { firstName?: string; lastName?: string; name?: string };
type ZoteroItem = {
  key: string;
  data: {
    title?: string;
    creators?: ZoteroCreator[];
    date?: string;
    itemType?: string;
    contentType?: string;
    parentItem?: string;
  };
};

// Attachments the reader can display; other kinds (links, images) are skipped
const READABLE_TYPES = ["application/pdf", "text/html"];

function formatCreators(creators: ZoteroCreator[] = []): string {
  const names = creators.map((c) => c.lastName || c.name || c.firstName || "").filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} et al.`;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  const collection = req.nextUrl.searchParams.get("collection")?.trim() || "";

  // Notes are excluded, attachments are not: a PDF saved without metadata
  // recognition is a *standalone* attachment and is a perfectly good entry.
  // (The /top endpoints already omit attachments that belong to a parent.)
  const params = new URLSearchParams({
    limit: "100",
    sort: collection ? "title" : "dateModified",
    direction: collection ? "asc" : "desc",
    itemType: "-note",
  });
  if (q) params.set("q", q);

  const base = collection
    ? `${ZOTERO_BASE}/collections/${encodeURIComponent(collection)}/items/top`
    : `${ZOTERO_BASE}/items/top`;

  try {
    const res = await fetch(`${base}?${params}`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: `Zotero responded with ${res.status}. Is the local API enabled?` },
        { status: 502 }
      );
    }
    const items = (await res.json()) as ZoteroItem[];
    const mapped = items
      .filter((i) => i.data?.title)
      .filter(
        (i) =>
          i.data.itemType !== "attachment" ||
          (!i.data.parentItem && READABLE_TYPES.includes(i.data.contentType || ""))
      )
      .map((i) => ({
        key: i.key,
        title: i.data.title!,
        creators: formatCreators(i.data.creators),
        year: (i.data.date?.match(/\d{4}/) || [""])[0],
        itemType: i.data.itemType || "",
      }));
    return Response.json({ items: mapped });
  } catch {
    return Response.json(
      {
        error:
          "Could not reach Zotero. Make sure Zotero is running and “Allow other applications on this computer to communicate with Zotero” is enabled in Settings → Advanced.",
      },
      { status: 502 }
    );
  }
}
