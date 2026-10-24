import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeBin } from "@/lib/bin";
import { unwrapPartials } from "@/lib/claude-stream";
import { claudeMcpArgs } from "@/lib/mcp-config";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { codexStream, customStream, opencodeStream, parseCustomConfig, resolveProvider, streamResponse } from "@/lib/providers";
import { buildWorkspaceAskMessage, type AskKind } from "@/lib/prompts";
import { SESSIONS_ROOT } from "@/lib/session-store";
import { describeWorkspacePapers, parsePaperRefs } from "@/lib/workspace-papers";
import { claudePermissionMode, modeDirective, parseAgentMode } from "@/lib/workspace-modes";
import { selectedSkillPaths } from "@/lib/skills";
import { listWorkspaceFiles, validateWorkspaceRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  const question = typeof body.question === "string" ? body.question.trim() : "";
  // A passage or a figure of the open paper, asked about straight from the
  // page as in the Reader: the message is built the same way there and here
  const kind: AskKind | null = ["explain", "define", "question", "figure"].includes(body.kind) ? body.kind : null;
  const selectedText = typeof body.selected_text === "string" ? body.selected_text.trim() : "";
  const pageNumber = typeof body.page_number === "number" && body.page_number > 0 ? body.page_number : undefined;
  const imageDataUrl = typeof body.image_base64 === "string" && body.image_base64.startsWith("data:image/") ? body.image_base64 : "";
  const imageBase64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
  const request = kind && (selectedText || imageDataUrl || question)
    ? buildWorkspaceAskMessage({ kind, selectedText: selectedText || undefined, question: question || undefined, pageNumber })
    : question;
  if (!request.trim() && !imageBase64) return new Response("question is required", { status: 400 });

  let root: string;
  try {
    root = await validateWorkspaceRoot(String(body.root || ""));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "invalid workspace", { status: 400 });
  }

  const provider = resolveProvider(body.model);
  // A discussion or an implementation: see lib/workspace-modes
  const mode = parseAgentMode(body.mode);
  const paths = await selectedSkillPaths(body.skills);
  const files = (await listWorkspaceFiles(root)).filter((entry) => entry.kind === "file").slice(0, 160).map((entry) => entry.path);
  const context = typeof body.context === "string" ? body.context.slice(0, 16000) : "";
  // The papers attached to the workspace, with what was read and asked
  // about each in the Reader: folders for an agent with file tools, a
  // digest inline for one without
  const papers = parsePaperRefs(body.papers);
  const papersSection = await describeWorkspacePapers(papers, { agentic: provider === "claude" || provider === "codex" });
  const capability = `${modeDirective(mode)} Files you create or edit stay inside the working directory.`;
  const prompt = `You are the research agent inside Paper Reader's workspace.

Working directory (fixed for this workspace): ${root}
${capability}
Live web search is always available. Search when current literature, documentation, or external evidence would improve the answer, and cite sources.
You may use Zotero MCP to inspect the user's library. Zotero writes still require an explicit request from the user.
Show your work economically: mention meaningful tools or files you used, but do not narrate trivial steps.
${paths.length ? `\nUser-selected skills (read each SKILL.md completely before using it):\n${paths.map((file) => `- ${file}`).join("\n")}` : ""}

Workspace files:\n${files.length ? files.map((file) => `- ${file}`).join("\n") : "(empty directory)"}
${papersSection ? `\n${papersSection}\n` : ""}${context ? `\nOpen document context:\n${context}` : ""}

User request: ${request}`;

  // A captured figure travels as a file to the CLI that takes one, and
  // inline to the providers that take images
  let imageFile: string | undefined;
  let cleanupImage: (() => void) | undefined;
  if (imageBase64 && provider === "codex") {
    const file = path.join(tmpdir(), `paper-reader-ws-fig-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(imageBase64, "base64"));
    imageFile = file;
    cleanupImage = () => { try { unlinkSync(file); } catch {} };
  }

  const isResume = typeof body.session_id === "string" && !!body.session_id;
  if (provider === "codex") {
    return streamResponse(codexStream(prompt, {
      images: imageFile ? [imageFile] : undefined,
      onClose: cleanupImage,
      cwd: root,
      writable: true,
      effort: body.effort,
      resumeId: isResume ? body.session_id : undefined,
    }));
  }

  if (provider === "opencode") {
    return streamResponse(opencodeStream(prompt, {
      images: imageDataUrl ? [{ mime: "image/png", dataUrl: imageDataUrl }] : undefined,
      effort: body.effort,
      resumeId: isResume ? body.session_id : undefined,
      webSearch: true,
      title: `workspace: ${root.split("/").pop()}`,
    }));
  }

  if (provider === "custom") {
    const config = parseCustomConfig(body.custom);
    if (!config) return new Response("custom API is not configured", { status: 400 });
    const content = imageDataUrl && config.vision
      ? [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: prompt }]
      : imageDataUrl ? `${prompt}\n\n(A figure was attached, but this model is text-only — answer from the text available.)` : prompt;
    return streamResponse(customStream(config, [{ role: "user", content }]));
  }

  const model = typeof body.model === "string" && body.model.startsWith("claude") ? body.model : "claude-sonnet-4-6";
  const cleanPrompt = sanitizeSpawnArg(prompt);
  // An image can only go in through stdin, as a stream-json turn
  const useStdin = !!imageBase64;
  const args = [
    "-p", ...(useStdin ? [] : [cleanPrompt]),
    ...(isResume ? ["--resume", body.session_id] : []),
    "--model", model,
    ...effortArgs(body.effort),
    "--output-format", "stream-json",
    "--include-partial-messages",
    ...(useStdin ? ["--input-format", "stream-json"] : []),
    "--verbose",
    "--permission-mode", claudePermissionMode(mode),
    // The papers' folders sit outside the workspace: the agent may read them
    ...(papers.length ? ["--add-dir", SESSIONS_ROOT] : []),
    ...claudeMcpArgs(),
  ];
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => { if (child && !child.killed) child.kill("SIGTERM"); };
  req.signal.addEventListener("abort", stop);
  const stream = new ReadableStream({
    start(controller) {
      const process = spawn(claudeBin(), args, { cwd: root });
      child = process;
      if (useStdin) {
        process.stdin.write(JSON.stringify({
          type: "user",
          message: { role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
            { type: "text", text: cleanPrompt },
          ] },
        }) + "\n");
      }
      process.stdin.end();
      process.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      process.stdout.on("end", () => controller.close());
      process.stderr.on("data", (chunk: Buffer) => console.error("[workspace claude]", chunk.toString().slice(0, 400)));
      process.on("error", (error) => controller.error(error));
    },
    cancel: stop,
  });
  return streamResponse(unwrapPartials(stream));
}
