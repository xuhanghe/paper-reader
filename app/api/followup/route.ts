import { spawn } from "child_process";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { resolveProvider } from "@/lib/providers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { question, session_id, model, effort, image_base64 } = await req.json();

  if (!question?.trim()) return new Response("question is required", { status: 400 });
  if (!session_id?.trim()) return new Response("session_id is required", { status: 400 });
  // Non-claude providers have no resumable session — the client sends
  // history inline through /api/explain instead
  if (resolveProvider(model) !== "claude") {
    return new Response("session resume is only supported for Claude models", { status: 400 });
  }

  const modelFlag = model || "claude-sonnet-4-6";

  // With an attached figure, the message goes in via stream-json (image + text)
  const hasImage = typeof image_base64 === "string" && image_base64.trim();
  const inputMessage = hasImage
    ? JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: image_base64.replace(/^data:image\/\w+;base64,/, ""),
              },
            },
            { type: "text", text: question },
          ],
        },
      })
    : null;

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn("claude", [
        "-p", ...(inputMessage ? [] : [sanitizeSpawnArg(question)]),
        "--resume", session_id,
        "--model", modelFlag,
        ...effortArgs(effort),
        ...(inputMessage ? ["--input-format", "stream-json"] : []),
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ]);
      if (inputMessage) proc.stdin.write(inputMessage + "\n");
      proc.stdin.end();

      proc.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      proc.stdout.on("end", () => controller.close());
      proc.stderr.on("data", (d: Buffer) => console.error("[claude stderr]", d.toString()));
      proc.on("error", (err) => { console.error("[claude spawn error]", err); controller.error(err); });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
