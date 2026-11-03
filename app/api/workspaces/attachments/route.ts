import { requestImages } from "@/lib/message-images";
import { saveAttachments } from "@/lib/workspace-attachments";

export const runtime = "nodejs";

// Images attached to a question for the workspace agent, saved into the
// workspace before the question is sent; see lib/workspace-attachments
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const images = requestImages(body.images);
    if (!images.length) return Response.json({ error: "No images to attach." }, { status: 400 });
    const paths = await saveAttachments(String(body.root || ""), images);
    return Response.json({ paths });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the images." }, { status: 400 });
  }
}
