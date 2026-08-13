import type { NextRequest } from "next/server";
import { ZOTERO_WEB_API, getWebUserId, webApiKey } from "@/lib/zotero-server";

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

// Move an item to Zotero's trash.
//
// Deliberately not the web API's DELETE, which erases an item outright with no
// way back. Setting deleted=1 puts it in the trash, where Zotero's own UI can
// restore it — removing somebody's paper from a sidebar should not be the
// irreversible kind of removal. Child attachments and annotations follow the
// parent into the trash, as they do in Zotero itself.
export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")?.trim();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  const apiKey = webApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Removing items needs ZOTERO_API_KEY in .env.local — the local Zotero API is read-only." },
      { status: 400 }
    );
  }
  const userId = await getWebUserId();
  if (!userId) return Response.json({ error: "Could not determine your Zotero user ID." }, { status: 502 });

  try {
    const itemUrl = `${ZOTERO_WEB_API}/users/${userId}/items/${encodeURIComponent(key)}`;
    const itemRes = await fetch(itemUrl, {
      headers: { "Zotero-API-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!itemRes.ok) {
      return Response.json(
        { error: `That item isn't on zotero.org yet (${itemRes.status}) — it may still be syncing.` },
        { status: 404 }
      );
    }
    const item = await itemRes.json();

    const patchRes = await fetch(itemUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Zotero-API-Key": apiKey,
        "If-Unmodified-Since-Version": String(item.version),
      },
      body: JSON.stringify({ deleted: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!patchRes.ok && patchRes.status !== 204) {
      return Response.json({ error: `Zotero refused the change (${patchRes.status}).` }, { status: 502 });
    }
    return Response.json({ ok: true, trashed: key });
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }
}
