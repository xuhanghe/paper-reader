import { lastTurn, withdrawTurns } from "@/lib/session-store";

export const runtime = "nodejs";

// Questions deleted in the panel — one with its answer, or a whole card's —
// deleted from the paper's thread too, with their answers and the figures
// only they used. The model is told nothing (see lib/session-store).
export async function POST(req: Request) {
  const { paper_id, turns } = await req.json().catch(() => ({}));
  if (!paper_id || typeof paper_id !== "string") {
    return new Response("paper_id is required", { status: 400 });
  }
  // Only turns the thread has given out: a paper never asked about has no
  // record to delete from, and none is made for it
  const last = await lastTurn(paper_id);
  const valid = Array.isArray(turns) ? turns.filter((t): t is number => Number.isInteger(t) && t >= 1 && t <= last) : [];
  if (!valid.length) return new Response("no such turn", { status: 400 });
  await withdrawTurns(paper_id, valid);
  return Response.json({ ok: true });
}
