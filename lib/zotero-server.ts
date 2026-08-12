// Server-side Zotero helpers shared by the API routes.

export const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";
export const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";
export const ZOTERO_WEB_API = "https://api.zotero.org";

// The zotero.org user id, resolved from the local client's library metadata
let cachedUserId: string | null = null;

export async function getWebUserId(): Promise<string | null> {
  if (process.env.ZOTERO_USER_ID) return process.env.ZOTERO_USER_ID;
  if (cachedUserId) return cachedUserId;
  try {
    const res = await fetch(`${ZOTERO_BASE}/collections?limit=1`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const items = await res.json();
    const id = items?.[0]?.library?.id;
    cachedUserId = id ? String(id) : null;
    return cachedUserId;
  } catch {
    return null;
  }
}

export function webApiKey(): string | null {
  return process.env.ZOTERO_API_KEY || null;
}
