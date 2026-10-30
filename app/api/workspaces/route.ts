import { homePath } from "@/lib/home";
import { moveToTrash, NoNativeDialog } from "@/lib/native-dialogs";
import { validateWorkspaceRoot, validateWorkspaceTrashTarget } from "@/lib/workspace-files";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ suggestedRoot: homePath("tmp", "research-workspace") });
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

// The workspace's folder to the Trash — the Recycle Bin on Windows
export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const root = await validateWorkspaceTrashTarget(String(body.root || ""), String(body.confirmRoot || ""));
    await moveToTrash(root);
    return Response.json({ ok: true, trashed: root });
  } catch (error) {
    if (error instanceof NoNativeDialog) return Response.json({ error: error.message }, { status: 501 });
    return Response.json({ error: error instanceof Error ? error.message : "Could not move that workspace directory to Trash." }, { status: 400 });
  }
}
