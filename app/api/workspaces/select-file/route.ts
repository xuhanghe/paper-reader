import { chooseSaveFile, NoNativeDialog } from "@/lib/native-dialogs";

export const runtime = "nodejs";

// The system's save dialog — macOS or Windows — for choosing where a file goes
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const defaultName = typeof body.defaultName === "string" && body.defaultName.trim() ? body.defaultName.trim() : "conversation.md";
  const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : "";
  try {
    const chosen = await chooseSaveFile("Save the conversation export", { defaultName, location, extension: "md" });
    if (chosen === null) return Response.json({ cancelled: true }, { status: 499 });
    return Response.json({ path: chosen });
  } catch (error) {
    if (error instanceof NoNativeDialog) return Response.json({ error: error.message }, { status: 501 });
    return Response.json({ error: error instanceof Error ? error.message : "Could not open the save dialog." }, { status: 500 });
  }
}
