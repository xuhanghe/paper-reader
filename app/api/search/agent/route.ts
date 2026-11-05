import { buildSearchIndex, parseWorkspaces } from "@/lib/search-index";
import { findFromMemory, parseHistory } from "@/lib/search-agent";

export const runtime = "nodejs";

// A search from a vague memory: a one-shot, read-only agent over the library,
// its progress and then its results streamed as NDJSON. See lib/search-agent.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const memory = typeof body.q === "string" ? body.q.trim().slice(0, 1000) : "";
  if (!memory) return new Response("say what you remember", { status: 400 });
  const workspaces = parseWorkspaces(body.workspaces);
  const index = await buildSearchIndex(workspaces);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // The paper being read, named by its own entry in the index
        const reading = typeof body.paperId === "string" ? index.docs.find((d) => d.id === `paper:${body.paperId}`) : undefined;
        for await (const event of findFromMemory(memory, index, workspaces, req.signal, reading ? { id: body.paperId, title: reading.title } : undefined, parseHistory(body.history))) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch {
        // the client went away
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
