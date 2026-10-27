import { homePath } from "@/lib/home";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkspaceRoot, validateWorkspaceTrashTarget } from "@/lib/workspace-files";

export const runtime = "nodejs";
const run = promisify(execFile);

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

export async function DELETE(req: Request) {
  if (process.platform !== "darwin") {
    return Response.json({ error: "Moving a workspace directory to Trash is currently supported on macOS." }, { status: 501 });
  }
  try {
    const body = await req.json();
    const root = await validateWorkspaceTrashTarget(String(body.root || ""), String(body.confirmRoot || ""));
    const script = [
      "on run argv",
      "set targetPath to item 1 of argv",
      "set targetItem to POSIX file targetPath as alias",
      "tell application \"Finder\" to delete targetItem",
      "end run",
    ].join("\n");
    await run("/usr/bin/osascript", ["-e", script, root]);
    return Response.json({ ok: true, trashed: root });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not move that workspace directory to Trash." }, { status: 400 });
  }
}
