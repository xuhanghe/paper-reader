import { writePageImage, countPageImages } from "@/lib/session-store";

export const runtime = "nodejs";

// Receives rendered page snapshots (uploaded in small batches after a paper
// opens). Each page is stored as pages/page-<n>.jpg so multimodal models can
// see the page exactly as laid out, alongside the extracted text.
export async function POST(req: Request) {
  const { id, pages } = await req.json();
  if (!id || typeof id !== "string" || !Array.isArray(pages)) {
    return Response.json({ error: "id and pages are required" }, { status: 400 });
  }
  for (const p of pages) {
    if (typeof p?.n === "number" && typeof p?.dataUrl === "string" && p.dataUrl.startsWith("data:image/")) {
      await writePageImage(id, p.n, p.dataUrl);
    }
  }
  return Response.json({ ok: true, count: await countPageImages(id) });
}
