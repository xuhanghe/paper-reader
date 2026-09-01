import type { NextRequest } from "next/server";
import { ZOTERO_WEB_API, getWebUserId, webApiKey } from "@/lib/zotero-server";

export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";

type ZoteroItem = { data?: { parentItem?: string; collections?: string[] } };
type ZoteroCollection = { key: string; data?: { name?: string; parentCollection?: string | false } };

// "missing" and "unreachable" get different answers: telling someone Zotero
// is down when it simply doesn't have that item sends them to fix the wrong
// thing.
type Fetched<T> = { ok: true; data: T } | { ok: false; reason: "missing" | "unreachable" };

async function zotero<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${ZOTERO_BASE}${path}`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    return { ok: false, reason: res.status === 404 ? "missing" : "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

// Full "Parent › Child" trail, so a bare "Papers" nested under two different
// projects isn't ambiguous. Depth-capped in case a library ever has a cycle.
export function trail(key: string, byKey: Map<string, ZoteroCollection>): string[] {
  const names: string[] = [];
  let current: string | undefined = key;
  for (let depth = 0; current && depth < 12; depth++) {
    const collection: ZoteroCollection | undefined = byKey.get(current);
    if (!collection?.data?.name) break;
    names.unshift(collection.data.name);
    const parent = collection.data.parentCollection;
    current = parent ? parent : undefined;
  }
  return names;
}

// Which collections the open paper sits in. Attachments don't carry
// membership — it lives on the parent item — so a standalone-attachment key
// and a regular item key both have to resolve here.
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")?.trim();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  const item = await zotero<ZoteroItem>(`/items/${encodeURIComponent(key)}`);
  if (!item.ok) {
    return item.reason === "missing"
      ? Response.json({ collections: [] }) // not in Zotero — simply nothing to show
      : Response.json({ error: "Could not reach Zotero." }, { status: 502 });
  }

  const parentKey = item.data.data?.parentItem;
  const owner = parentKey ? await zotero<ZoteroItem>(`/items/${encodeURIComponent(parentKey)}`) : item;
  const memberships = (owner.ok ? owner.data.data?.collections : undefined) ?? [];
  if (!memberships.length) return Response.json({ collections: [] });

  // One paginated pass over the library's collections beats a request per
  // membership, and the tree is needed anyway to build the trail
  const all: ZoteroCollection[] = [];
  for (let start = 0; start < 1000; start += 100) {
    const page = await zotero<ZoteroCollection[]>(`/collections?limit=100&start=${start}`);
    if (!page.ok) break;
    all.push(...page.data);
    if (page.data.length < 100) break;
  }
  const byKey = new Map(all.map((collection) => [collection.key, collection]));

  const collections = memberships
    .map((collectionKey) => ({ key: collectionKey, names: trail(collectionKey, byKey) }))
    .filter((entry) => entry.names.length)
    .map((entry) => ({
      key: entry.key,
      name: entry.names[entry.names.length - 1],
      path: entry.names.join(" › "),
    }));

  return Response.json({ collections });
}

// Move a paper from one collection into another.
//
// Zotero's local API is read-only, so this goes through zotero.org and syncs
// back down, the same route the trash and annotation writes take.
//
// `from` is optional: dragging out of a collection moves the paper (it leaves
// the source), while dragging from a flat list — search results, All papers —
// has no source to leave, so it is filed into the target as an addition.
// Other collections the paper belongs to are left alone either way.
export async function POST(req: NextRequest) {
  const { key, from, to } = await req.json().catch(() => ({}));
  if (typeof key !== "string" || !key || typeof to !== "string" || !to) {
    return Response.json({ error: "key and to are required" }, { status: 400 });
  }
  if (from === to) return Response.json({ ok: true, unchanged: true });

  const apiKey = webApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Moving papers between collections needs ZOTERO_API_KEY in .env.local — the local Zotero API is read-only." },
      { status: 400 }
    );
  }
  const userId = await getWebUserId();
  if (!userId) return Response.json({ error: "Could not determine your Zotero user ID." }, { status: 502 });

  // Membership lives on the top-level item; a standalone attachment is its own
  const local = await zotero<ZoteroItem>(`/items/${encodeURIComponent(key)}`);
  const targetKey = local.ok && local.data.data?.parentItem ? local.data.data.parentItem : key;

  try {
    const itemUrl = `${ZOTERO_WEB_API}/users/${userId}/items/${encodeURIComponent(targetKey)}`;
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
    const current: string[] = Array.isArray(item.data?.collections) ? item.data.collections : [];
    const next = [...new Set([...current.filter((c) => c !== from), to])];

    const patchRes = await fetch(itemUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Zotero-API-Key": apiKey,
        "If-Unmodified-Since-Version": String(item.version),
      },
      body: JSON.stringify({ collections: next }),
      signal: AbortSignal.timeout(10000),
    });
    if (!patchRes.ok && patchRes.status !== 204) {
      return Response.json(
        { error: patchRes.status === 412
            ? "That paper changed in Zotero while this was in flight — try again."
            : `Zotero refused the change (${patchRes.status}).` },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, key: targetKey, collections: next, moved: !!from });
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }
}
