import { unwrapPartials } from "@/lib/claude-stream";
import { effortFor } from "@/lib/model-catalog";
import { claudeStream, codexStream, customConfigFor, customStream, opencodeStream, resolveProvider, streamResponse } from "@/lib/providers";
import { buildWorkspaceAskMessage, type AskKind } from "@/lib/prompts";
import { SESSIONS_ROOT } from "@/lib/session-store";
import { describeReferencedPapers, describeWorkspacePapers, parsePaperRefs } from "@/lib/workspace-papers";
import { claudePermissionArgs, modeDirective, parseAgentMode } from "@/lib/workspace-modes";
import { chatHistorySection, freshStartOnLostSession, LOST_SESSION, parseChatHistory } from "@/lib/session-recovery";
import { selectedSkillPaths } from "@/lib/skills";
import { listWorkspaceFiles, validateWorkspaceRoot } from "@/lib/workspace-files";
import { decodeCodexSessionId } from "@/lib/codex-runtime";
import { requestImages } from "@/lib/message-images";
import { readAttachments, saveAttachments } from "@/lib/workspace-attachments";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  const question = typeof body.question === "string" ? body.question.trim() : "";
  // A passage or a figure of the open paper, asked about straight from the
  // page as in the Reader: the message is built the same way there and here
  const kind: AskKind | null = ["explain", "define", "question", "figure"].includes(body.kind) ? body.kind : null;
  const selectedText = typeof body.selected_text === "string" ? body.selected_text.trim() : "";
  const pageNumber = typeof body.page_number === "number" && body.page_number > 0 ? body.page_number : undefined;

  let root: string;
  try {
    root = await validateWorkspaceRoot(String(body.root || ""));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "invalid workspace", { status: 400 });
  }

  // The attached images: saved in the workspace by the client, by path; any
  // sent inline instead is saved here first. See lib/workspace-attachments
  const inline = requestImages(body.images_base64, body.image_base64);
  const imagePaths = [...(Array.isArray(body.image_paths) ? body.image_paths : []), ...(inline.length ? await saveAttachments(root, inline) : [])];
  const attached = await readAttachments(root, imagePaths);

  const provider = resolveProvider(body.model);
  const built = kind && (selectedText || attached.length || question)
    ? buildWorkspaceAskMessage({ kind, selectedText: selectedText || undefined, question: question || undefined, pageNumber, imageCount: attached.length })
    : question;
  if (!built.trim() && !attached.length) return new Response("question is required", { status: 400 });
  // An agent that works in the folder is told where the images are, to open
  // them again when the conversation comes back to them
  const request = attached.length && (provider === "claude" || provider === "codex")
    ? `${built}\n\n(${attached.length > 1 ? `The ${attached.length} attached images are` : "The attached image is"} saved in this workspace: ${attached.map((a) => a.path).join(", ")}. Open ${attached.length > 1 ? "them" : "it"} again by path when we come back to ${attached.length > 1 ? "them" : "it"}.)`
    : built;
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
  // The papers this message names with @, by the question
  const referencesSection = await describeReferencedPapers(body.references, { agentic: provider === "claude" || provider === "codex" });
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
${referencesSection ? `\n${referencesSection}\n` : ""}
User request: ${request}`;

  const isResume = typeof body.session_id === "string" && !!body.session_id;
  // A session the provider no longer has is started again, seeded with the
  // chat so far, which the client keeps; the failed start is never shown.
  // So is any session started mid-conversation — another agent taking over
  // the chat, or an endpoint that keeps no session at all — so whoever
  // answers knows what has been said.
  const history = chatHistorySection(parseChatHistory(body.history));
  const freshPrompt = () => (history ? prompt.replace("\n\nUser request: ", `\n\n${history}\n\nUser request: `) : prompt);
  if (provider === "codex") {
    const resumeId = decodeCodexSessionId(body.session_id);
    // Codex is pointed at the image files themselves
    const codexOpts = { images: attached.length ? attached.map((a) => a.file) : undefined, cwd: root, writable: true, model: body.model, effort: body.effort };
    const resumed = codexStream(resumeId ? prompt : freshPrompt(), {
      ...codexOpts,
      resumeId,
    });
    return streamResponse(freshStartOnLostSession(resumed, async () => codexStream(freshPrompt(), codexOpts), LOST_SESSION.codex));
  }

  if (provider === "opencode") {
    const opencodeOpts = {
      images: attached.length ? attached.map((a) => ({ mime: a.mime, dataUrl: a.dataUrl })) : undefined,
      model: body.model,
      effort: body.effort,
      webSearch: true,
      title: `workspace: ${root.split("/").pop()}`,
    };
    const resumed = opencodeStream(isResume ? prompt : freshPrompt(), { ...opencodeOpts, resumeId: isResume ? body.session_id : undefined });
    return streamResponse(freshStartOnLostSession(resumed, async () => opencodeStream(freshPrompt(), opencodeOpts), LOST_SESSION.opencode));
  }

  if (provider === "custom") {
    const found = await customConfigFor(body.model, body.custom);
    if (!found) return new Response("custom API is not configured", { status: 400 });
    const config = { ...found, effort: effortFor(body.model, body.effort) };
    const text = freshPrompt();
    const content = attached.length && config.vision
      ? [...attached.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })), { type: "text", text }]
      : attached.length ? `${text}\n\n(${attached.length > 1 ? `${attached.length} images were attached` : "An image was attached"}, but this model is text-only — answer from the text available.)` : text;
    return streamResponse(customStream(config, [{ role: "user", content }]));
  }

  // claude CLI, in the workspace's directory and the mode it runs in. The
  // papers' folders sit outside the workspace: the agent may read them
  let stderr = "";
  const runClaude = (text: string, resume: boolean) =>
    claudeStream(text, {
      model: body.model,
      effort: body.effort,
      resumeId: resume ? body.session_id : undefined,
      images: attached.map((a) => a.dataUrl),
      cwd: root,
      permissionArgs: claudePermissionArgs(mode),
      extraArgs: papers.length ? ["--add-dir", SESSIONS_ROOT] : [],
      onStderr: (chunk) => { stderr = (stderr + chunk).slice(-2000); },
      signal: req.signal,
    });
  const stream = freshStartOnLostSession(runClaude(isResume ? prompt : freshPrompt(), isResume), async () => runClaude(freshPrompt(), false), (output) => LOST_SESSION.claude(output, stderr));
  return streamResponse(unwrapPartials(stream));
}
