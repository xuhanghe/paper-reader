import { spawn } from "child_process";
import { buildMindmapPrompt } from "@/lib/prompts";
import { extractMindmapJson } from "@/lib/mindmap-utils";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { resolveProvider, parseCustomConfig, codexComplete, customComplete, opencodeComplete } from "@/lib/providers";
import { writeMindmapFile } from "@/lib/session-store";
import { claudeBin } from "@/lib/bin";

export const runtime = "nodejs";

// What the CLI said on the way out, made short enough to show. An API error
// (a model it does not know, an expired login, a rate limit) arrives as a
// well-formed result on stdout with is_error set and exit code 1; anything
// else is on stderr, where the last lines name the problem.
export function describeExit(code: number | null, stdout: string, stderr: string): string {
  try {
    const envelope = JSON.parse(stdout);
    if (envelope?.is_error && typeof envelope.result === "string" && envelope.result.trim()) {
      return envelope.result.trim().slice(0, 400);
    }
  } catch {
    // not a result envelope — fall through to stderr
  }
  const said = stderr.trim().split("\n").filter(Boolean).slice(-4).join(" ").replace(/\s+/g, " ").slice(0, 400);
  return said ? `claude exited with code ${code}: ${said}` : `claude exited with code ${code}`;
}

export async function POST(req: Request) {
  const { paper_text, model, effort, custom, paper_id } = await req.json();

  if (!paper_text?.trim()) {
    return Response.json({ error: "paper_text is required" }, { status: 400 });
  }

  const modelFlag = model || "claude-sonnet-4-6";
  const prompt = sanitizeSpawnArg(buildMindmapPrompt(paper_text));

  const provider = resolveProvider(model);
  if (provider !== "claude") {
    try {
      let text: string;
      if (provider === "codex") {
        text = await codexComplete(prompt, effort);
      } else if (provider === "opencode") {
        text = await opencodeComplete(prompt, effort);
      } else {
        const cfg = parseCustomConfig(custom);
        if (!cfg) return Response.json({ error: "custom API is not configured" }, { status: 400 });
        text = await customComplete(cfg, [{ role: "user", content: prompt }]);
      }
      const mindmap = extractMindmapJson(text);
      if (!mindmap) return Response.json({ error: "The model did not return a valid mind map." }, { status: 500 });
      if (typeof paper_id === "string" && paper_id) await writeMindmapFile(paper_id, mindmap).catch(() => {});
      return Response.json({ mindmap });
    } catch (err) {
      console.error("[mindmap]", err);
      return Response.json({ error: "Failed to generate the mind map with the selected model." }, { status: 500 });
    }
  }

  // The prompt is the whole paper, so it goes in on stdin rather than as an
  // argument: a long paper would otherwise run past the argument size limit,
  // and the CLI reads its prompt from stdin when none is given.
  const result = await new Promise<{ ok: true; out: string } | { ok: false; error: string }>((resolve) => {
    const proc = spawn(claudeBin(), [
      "-p",
      "--model", modelFlag,
      ...effortArgs(effort),
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ]);
    proc.stdin.on("error", () => {}); // a CLI that exits early closes the pipe first
    proc.stdin.end(prompt);

    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    proc.on("error", (spawnError) => resolve({ ok: false, error: `could not start claude: ${spawnError.message}` }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true, out });
      else resolve({ ok: false, error: describeExit(code, out, err) });
    });
  });

  if (!result.ok) {
    console.error("[mindmap]", result.error);
    return Response.json({ error: `Could not generate the map — ${result.error}` }, { status: 500 });
  }

  try {
    const envelope = JSON.parse(result.out);
    // A refusal or an API error comes back as a well-formed result too
    if (envelope.is_error) {
      const said = typeof envelope.result === "string" ? envelope.result.slice(0, 300) : "the model returned an error";
      return Response.json({ error: `Could not generate the map — ${said}` }, { status: 500 });
    }
    const resultText: string = typeof envelope.result === "string" ? envelope.result : "";
    const mindmap = extractMindmapJson(resultText);
    if (!mindmap) {
      return Response.json({ error: "Claude did not return a valid mind map." }, { status: 500 });
    }
    if (typeof paper_id === "string" && paper_id) await writeMindmapFile(paper_id, mindmap).catch(() => {});
    return Response.json({ mindmap });
  } catch {
    return Response.json({ error: "Could not parse Claude's response." }, { status: 500 });
  }
}
