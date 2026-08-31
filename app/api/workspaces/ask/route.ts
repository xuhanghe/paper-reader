import { spawn } from "node:child_process";
import { claudeBin } from "@/lib/bin";
import { unwrapPartials } from "@/lib/claude-stream";
import { claudeMcpArgs } from "@/lib/mcp-config";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { codexStream, customStream, opencodeStream, parseCustomConfig, resolveProvider, streamResponse } from "@/lib/providers";
import { selectedSkillPaths } from "@/lib/skills";
import { listWorkspaceFiles, validateWorkspaceRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return new Response("question is required", { status: 400 });

  let root: string;
  try {
    root = await validateWorkspaceRoot(String(body.root || ""));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "invalid workspace", { status: 400 });
  }

  const provider = resolveProvider(body.model);
  const allowWrites = body.allow_writes === true;
  const paths = await selectedSkillPaths(body.skills);
  const files = (await listWorkspaceFiles(root)).filter((entry) => entry.kind === "file").slice(0, 160).map((entry) => entry.path);
  const context = typeof body.context === "string" ? body.context.slice(0, 16000) : "";
  const capability = allowWrites
    ? "The user explicitly approved file writes for this turn. You may create or edit files, but only inside the working directory."
    : "This is a read-only turn. Do not create, edit, rename, or delete files. If a change would help, explain it and ask the user to approve a write turn.";
  const prompt = `You are the research agent inside Paper Reader's workspace.

Working directory (fixed for this workspace): ${root}
${capability}
Live web search is always available. Search when current literature, documentation, or external evidence would improve the answer, and cite sources.
You may use Zotero MCP to inspect the user's library. Zotero writes still require an explicit request from the user.
Show your work economically: mention meaningful tools or files you used, but do not narrate trivial steps.
${paths.length ? `\nUser-selected skills (read each SKILL.md completely before using it):\n${paths.map((file) => `- ${file}`).join("\n")}` : ""}

Workspace files:\n${files.length ? files.map((file) => `- ${file}`).join("\n") : "(empty directory)"}
${context ? `\nOpen document context:\n${context}` : ""}

User request: ${question}`;

  const isResume = typeof body.session_id === "string" && !!body.session_id;
  if (provider === "codex") {
    return streamResponse(codexStream(prompt, {
      cwd: root,
      writable: allowWrites,
      effort: body.effort,
      resumeId: isResume ? body.session_id : undefined,
    }));
  }

  if (provider === "opencode") {
    return streamResponse(opencodeStream(prompt, {
      effort: body.effort,
      resumeId: isResume ? body.session_id : undefined,
      webSearch: true,
      title: `workspace: ${root.split("/").pop()}`,
    }));
  }

  if (provider === "custom") {
    const config = parseCustomConfig(body.custom);
    if (!config) return new Response("custom API is not configured", { status: 400 });
    return streamResponse(customStream(config, [{ role: "user", content: prompt }]));
  }

  const model = typeof body.model === "string" && body.model.startsWith("claude") ? body.model : "claude-sonnet-4-6";
  const args = [
    "-p", sanitizeSpawnArg(prompt),
    ...(isResume ? ["--resume", body.session_id] : []),
    "--model", model,
    ...effortArgs(body.effort),
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", allowWrites ? "acceptEdits" : "plan",
    ...claudeMcpArgs(),
  ];
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => { if (child && !child.killed) child.kill("SIGTERM"); };
  req.signal.addEventListener("abort", stop);
  const stream = new ReadableStream({
    start(controller) {
      const process = spawn(claudeBin(), args, { cwd: root });
      child = process;
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
