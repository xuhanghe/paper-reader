import type { NextRequest } from "next/server";
import { ZOTERO_WEB_API, getWebUserId, webApiKey } from "@/lib/zotero-server";

export const runtime = "nodejs";

// Writes reader highlights/notes into Zotero as real PDF annotation items
// (zero-copy: Zotero is the store; the app only mirrors them for display).
// The local API is read-only, so writes go through the web API and sync down.

const ZOTERO_LOCAL = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";
const MAX_KEYS = 50;

const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

type KeyedItem = { key: string; data?: { deleted?: boolean | number } };

// Keys still present (and not in the trash) among the given ones
async function livingKeys(url: string, headers?: HeadersInit): Promise<Set<string>> {
  const found = new Set<string>();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) return found;
  for (const item of (await res.json()) as KeyedItem[]) {
    if (!item.data?.deleted) found.add(item.key);
  }
  return found;
}

// Reports which annotation keys no longer exist in Zotero, so the reader can
// drop highlights the user deleted on the Zotero side. Absence from the local
// library is not enough on its own — a highlight written moments ago is absent
// there too, until Zotero syncs it down — so zotero.org gets the final say.
export async function GET(req: NextRequest) {
  const keys = (req.nextUrl.searchParams.get("keys") || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, MAX_KEYS);
  if (keys.length === 0) return Response.json({ missing: [] });

  const found = new Set<string>();
  try {
    for (const k of await livingKeys(`${ZOTERO_LOCAL}/items?itemKey=${keys.join(",")}&limit=${MAX_KEYS}`)) {
      found.add(k);
    }
  } catch {
    // Zotero not running — fall through to the web check
  }

  const unresolved = keys.filter((k) => !found.has(k));
  if (unresolved.length > 0) {
    const apiKey = webApiKey();
    const userId = apiKey ? await getWebUserId() : null;
    // Without a way to consult zotero.org, report nothing missing rather than
    // risk discarding a highlight that is merely mid-sync
    if (!apiKey || !userId) return Response.json({ missing: [] });
    try {
      const url = `${ZOTERO_WEB_API}/users/${userId}/items?itemKey=${unresolved.join(",")}&limit=${MAX_KEYS}`;
      for (const k of await livingKeys(url, { "Zotero-API-Key": apiKey })) found.add(k);
    } catch {
      return Response.json({ missing: [] });
    }
  }

  return Response.json({ missing: keys.filter((k) => !found.has(k)) });
}

