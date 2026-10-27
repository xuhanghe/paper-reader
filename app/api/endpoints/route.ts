import { deleteEndpoint, listEndpoints, saveEndpoint, summarizeEndpoint } from "@/lib/endpoints";
import { forgetCatalogGroup } from "@/lib/model-catalog";

export const runtime = "nodejs";

// Saved custom endpoints. Keys are written here and never read back out:
// the browser sees whether one is set and its last four characters.

export async function GET() {
  return Response.json({ endpoints: (await listEndpoints()).map(summarizeEndpoint) });
}

export async function POST(req: Request) {
  try {
    const endpoint = await saveEndpoint(await req.json());
    forgetCatalogGroup(`custom:${endpoint.id}`);
    return Response.json({ endpoint: summarizeEndpoint(endpoint) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the endpoint." }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const removed = await deleteEndpoint(id);
  if (id) forgetCatalogGroup(`custom:${id}`);
  return removed ? Response.json({ ok: true }) : Response.json({ error: "No such endpoint." }, { status: 404 });
}
