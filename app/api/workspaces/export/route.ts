import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildConversationExport, type ExportMessage, type ExportPaper } from "@/lib/conversation-export";
import { dirFor } from "@/lib/session-store";
import { validateWorkspaceRoot, writeWorkspaceText } from "@/lib/workspace-files";

export const runtime = "nodejs";

// Writes the conversation out as Markdown: inside the workspace by a
// relative path, or wherever the user chose with the save dialog
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const root = await validateWorkspaceRoot(String(body.root || ""));
    const target = String(body.path || "").trim();
    if (!target) return Response.json({ error: "Choose where to save the export." }, { status: 400 });
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: Partial<ExportMessage>) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
      .map((m: ExportMessage) => ({ role: m.role, content: m.content, tools: Array.isArray(m.tools) ? m.tools : undefined, hasImage: !!m.hasImage }));
    const papers: ExportPaper[] = (Array.isArray(body.papers) ? body.papers : [])
      .filter((p: Partial<ExportPaper & { id: string }>) => typeof p?.name === "string")
      .map((p: ExportPaper & { id?: string }) => ({ name: p.name, zoteroKey: p.zoteroKey || undefined, sessionDir: p.id ? dirFor(p.id) : undefined }));
    const markdown = buildConversationExport({
      workspace: { name: String(body.name || path.basename(root)), root },
      exportedAt: new Date(),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      papers,
      messages,
    });
    if (path.isAbsolute(target)) {
      if (!/\.md$/i.test(target)) return Response.json({ error: "The export is a Markdown file: the name must end in .md." }, { status: 400 });
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, markdown, "utf8");
      return Response.json({ ok: true, path: target, inside: target.startsWith(`${root}${path.sep}`) });
    }
    const relative = /\.md$/i.test(target) ? target : `${target}.md`;
    await writeWorkspaceText(root, relative, markdown);
    return Response.json({ ok: true, path: relative, inside: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not export the conversation." }, { status: 400 });
  }
}
