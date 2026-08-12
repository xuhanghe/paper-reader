export const runtime = "nodejs";

const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";

// Collection tree for the "save to Zotero" picker, via the connector API
// (the same list the Zotero browser extension shows)
export async function GET() {
  try {
    const res = await fetch(`${CONNECTOR_BASE}/connector/getSelectedCollection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json({ error: `Zotero responded with ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json({
      targets: data.targets ?? [],
      current: data.id ? `C${data.id}` : "L1",
    });
  } catch {
    return Response.json(
      { error: "Could not reach Zotero. Make sure Zotero is running." },
      { status: 502 }
    );
  }
}
