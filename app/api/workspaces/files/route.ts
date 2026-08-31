import path from "node:path";
import { listWorkspaceFiles, readWorkspaceText, resolveWorkspaceFile, writeWorkspaceText } from "@/lib/workspace-files";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const root = url.searchParams.get("root") || "";
  const relative = url.searchParams.get("path");
  try {
    if (relative) {
      if (url.searchParams.get("raw") === "1") {
        const { file } = await resolveWorkspaceFile(root, relative);
        const { readFile } = await import("node:fs/promises");
        return new Response(new Uint8Array(await readFile(file)), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
      }
      const content = await readWorkspaceText(root, relative);
      return Response.json({ path: relative, content });
    }
    return Response.json({ files: await listWorkspaceFiles(root) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read the workspace." }, { status: 400 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const root = String(body.root || "");
    const relative = String(body.path || "");
    const content = typeof body.content === "string" ? body.content : "";
    const extension = path.extname(relative).toLowerCase();
    if ([".pdf", ".png", ".jpg", ".jpeg", ".gif"].includes(extension)) {
      return Response.json({ error: "Binary files use the explicit PDF copy action." }, { status: 400 });
    }
    await writeWorkspaceText(root, relative, content);
    return Response.json({ ok: true, path: relative });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the file." }, { status: 400 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const root = String(body.root || "");
    const relative = String(body.path || "");
    const dataUrl = String(body.dataUrl || "");
    const match = /^data:application\/pdf;base64,(.+)$/.exec(dataUrl);
    if (!match) return Response.json({ error: "A PDF data URL is required." }, { status: 400 });
    const { file } = await resolveWorkspaceFile(root, relative);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(match[1], "base64"));
    return Response.json({ ok: true, path: relative });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not copy the PDF." }, { status: 400 });
  }
}
