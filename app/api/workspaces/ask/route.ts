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
import { chatHistorySection, freshStartOnLostSession, LOST_SESSION, parseChatHistory } from "@/lib/session-recovery";
import { selectedSkillPaths } from "@/lib/skills";
import { listWorkspaceFiles, validateWorkspaceRoot } from "@/lib/workspace-files";
import { decodeCodexSessionId } from "@/lib/codex-runtime";

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
  // A session the provider no longer has is started again, seeded with the
  // chat so far, which the client keeps; the failed start is never shown
  const history = chatHistorySection(parseChatHistory(body.history));
  const freshPrompt = () => (history ? prompt.replace("\n\nUser request: ", `\n\n${history}\n\nUser request: `) : prompt);
  if (provider === "codex") {
    const resumeId = decodeCodexSessionId(body.session_id);
    const codexOpts = { images: imageFile ? [imageFile] : undefined, cwd: root, writable: true, effort: body.effort };
    const resumed = codexStream(prompt, {
      ...codexOpts,
      resumeId,
    });
    return streamResponse(freshStartOnLostSession(resumed, async () => codexStream(freshPrompt(), codexOpts), LOST_SESSION.codex, cleanupImage));
  }

  if (provider === "opencode") {
    const opencodeOpts = {
      images: imageDataUrl ? [{ mime: "image/png", dataUrl: imageDataUrl }] : undefined,
      effort: body.effort,
      webSearch: true,
      title: `workspace: ${root.split("/").pop()}`,
    };
    const resumed = opencodeStream(prompt, { ...opencodeOpts, resumeId: isResume ? body.session_id : undefined });
    return streamResponse(freshStartOnLostSession(resumed, async () => opencodeStream(freshPrompt(), opencodeOpts), LOST_SESSION.opencode));
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
  // An image can only go in through stdin, as a stream-json turn
  const useStdin = !!imageBase64;
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => { if (child && !child.killed) child.kill("SIGTERM"); };
  req.signal.addEventListener("abort", stop);
  // One run of the CLI: resuming the workspace's session, or starting afresh
  const spawnClaude = (text: string, resume: boolean, onStderr?: (chunk: string) => void): ReadableStream => {
    const cleanPrompt = sanitizeSpawnArg(text);
    const args = [
      "-p", ...(useStdin ? [] : [cleanPrompt]),
      ...(resume ? ["--resume", body.session_id] : []),
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
    return new ReadableStream({
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
        process.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); onStderr?.(text); console.error("[workspace claude]", text.slice(0, 400)); });
        process.on("error", (error) => controller.error(error));
      },
      cancel: stop,
    });
  };
  let stderr = "";
  const resumed = spawnClaude(prompt, isResume, (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const stream = freshStartOnLostSession(resumed, async () => spawnClaude(freshPrompt(), false), (output) => LOST_SESSION.claude(output, stderr));
  return streamResponse(unwrapPartials(stream));
}
