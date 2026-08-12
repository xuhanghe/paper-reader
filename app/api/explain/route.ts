import { spawn } from "child_process";
import { SYSTEM_PROMPT_TEXT, buildTextPrompt, buildTextFollowUpPrompt, buildTextQuestionPrompt, buildPaperQuestionPrompt } from "@/lib/prompts";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { resolveProvider, parseCustomConfig, codexStream, customStream, streamResponse } from "@/lib/providers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { selected_text, paper_text, model, effort, history, question, reference_title, reference_text, custom } = await req.json();

  // Whole-paper question: no selection, paper text as context
  const isPaperQuestion = !selected_text?.trim() && question?.trim();
  if (!selected_text?.trim() && !isPaperQuestion) {
    return new Response("selected_text or question is required", { status: 400 });
  }

  const isFollowUp = !isPaperQuestion && Array.isArray(history) && history.length > 0 && question?.trim();
  const isDirectQuestion = !isPaperQuestion && !isFollowUp && question?.trim();

  const rawPrompt = isPaperQuestion
    ? buildPaperQuestionPrompt(
        typeof paper_text === "string" ? paper_text : "",
        question,
        typeof reference_title === "string" ? reference_title : undefined,
        typeof reference_text === "string" ? reference_text : undefined
      )
    : isFollowUp
      ? buildTextFollowUpPrompt(selected_text, history, question)
      : isDirectQuestion
        ? `${SYSTEM_PROMPT_TEXT}\n\n${buildTextQuestionPrompt(selected_text, question)}`
        : `${SYSTEM_PROMPT_TEXT}\n\n${buildTextPrompt(selected_text)}`;
  const fullPrompt = sanitizeSpawnArg(rawPrompt);

  const provider = resolveProvider(model);
  if (provider === "codex") {
    return streamResponse(codexStream(fullPrompt, { effort }));
  }
  if (provider === "custom") {
    const cfg = parseCustomConfig(custom);
    if (!cfg) return new Response("custom API is not configured", { status: 400 });
    return streamResponse(customStream(cfg, [{ role: "user", content: fullPrompt }]));
  }

  const modelFlag = model || "claude-sonnet-4-6";

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn("claude", [
        "-p", fullPrompt,
        "--model", modelFlag,
        ...effortArgs(effort),
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
