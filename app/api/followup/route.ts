import { spawn } from "child_process";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { question, session_id, model } = await req.json();

  if (!question?.trim()) return new Response("question is required", { status: 400 });
  if (!session_id?.trim()) return new Response("session_id is required", { status: 400 });

  const modelFlag = model || "claude-sonnet-4-6";

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn("claude", [
        "-p", question,
        "--resume", session_id,
        "--model", modelFlag,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ]);
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
