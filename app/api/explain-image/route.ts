import { spawn } from "child_process";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { SYSTEM_PROMPT_IMAGE, buildImagePrompt, buildImageFollowUpPrompt } from "@/lib/prompts";
import { effortArgs } from "@/lib/model-flags";
import { resolveProvider, parseCustomConfig, codexStream, customStream, streamResponse } from "@/lib/providers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { image_base64, model, effort, history, question, reference_title, reference_text, custom } = await req.json();

  if (!image_base64?.trim()) {
    return new Response("image_base64 is required", { status: 400 });
  }

  const modelFlag = model || "claude-sonnet-4-6";
  const tmpPath = join(tmpdir(), `paper_reader_${randomUUID()}.png`);
  const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, "");

  const { writeFileSync } = await import("fs");
  writeFileSync(tmpPath, Buffer.from(base64Data, "base64"));

  const isFollowUp = Array.isArray(history) && history.length > 0 && question?.trim();
  const isDirectQuestion = !isFollowUp && question?.trim();

  const refBlock =
    typeof reference_text === "string" && reference_text.trim()
      ? `\n\nFor reference, another paper from my library ("${reference_title}"), extracted text possibly truncated:\n\n${reference_text}`
      : "";

  // For follow-ups: include the image for visual context + the conversation history in the text block
  // For a direct question: the image + the user's question
  // For first-time: original image + explain prompt
  const textContent = isFollowUp
    ? buildImageFollowUpPrompt(history, question)
    : isDirectQuestion
      ? `I am reading an academic paper and attached this image. My question: ${question}${refBlock}\n\nAnswer the question directly, grounded in the image${refBlock ? " and the referenced paper" : ""}.`
      : `${SYSTEM_PROMPT_IMAGE}\n\n${buildImagePrompt()}`;

  const provider = resolveProvider(model);
  if (provider === "codex") {
    // Codex takes images as file paths — the temp PNG is already written
    return streamResponse(
      codexStream(`${SYSTEM_PROMPT_IMAGE}\n\n${textContent}`, {
        images: [tmpPath],
        effort,
        onClose: () => { try { unlinkSync(tmpPath); } catch {} },
      })
    );
  }
  if (provider === "custom") {
    try { unlinkSync(tmpPath); } catch {}
    const cfg = parseCustomConfig(custom);
    if (!cfg) return new Response("custom API is not configured", { status: 400 });
    return streamResponse(
      customStream(cfg, [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Data}` } },
            { type: "text", text: `${SYSTEM_PROMPT_IMAGE}\n\n${textContent}` },
          ],
        },
      ])
    );
  }

  const inputMessage = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } },
        { type: "text", text: textContent },
      ],
    },
  });

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn("claude", [
        "-p",
        "--system-prompt", SYSTEM_PROMPT_IMAGE,
        "--model", modelFlag,
        ...effortArgs(effort),
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ]);

      proc.stdin.write(inputMessage + "\n");
      proc.stdin.end();

      proc.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      proc.stdout.on("end", () => { try { unlinkSync(tmpPath); } catch {} controller.close(); });
      proc.stderr.on("data", (data: Buffer) => console.error("[claude stderr]", data.toString()));
      proc.on("error", (err) => { try { unlinkSync(tmpPath); } catch {} console.error("[claude spawn error]", err); controller.error(err); });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
