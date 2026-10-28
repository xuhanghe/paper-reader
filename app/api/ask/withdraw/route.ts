import { deleteFromThread, lastTurn } from "@/lib/session-store";

export const runtime = "nodejs";

// Questions deleted in the panel — one with its answer (by turn), or a whole
// card (by its id, which takes what has no number yet as well) — deleted from
// the paper's thread too, with their answers and the figures only they used.
// The model is told nothing (see lib/session-store).
export async function POST(req: Request) {
  const { paper_id, turns, annotation_id } = await req.json().catch(() => ({}));
  if (!paper_id || typeof paper_id !== "string") {
    return new Response("paper_id is required", { status: 400 });
  }
  // A paper never asked about has no record to delete from, and none is made
  // for it; turns must be ones the thread has given out
  const last = await lastTurn(paper_id);
  if (!last) return new Response("no such thread", { status: 400 });
  const valid = Array.isArray(turns) ? turns.filter((t): t is number => Number.isInteger(t) && t >= 1 && t <= last) : [];
  const conversation = typeof annotation_id === "string" && annotation_id ? annotation_id : undefined;
  if (!valid.length && !conversation) return new Response("nothing to delete", { status: 400 });
  await deleteFromThread(paper_id, { turns: valid, conversation });
  return Response.json({ ok: true });
}
