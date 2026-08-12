import { writePaperText, hasPaperText, writeMindmapFile, readMindmapFile, countPageImages } from "@/lib/session-store";

export const runtime = "nodejs";

// Called once when a paper opens: caches the extracted text as paper.md so
// agentic models can read it with their file tools, and seeds mindmap.json
// from a restored session if the file doesn't exist yet.
export async function POST(req: Request) {
  const { id, title, text, mindmap } = await req.json();
  if (!id || typeof id !== "string") return Response.json({ error: "id is required" }, { status: 400 });

  let wrotePaper = false;
  if (typeof text === "string" && text.trim() && !(await hasPaperText(id))) {
    await writePaperText(id, typeof title === "string" ? title : "Untitled", text);
    wrotePaper = true;
  }

  let wroteMap = false;
  if (mindmap && !(await readMindmapFile(id))) {
    await writeMindmapFile(id, mindmap);
    wroteMap = true;
  }

  return Response.json({ ok: true, wrotePaper, wroteMap, pagesCount: await countPageImages(id) });
}
