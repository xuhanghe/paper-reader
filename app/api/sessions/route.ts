import type { NextRequest } from "next/server";
import { readState, writeState, deleteSession, listSessions } from "@/lib/session-store";

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

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await deleteSession(id);
  return Response.json({ ok: true });
}