export async function POST(req: Request) {
  const body = await req.json();
  // Preferred high-level contract: one selected text-position plus optional
  // appearance metadata. The legacy flat fields remain accepted so an older
  // open tab can finish an in-flight write after a hot reload.
  const attachment_key = body.attachmentKey || body.attachment_key;
  const text = body.selection?.text ?? body.text;
  const position = body.selection?.position ?? body.position;
  const comment = body.options?.comment ?? body.comment;
  const color = body.options?.color ?? body.color;
  const page = body.options?.pageLabel ?? body.page;

  if (!attachment_key || !text?.trim() || !position?.rects?.length) {
    return Response.json({ error: "attachmentKey and a selected text position are required" }, { status: 400 });
  }
  const apiKey = webApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Syncing annotations to Zotero needs ZOTERO_API_KEY in .env.local (see zotero.org/settings/keys)." },
      { status: 400 }
    );
  }
  const userId = await getWebUserId();
  if (!userId) return Response.json({ error: "Could not determine your Zotero user ID." }, { status: 502 });

  const pageIndex: number = position.pageIndex ?? (page ? page - 1 : 0);
  // Sort key: page | offset (unknown) | distance from page top (PDF y is bottom-up)
  const topY = Math.max(...position.rects.map((r: number[]) => r[3] ?? 0));
  const sortIndex = `${pad(pageIndex, 5)}|000000|${pad(99999 - topY, 5)}`;

  const item = {
    itemType: "annotation",
    parentItem: attachment_key,
    annotationType: "highlight",
    annotationText: text,
    annotationComment: comment || "",
    annotationColor: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#ffd400",
    annotationPageLabel: String(page ?? pageIndex + 1),
    annotationSortIndex: sortIndex,
    annotationPosition: JSON.stringify({ pageIndex, rects: position.rects }),
    tags: [],
  };

  try {
    const res = await fetch(`${ZOTERO_WEB_API}/users/${userId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Zotero-API-Key": apiKey },
      body: JSON.stringify([item]),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return Response.json({ error: `Zotero web API refused the annotation (${res.status}).` }, { status: 502 });
    }
    const data = await res.json();
    const created = data?.successful?.["0"];
    if (!created?.key) {
      const failure = data?.failed?.["0"]?.message || "unknown error";
      return Response.json({ error: `Zotero rejected the annotation: ${failure}` }, { status: 502 });
    }
    return Response.json({ key: created.key });
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }
}

// Edit an existing annotation in place — its colour, its note, or both.
// Zotero holds the only copy, so this is what "editing a highlight" means.
export async function PATCH(req: Request) {
  const { key, color, comment, page, position } = await req.json();
  const patch: Record<string, string> = {};
  if (typeof color === "string") patch.annotationColor = color;
  if (typeof comment === "string") patch.annotationComment = comment;
  if (position !== undefined) {
    const pageIndex = position?.pageIndex;
    const rects = position?.rects;
    const valid =
      Number.isInteger(pageIndex) &&
      pageIndex >= 0 &&
      Array.isArray(rects) &&
      rects.length > 0 &&
      rects.every(
        (r: unknown) =>
          Array.isArray(r) &&
          r.length === 4 &&
          r.every((n) => typeof n === "number" && Number.isFinite(n)) &&
          r[0] < r[2] &&
          r[1] < r[3]
      );
    if (!valid) return Response.json({ error: "position must contain valid PDF rectangles" }, { status: 400 });
    patch.annotationPosition = JSON.stringify({ pageIndex, rects });
    patch.annotationPageLabel = String(typeof page === "number" ? page : pageIndex + 1);
    const topY = Math.max(...rects.map((r: number[]) => r[3]));
    patch.annotationSortIndex = `${pad(pageIndex, 5)}|000000|${pad(99999 - topY, 5)}`;
  }
  if (!key || Object.keys(patch).length === 0) {
    return Response.json({ error: "key and at least one editable field are required" }, { status: 400 });
  }
  const apiKey = webApiKey();
  if (!apiKey) return Response.json({ error: "ZOTERO_API_KEY is not configured." }, { status: 400 });
  const userId = await getWebUserId();
  if (!userId) return Response.json({ error: "Could not determine your Zotero user ID." }, { status: 502 });

  try {
    const itemRes = await fetch(`${ZOTERO_WEB_API}/users/${userId}/items/${key}`, {
      headers: { "Zotero-API-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!itemRes.ok) return Response.json({ error: `Annotation not found (${itemRes.status}).` }, { status: 404 });
    const item = await itemRes.json();

    const patchRes = await fetch(`${ZOTERO_WEB_API}/users/${userId}/items/${key}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Zotero-API-Key": apiKey,
        "If-Unmodified-Since-Version": String(item.version),
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(10000),
    });
    if (!patchRes.ok && patchRes.status !== 204) {
      return Response.json({ error: `Edit failed (${patchRes.status}).` }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")?.trim();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });
  const apiKey = webApiKey();
  if (!apiKey) return Response.json({ error: "ZOTERO_API_KEY is not configured." }, { status: 400 });
  const userId = await getWebUserId();
  if (!userId) return Response.json({ error: "Could not determine your Zotero user ID." }, { status: 502 });

  try {
    const itemRes = await fetch(`${ZOTERO_WEB_API}/users/${userId}/items/${key}`, {
      headers: { "Zotero-API-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!itemRes.ok) return Response.json({ error: `Annotation not found on zotero.org (${itemRes.status}).` }, { status: 404 });
    const item = await itemRes.json();

    const delRes = await fetch(`${ZOTERO_WEB_API}/users/${userId}/items/${key}`, {
      method: "DELETE",
      headers: { "Zotero-API-Key": apiKey, "If-Unmodified-Since-Version": String(item.version) },
      signal: AbortSignal.timeout(10000),
    });
    if (!delRes.ok && delRes.status !== 204) {
      return Response.json({ error: `Delete failed (${delRes.status}).` }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }
}
