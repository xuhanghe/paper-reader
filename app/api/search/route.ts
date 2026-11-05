import { buildSearchIndex, parseWorkspaces } from "@/lib/search-index";
import { quickResults } from "@/lib/search-agent";

export const runtime = "nodejs";

// The plain-word search, as the box shows it while typing: no model, instant.
// POST because the client sends the workspaces it knows, chats included (they
// live in the browser). See lib/search-index.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const query = typeof body.q === "string" ? body.q.trim().slice(0, 300) : "";
    if (!query) return Response.json({ results: [] });
    const index = await buildSearchIndex(parseWorkspaces(body.workspaces));
    const paperId = typeof body.paperId === "string" && body.paperId ? body.paperId : undefined;
    return Response.json({ results: quickResults(index, query, 24, paperId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Search failed." }, { status: 500 });
  }
}
