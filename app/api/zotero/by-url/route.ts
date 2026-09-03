import { NextRequest } from "next/server";
import { ZOTERO_BASE } from "@/lib/zotero-server";

export const runtime = "nodejs";

type ZoteroItem = {
  key: string;
  data: { itemType?: string; title?: string; url?: string; parentItem?: string; deleted?: number };
};

// Is this URL already in the library? Quick search does not look at URLs, but
// its "everything" mode does — attachments included, which is where a saved
// page's URL usually lives. Matches are reported by the entry the reader would
// see: the parent item when the hit is an attachment.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")?.trim() || "";
  if (!url) return Response.json({ items: [] });

  const wanted = normalise(url);
  try {
    const params = new URLSearchParams({ q: url, qmode: "everything", limit: "25" });
    const res = await fetch(`${ZOTERO_BASE}/items?${params}`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (!res.ok) return Response.json({ items: [] });
    const hits = ((await res.json()) as ZoteroItem[]).filter((item) => normalise(item.data.url ?? "") === wanted);

    const seen = new Set<string>();
    const items: { key: string; title: string; itemType: string }[] = [];
    for (const hit of hits) {
      const shown = hit.data.parentItem ? await fetchItem(hit.data.parentItem) : hit;
      if (!shown || seen.has(shown.key)) continue;
      seen.add(shown.key);
      items.push({ key: shown.key, title: shown.data.title || url, itemType: shown.data.itemType || "" });
    }
    return Response.json({ items });
  } catch {
    return Response.json({ items: [] });
  }
}

async function fetchItem(key: string): Promise<ZoteroItem | null> {
  try {
    const res = await fetch(`${ZOTERO_BASE}/items/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    return res.ok ? ((await res.json()) as ZoteroItem) : null;
  } catch {
    return null;
  }
}

// http/https, trailing slash and fragment do not make a different page
function normalise(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}
