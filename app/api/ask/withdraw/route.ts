import { countAsks, withdrawTurns } from "@/lib/session-store";

export const runtime = "nodejs";

// A question deleted from a conversation, with its answer: its turn is listed
// as withdrawn beside the paper's thread, so the record leaves it out and the
// provider session that saw it is told on the next ask (see lib/session-store)
export async function POST(req: Request) {
  const { paper_id, turns } = await req.json().catch(() => ({}));
  if (!paper_id || typeof paper_id !== "string") {
    return new Response("paper_id is required", { status: 400 });
  }
  // Only turns the thread has: a paper never asked about has no record to
  // write beside, and none is made for it
  const asked = await countAsks(paper_id);
  const valid = Array.isArray(turns) ? turns.filter((t): t is number => Number.isInteger(t) && t >= 1 && t <= asked) : [];
  if (!valid.length) return new Response("no such turn", { status: 400 });
  await withdrawTurns(paper_id, valid);
  return Response.json({ ok: true });
}
