import { spawn } from "child_process";
import path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { claudeMcpArgs } from "@/lib/mcp-config";
import { resolveProvider, parseCustomConfig, codexStream, customStream, opencodeStream, streamResponse } from "@/lib/providers";
import { buildSessionBootstrap, buildAskMessage } from "@/lib/prompts";
import {
  appendThread,
  readThread,
  readMindmapFile,
  readPaperText,
  hasPaperText,
  paperPathFor,
  pagesDirFor,
  countPageImages,
  readPageImageDataUrl,
  figuresDirFor,
  writeFigureImage,
  sessionRelativeFile,
} from "@/lib/session-store";
import { claudeBin } from "@/lib/bin";
import { unwrapPartials } from "@/lib/claude-stream";

export const runtime = "nodejs";

// Unified ask endpoint: every question about a paper — selection explains,
// figure captures, general questions, follow-ups — flows through ONE fused
// per-paper conversation. Agentic providers (claude/codex CLIs) bootstrap once
// with the mindmap + a pointer to paper.md (they read it with file tools; claude
// may also use Zotero MCP), then resume natively. Tool-less custom APIs get the
// context inline plus a replay of thread.jsonl.

type TeeOpts = { paperId: string; annotationId?: string; kind?: string };

// Pass the stream through unchanged while accumulating the assistant text,
// then append it to the paper's thread.jsonl
function teeToThread(source: ReadableStream, opts: TeeOpts): ReadableStream {
  const decoder = new TextDecoder();
  let carry = "";
  let acc = "";
  let resultText = "";
  let persisted = false;
  const persist = () => {
    if (persisted) return;
    persisted = true;
    const finalText = acc || resultText;
    if (!finalText.trim()) return;
    appendThread(opts.paperId, {
      ts: Date.now(),
      role: "assistant",
      text: finalText,
      kind: opts.kind,
      annotationId: opts.annotationId,
    }).catch(() => {});
  };
  // `cancel` is in the streams standard and in Node, but not yet in the
  // TypeScript lib types — declared here rather than dropped
  const transformer: Transformer & { cancel?: () => void } = {
      transform(chunk, controller) {
        controller.enqueue(chunk);
        carry += decoder.decode(chunk as BufferSource, { stream: true });
        const lines = carry.split("\n");
        carry = lines.pop()!;
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              acc += ev.delta.text;
            } else if (ev.type === "assistant" && ev.message?.content) {
              for (const b of ev.message.content) if (b.type === "text") acc += b.text;
            } else if (ev.type === "result" && typeof ev.result === "string") {
              resultText = ev.result;
            }
          } catch {
            // partial line
          }
        }
      },
      flush() {
        persist();
      },
      // Stopping an answer cancels this stream, and cancel is not flush — so
      // without this the part that did arrive is shown in the panel and then
      // missing from the thread on disk, which is the copy a reload reads back
      cancel() {
        persist();
      },
  };
  return source.pipeThrough(new TransformStream(transformer));
}

