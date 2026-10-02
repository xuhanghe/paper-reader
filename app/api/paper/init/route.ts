import { writePaperText, hasPaperText, writeMindmapFile, readMindmapFile, countPageImages } from "@/lib/session-store";

export const runtime = "nodejs";

// Called when a paper opens: caches the extracted text as paper.md so
// agentic models can read it with their file tools, and seeds mindmap.json
// from a restored session if the file doesn't exist yet. Called first
// without text, it says what it already has — extracting a paper's text
// is seconds of work the client should not repeat on every open.
export async function POST(req: Request) {
  const { id, title, text, mindmap } = await req.json();
  if (!id || typeof id !== "string") return Response.json({ error: "id is required" }, { status: 400 });

  let wrotePaper = false;
  let hasText = await hasPaperText(id);
  if (typeof text === "string" && text.trim() && !hasText) {
    await writePaperText(id, typeof title === "string" ? title : "Untitled", text);
    wrotePaper = true;
    hasText = true;
  }

  let wroteMap = false;
  if (mindmap && !(await readMindmapFile(id))) {
    await writeMindmapFile(id, mindmap);
    wroteMap = true;
  }

  return Response.json({ ok: true, wrotePaper, wroteMap, hasText, pagesCount: await countPageImages(id) });
}
