import { spawn } from "child_process";
import { buildMindmapPrompt } from "@/lib/prompts";
import { extractMindmapJson } from "@/lib/mindmap-utils";
import { effortArgs, sanitizeSpawnArg } from "@/lib/model-flags";
import { resolveProvider, parseCustomConfig, codexComplete, customComplete, opencodeComplete } from "@/lib/providers";
import { writeMindmapFile } from "@/lib/session-store";
import { claudeBin } from "@/lib/bin";

export const runtime = "nodejs";

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

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(claudeBin(), [
      "-p", prompt,
      "--model", modelFlag,
      ...effortArgs(effort),
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ]);
    proc.stdin.end();

    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on("data", (d: Buffer) => console.error("[claude stderr]", d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited with code ${code}`));
    });
  }).catch((err) => {
    console.error("[mindmap]", err);
    return null;
  });

  if (stdout === null) {
    return Response.json({ error: "Failed to run Claude for mind map generation." }, { status: 500 });
  }

  try {
    const envelope = JSON.parse(stdout);
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