export async function POST(req: Request) {
  const {
    paper_id, paper_title, kind, selected_text, question, page_number,
    image_base64, annotation_id, model, effort, custom, session_id, web_search,
  } = await req.json();

  if (!paper_id || typeof paper_id !== "string" || !kind) {
    return new Response("paper_id and kind are required", { status: 400 });
  }

  const provider = resolveProvider(model);
  let message = buildAskMessage({ kind, selectedText: selected_text, question, pageNumber: page_number });
  if (!message.trim() && !image_base64) return new Response("empty request", { status: 400 });

  // Web search: the CLIs have search tools (codex's is on by default) —
  // an instruction is all that's needed. Tool-less custom APIs can't search.
  if (web_search === true && provider !== "custom") {
    message += "\n\nPlease use your web search tool to look up current information online for this question, and cite what you find.";
  }

  // Captured figures are stored once as files; the thread references the file
  // so history stays complete without re-sending image bytes on replays
  const figureFile = image_base64 ? await writeFigureImage(paper_id, String(image_base64)) : null;

  // Replay context is read BEFORE appending the new user turn
  const priorThread = provider === "custom" ? await readThread(paper_id) : [];
  appendThread(paper_id, {
    ts: Date.now(),
    role: "user",
    text: message,
    kind,
    annotationId: annotation_id,
    hasImage: !!image_base64,
    imageFile: figureFile ?? undefined,
  }).catch(() => {});

  const isResume = provider !== "custom" && typeof session_id === "string" && !!session_id;

  // First message of a provider session carries the bootstrap header
  let prompt = message;
  if (!isResume && provider !== "custom") {
    const mindmap = await readMindmapFile(paper_id);
    // opencode runs without file tools, so it can't open paper.md itself the
    // way the CLIs do — it gets the text inline instead. It still resumes
    // natively, so unlike the custom provider there's no thread replay.
    const agentic = provider !== "opencode";
    const pagesCount = agentic ? await countPageImages(paper_id) : 0;
    const header = buildSessionBootstrap({
      title: typeof paper_title === "string" ? paper_title : "the paper",
      mindmapJson: mindmap ? JSON.stringify(mindmap) : undefined,
      paperPath: agentic && (await hasPaperText(paper_id)) ? paperPathFor(paper_id) : undefined,
      pagesDir: pagesCount > 0 ? pagesDirFor(paper_id) : undefined,
      pagesCount,
      figuresDir: agentic ? figuresDirFor(paper_id) : undefined,
      agentic,
      paperTextInline: agentic ? undefined : ((await readPaperText(paper_id)) || "").slice(0, 24000),
    });
    prompt = `${header}\n\n---\n\n${message}`;
  }

  const teeOpts: TeeOpts = { paperId: paper_id, annotationId: annotation_id, kind };
  const base64Data = image_base64 ? String(image_base64).replace(/^data:image\/\w+;base64,/, "") : null;

  if (provider === "codex") {
    let images: string[] | undefined;
    let cleanup: (() => void) | undefined;
    if (base64Data) {
      const tmpPath = path.join(tmpdir(), `paper-reader-fig-${Date.now()}.png`);
      writeFileSync(tmpPath, Buffer.from(base64Data, "base64"));
      images = [tmpPath];
      cleanup = () => { try { unlinkSync(tmpPath); } catch {} };
    }
    return streamResponse(
      teeToThread(
        codexStream(prompt, { images, effort, resumeId: isResume ? session_id : undefined, onClose: cleanup }),
        teeOpts
      )
    );
  }

  if (provider === "opencode") {
    return streamResponse(
      teeToThread(
        opencodeStream(prompt, {
          images: image_base64 ? [{ mime: "image/png", dataUrl: String(image_base64) }] : undefined,
          effort,
          resumeId: isResume ? session_id : undefined,
          webSearch: web_search === true,
          title: typeof paper_title === "string" ? paper_title : undefined,
        }),
        teeOpts
      )
    );
  }

  if (provider === "custom") {
    const cfg = parseCustomConfig(custom);
    if (!cfg) return new Response("custom API is not configured", { status: 400 });
    const mindmap = await readMindmapFile(paper_id);
    const paperText = (await readPaperText(paper_id)) || "";
    const header = buildSessionBootstrap({
      title: typeof paper_title === "string" ? paper_title : "the paper",
      mindmapJson: mindmap ? JSON.stringify(mindmap) : undefined,
      agentic: false,
      paperTextInline: paperText.slice(0, 24000),
    });
    const messages: { role: string; content: unknown }[] = [{ role: "system", content: header }];
    // Replay carries only a text marker for past figures — never image bytes
    for (const e of priorThread) {
      const ref = e.imageFile ? sessionRelativeFile(paper_id, e.imageFile) : null;
      messages.push({ role: e.role, content: ref ? `[figure attached: ${ref}]\n${e.text}` : e.text });
    }

    if (!cfg.vision) {
      // Text-only model: never send image payloads
      const note = image_base64
        ? `${message}\n\n(A figure was attached, but this model is text-only — answer from the paper text and conversation context.)`
        : message;
      messages.push({ role: "user", content: note });
    } else {
      // Vision model: attach the ask's figure, plus the page snapshots around
      // the selection so the model sees the page as laid out
      const content: unknown[] = [];
      if (image_base64) content.push({ type: "image_url", image_url: { url: image_base64 } });
      if (typeof page_number === "number") {
        for (const n of [page_number - 1, page_number, page_number + 1]) {
          const img = await readPageImageDataUrl(paper_id, n);
          if (img) content.push({ type: "image_url", image_url: { url: img } });
        }
      }
      content.push({ type: "text", text: message });
      messages.push({ role: "user", content: content.length > 1 ? content : message });
    }
    return streamResponse(teeToThread(customStream(cfg, messages), teeOpts));
  }

  // claude CLI
  const modelFlag = typeof model === "string" && model.startsWith("claude") ? model : "claude-sonnet-4-6";
  const cleanPrompt = sanitizeSpawnArg(prompt);
  const useStdin = !!base64Data;
  const args = [
    "-p", ...(useStdin ? [] : [cleanPrompt]),
    ...(isResume ? ["--resume", session_id] : []),
    "--model", modelFlag,
    ...effortArgs(effort),
    "--output-format", "stream-json",
    // Without this the CLI only reports whole messages, so an answer appears
    // in one lump at the end — and stopping it leaves an empty bubble even
    // though the model had already written most of the reply
    "--include-partial-messages",
    ...(useStdin ? ["--input-format", "stream-json"] : []),
    "--verbose",
    "--dangerously-skip-permissions",
    ...claudeMcpArgs(), // Zotero library access
  ];
  let child: ReturnType<typeof spawn> | null = null;
  const stopChild = () => {
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    // The CLI ignores SIGTERM while a request is in flight often enough to
    // matter: a stopped answer that keeps generating costs tokens and CPU
    const proc = child;
    setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000).unref?.();
  };
  req.signal.addEventListener("abort", stopChild);

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn(claudeBin(), args);
      child = proc;
      if (useStdin) {
        proc.stdin.write(
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } },
                { type: "text", text: cleanPrompt },
              ],
            },
          }) + "\n"
        );
      }
      proc.stdin.end();
      proc.stdout.on("data", (c: Buffer) => controller.enqueue(c));
      proc.stdout.on("end", () => controller.close());
      proc.stderr.on("data", (d: Buffer) => console.error("[claude stderr]", d.toString().slice(0, 400)));
      proc.on("error", (err) => { console.error("[claude spawn error]", err); controller.error(err); });
    },
    cancel() {
      stopChild();
    },
  });
  return streamResponse(teeToThread(unwrapPartials(stream), teeOpts));
}
