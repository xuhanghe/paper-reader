import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const CONNECTOR_BASE = process.env.ZOTERO_CONNECTOR_URL || "http://127.0.0.1:23119";

// HTTP headers must be ASCII — titles with CJK (or any non-Latin script) throw
// when set directly. JSON \uXXXX escapes survive Zotero's JSON.parse intact.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

// Save a PDF into Zotero via the connector API: upload as a standalone
// attachment (Zotero runs metadata recognition on it), then file it under the
// chosen collection target ("L1" = library root, "C<id>" = collection).
export async function POST(req: Request) {
  const { name, data_base64, target, source_url } = await req.json();

  if (!name || typeof data_base64 !== "string" || !data_base64.trim()) {
    return Response.json({ error: "name and data_base64 are required" }, { status: 400 });
  }

  const bytes = Buffer.from(data_base64.replace(/^data:application\/pdf;base64,/, ""), "base64");
  const sessionID = randomUUID().replace(/-/g, "").slice(0, 8);
  const title = String(name).replace(/\.pdf$/i, "");

  try {
    const saveRes = await fetch(`${CONNECTOR_BASE}/connector/saveStandaloneAttachment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Metadata": asciiJson({
          url: typeof source_url === "string" && source_url.trim() ? source_url : `file:///${encodeURIComponent(name)}`,
          title,
          sessionID,
        }),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30000),
    });
    if (!saveRes.ok) {
      return Response.json(
        { error: `Zotero refused the save (${saveRes.status}). Is Zotero running?` },
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
  } catch (err) {
    console.error("[zotero/save]", err);
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Saving to Zotero failed: ${detail}. If Zotero isn't running, start it and try again.` },
      { status: 502 }
    );
  }
}
