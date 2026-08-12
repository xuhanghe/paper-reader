export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";
const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";

// Zotero's local/connector APIs are read-only for collections, so creation
// goes through the Zotero Web API (needs an API key with write access), then
// we wait for the desktop client to sync the new collection down and resolve
// its local target id for filing.

async function getWebUserId(): Promise<string | null> {
  if (process.env.ZOTERO_USER_ID) return process.env.ZOTERO_USER_ID;
  try {
    const res = await fetch(`${ZOTERO_BASE}/collections?limit=1`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const items = await res.json();
    const id = items?.[0]?.library?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

async function findLocalTarget(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${CONNECTOR_BASE}/connector/getSelectedCollection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.targets ?? []).find((t: { id: string; name: string }) => t.name === name);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const { name } = await req.json();
  if (!name?.trim()) return Response.json({ error: "name is required" }, { status: 400 });

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Creating collections needs a Zotero API key (the local Zotero API is read-only). Create one with write access at zotero.org/settings/keys, add ZOTERO_API_KEY=<key> to .env.local, and restart the dev server.",
      },
      { status: 400 }
    );
  }

  const userId = await getWebUserId();
  if (!userId) {
    return Response.json(
      { error: "Could not determine your Zotero user ID. Is Zotero running and synced?" },
      { status: 502 }
    );
  }

  // Already exists locally? Reuse it.
  const existing = await findLocalTarget(name.trim());
  if (existing) return Response.json({ target: existing, existed: true });

  try {
    const res = await fetch(`https://api.zotero.org/users/${userId}/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Zotero-API-Key": apiKey },
      body: JSON.stringify([{ name: name.trim() }]),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return Response.json(
        { error: `Zotero web API refused the collection (${res.status}). Check that your API key has write access.` },
        { status: 502 }
      );
    }
  } catch {
    return Response.json({ error: "Could not reach the Zotero web API." }, { status: 502 });
  }

  // Wait for the desktop client to sync the new collection down (~seconds
  // with auto-sync). If it doesn't appear in time, the save proceeds unfiled.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const target = await findLocalTarget(name.trim());
    if (target) return Response.json({ target });
  }

  return Response.json({
    pending: true,
    warning:
      "Collection created on zotero.org, but it hasn't synced to your desktop Zotero yet — the item will be saved to your library root. Move it once Zotero syncs.",
  });
}
