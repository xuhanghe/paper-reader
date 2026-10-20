import type { NextRequest } from "next/server";
import { readState, writeState, deleteSession, listSessions, patchSessionHighlights } from "@/lib/session-store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  // Old sessions were keyed by a name slug; new ones by Zotero key — the
  // client passes the slug as `legacy` so old conversations migrate over.
  const legacy = req.nextUrl.searchParams.get("legacy") || undefined;

  if (id) {
    const state = await readState(id, legacy);
    if (!state) return Response.json({ error: "not found" }, { status: 404 });
    if (req.nextUrl.searchParams.get("lean")) delete (state as Record<string, unknown>).pdfDataUrl;
    return Response.json({ state });
  }

  return Response.json({ sessions: await listSessions() });
}

export async function POST(req: Request) {
  const { id, state } = await req.json();
  if (!id || typeof id !== "string" || !state) {
    return Response.json({ error: "id and state are required" }, { status: 400 });
  }
  await writeState(id, state);
  return Response.json({ ok: true });
}

// The Workspace writes the marks it makes on a paper into the paper's own
// session, so the Reader shows them too. Only the highlights change; the
// conversation cards and concepts are the Reader's to write.
export async function PATCH(req: Request) {
  const { id, highlights, seed } = await req.json();
  if (!id || typeof id !== "string" || !Array.isArray(highlights)) {
    return Response.json({ error: "id and highlights are required" }, { status: 400 });
  }
  const clean = highlights.filter((h) => h && typeof h === "object" && typeof h.id === "string" && typeof h.text === "string");
  const outcome = await patchSessionHighlights(id, clean, seed && typeof seed === "object" ? seed : undefined);
  if (outcome === "missing") return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, [outcome]: true });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await deleteSession(id);
  return Response.json({ ok: true });
}
