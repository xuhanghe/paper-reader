import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";

// Save a fetched web page into Zotero as a webpage item + snapshot,
// filed under the chosen collection target
export async function POST(req: Request) {
  const { url, html, title, target } = await req.json();

  if (!url || typeof html !== "string" || !html.trim()) {
    return Response.json({ error: "url and html are required" }, { status: 400 });
  }

  const sessionID = randomUUID().replace(/-/g, "").slice(0, 8);

  try {
    const saveRes = await fetch(`${CONNECTOR_BASE}/connector/saveSnapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID,
        url,
        title: title || url,
        html,
        cookie: "",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!saveRes.ok) {
      return Response.json(
        { error: `Zotero refused the snapshot (${saveRes.status}). Is Zotero running?` },
        { status: 502 }
      );
    }

    if (target && typeof target === "string") {
      const moveRes = await fetch(`${CONNECTOR_BASE}/connector/updateSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID, target, tags: "" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!moveRes.ok) {
        return Response.json({
          ok: true,
          warning: "Saved to Zotero, but filing into the chosen collection failed — it's in your library root.",
        });
      }
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: "Could not reach Zotero. Make sure Zotero is running." },
      { status: 502 }
    );
  }
}
