import { spawn } from "child_process";
import { SYSTEM_PROMPT_TEXT, buildTextPrompt, buildTextFollowUpPrompt } from "@/lib/prompts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { selected_text, model, history, question } = await req.json();

  if (!selected_text?.trim()) {
    return new Response("selected_text is required", { status: 400 });
  }

  const isFollowUp = Array.isArray(history) && history.length > 0 && question?.trim();

  const fullPrompt = isFollowUp
    ? buildTextFollowUpPrompt(selected_text, history, question)
    : `${SYSTEM_PROMPT_TEXT}\n\n${buildTextPrompt(selected_text)}`;

  const modelFlag = model || "claude-sonnet-4-6";

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn("claude", [
        "-p", fullPrompt,
        "--model", modelFlag,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ]);
      proc.stdin.end();

      proc.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      proc.stdout.on("end", () => controller.close());
      proc.stderr.on("data", (data: Buffer) => console.error("[claude stderr]", data.toString()));
      proc.on("error", (err) => { console.error("[claude spawn error]", err); controller.error(err); });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
