import { getCatalog } from "@/lib/model-catalog";

export const runtime = "nodejs";

// Every provider and saved custom endpoint, with the models and effort levels
// each backend says it has (see lib/model-catalog). ?refresh=1 asks every
// backend again; ?refresh=<key> asks only that one ("codex", "custom:<id>").
export async function GET(req: Request) {
  const refresh = new URL(req.url).searchParams.get("refresh");
  const groups = await getCatalog(refresh === "1" ? true : refresh || false);
  return Response.json({ groups });
}
