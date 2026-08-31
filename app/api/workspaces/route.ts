import path from "node:path";
import { validateWorkspaceRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ suggestedRoot: path.join(process.cwd(), "tmp", "research-workspace") });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const root = await validateWorkspaceRoot(String(body.root || ""), body.create === true);
    return Response.json({ root });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not use that directory." }, { status: 400 });
  }
}
