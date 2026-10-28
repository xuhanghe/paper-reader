import { spawn } from "child_process";
import { sanitizeSpawnArg } from "./model-flags";
import { claudeBin, codexBin } from "./bin";
import { encodeCodexSessionId, prepareCodexEnvironment } from "./codex-runtime";
import { claudeMcpArgs, codexMcpArgs } from "./mcp-config";
import { ensureServer } from "./opencode-server";
import { parseModelSpec, providerIdFor, type ProviderId } from "./model-spec";
import { effortFor, knownModel } from "./model-catalog";
import { getEndpoint, listEndpoints } from "./endpoints";
import { createLineSplitter, parseJsonLine } from "./ndjson";
import type { ToolResult, ToolSpec } from "./endpoint-tools";

// Multi-provider backend. Every provider emits newline-delimited JSON with
// {type:"content_block_delta", delta:{type:"text_delta", text}} events — the
// same shape the client already parses from the claude CLI stream.
//
// Which provider and model a question runs on is one string, the model spec
// (lib/model-spec); which models and efforts exist is asked of each backend
// (lib/model-catalog).

export type Provider = ProviderId;
export type CustomApiFormat = "openai" | "anthropic";
export type CustomConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  vision?: boolean;
  format: CustomApiFormat;
  maxTokens?: number;
  // OpenRouter's normalized reasoning effort, when the endpoint said the model takes it
  effort?: string;
  // Whether the model takes tools, when the endpoint says; unknown is tried
  tools?: boolean;
};

const ANTHROPIC_VERSION = "2023-06-01";
// Anthropic rejects a request without max_tokens, so one is always sent
const DEFAULT_MAX_TOKENS = 8192;
// The CLI ignores SIGTERM while a request is in flight often enough to matter:
// a stopped answer that keeps generating costs tokens and CPU
const KILL_GRACE_MS = 2000;

export function resolveProvider(model: unknown): Provider {
  return providerIdFor(model);
}

/** A custom endpoint config sent by the browser, as versions before saved endpoints did. */
export function parseCustomConfig(value: unknown): CustomConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.baseUrl !== "string" || !v.baseUrl.trim()) return null;
  if (typeof v.model !== "string" || !v.model.trim()) return null;
  const maxTokens = Number(v.maxTokens);
  return {
    baseUrl: v.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: typeof v.apiKey === "string" ? v.apiKey.trim() : "",
    model: v.model.trim(),
    vision: v.vision === true,
    // Configs saved before formats existed have no field and stay on OpenAI
    format: v.format === "anthropic" ? "anthropic" : "openai",
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
  };
}

/**
 * The endpoint a `custom…` model spec names, with its key, read on the server.
 * A bare "custom" — what sessions saved before endpoints were stored hold — is
 * the config the browser still sends, else the first saved endpoint.
 */
export async function customConfigFor(spec: unknown, legacy?: unknown): Promise<CustomConfig | null> {
  const parsed = parseModelSpec(spec);
  if (parsed.provider !== "custom") return null;
  if (!parsed.endpointId) {
    const sent = parseCustomConfig(legacy);
    if (sent) return sent;
  }
  const endpoint = parsed.endpointId ? await getEndpoint(parsed.endpointId) : (await listEndpoints())[0] ?? null;
  if (!endpoint) return null;
  const model = parsed.model ?? endpoint.defaultModel;
  const known = knownModel(parsed.endpointId ? spec : `custom:${endpoint.id}:${model}`);
  return {
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model,
    vision: known?.vision ?? endpoint.vision,
    ...(known?.tools !== undefined ? { tools: known.tools } : {}),
    format: endpoint.format,
    ...(endpoint.maxTokens ? { maxTokens: endpoint.maxTokens } : {}),
  };
}

const encoder = new TextEncoder();
const encodeEvent = (text: string) =>
  encoder.encode(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }) + "\n");

export function streamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

// Stops a child: politely, then for certain
function stopChild(proc: ReturnType<typeof spawn> | null) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }, KILL_GRACE_MS).unref?.();
}

// ── Claude CLI ──────────────────────────────────────────────────────

export type ClaudeRunOptions = {
  model?: unknown;
  effort?: unknown;
  resumeId?: string;
  // A captured figure, as base64 PNG: it can only reach the CLI as a stream-json turn on stdin
  imageBase64?: string | null;
  cwd?: string;
  // How tools are permitted: the Reader skips prompts, the Workspace passes its mode
  permissionArgs?: string[];
  extraArgs?: string[];
  onStderr?: (chunk: string) => void;
  // The request's own signal: a client that goes away stops the CLI
  signal?: AbortSignal;
};

/** The claude CLI's --model and --effort for a model spec; empty for its own defaults. */
export function claudeModelArgs(model: unknown, effort: unknown): string[] {
  const parsed = parseModelSpec(model);
  const args = parsed.provider === "claude" && parsed.model ? ["--model", parsed.model] : [];
  const level = effortFor(parsed.provider === "claude" ? model : undefined, effort);
  return level ? [...args, "--effort", level] : args;
}

export function claudeArgs(prompt: string, opts: ClaudeRunOptions = {}): string[] {
  const viaStdin = !!opts.imageBase64;
  return [
    "-p", ...(viaStdin ? [] : [sanitizeSpawnArg(prompt)]),
    ...(opts.resumeId ? ["--resume", opts.resumeId] : []),
    ...claudeModelArgs(opts.model, opts.effort),
    "--output-format", "stream-json",
    // Without this the CLI only reports whole messages, so an answer appears
    // in one lump at the end — and stopping it leaves an empty bubble even
    // though the model had already written most of the reply
    "--include-partial-messages",
    ...(viaStdin ? ["--input-format", "stream-json"] : []),
    "--verbose",
    ...(opts.permissionArgs ?? ["--dangerously-skip-permissions"]),
    ...(opts.extraArgs ?? []),
    ...claudeMcpArgs(), // Zotero library access
  ];
}

/** One run of the claude CLI, streaming its stream-json output. */
export function claudeStream(prompt: string, opts: ClaudeRunOptions = {}): ReadableStream {
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => stopChild(child);
  opts.signal?.addEventListener("abort", stop, { once: true });
  return new ReadableStream({
    start(controller) {
      let open = true;
      const close = (error?: Error) => {
        if (!open) return;
        open = false;
        opts.signal?.removeEventListener("abort", stop);
        if (error) controller.error(error);
        else controller.close();
      };
      const proc = spawn(claudeBin(), claudeArgs(prompt, opts), opts.cwd ? { cwd: opts.cwd } : undefined);
      child = proc;
      if (opts.imageBase64) {
        proc.stdin.write(
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: opts.imageBase64 } },
                { type: "text", text: sanitizeSpawnArg(prompt) },
              ],
            },
          }) + "\n"
        );
      }
      proc.stdin.on("error", () => {}); // EPIPE when the CLI exits before reading
      proc.stdin.end();
      proc.stdout.on("data", (chunk: Buffer) => {
        if (open) controller.enqueue(chunk);
      });
      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        opts.onStderr?.(chunk);
        console.error("[claude stderr]", chunk.slice(0, 400));
      });
      proc.on("close", () => close());
      proc.on("error", (err) => {
        console.error("[claude spawn error]", err);
        close(err);
      });
    },
    cancel() {
      stop();
    },
  });
}

// ── One-shot completions ────────────────────────────────────────────
// For the things that are not a conversation: the paper map, a conversation's
// takeaways. No session, no streaming, no resume — ask once, read the answer.

export async function claudeComplete(prompt: string, opts?: { model?: unknown; effort?: unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(claudeBin(), [
      "-p", sanitizeSpawnArg(prompt),
      ...claudeModelArgs(opts?.model, opts?.effort),
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ]);
    proc.stdin.end();
    let out = "";
    // Decoded as a stream: a character split across two chunks stays whole
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => { out += c; });
    proc.stderr.on("data", (d: Buffer) => console.error("[claude stderr]", d.toString().slice(0, 400)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited with ${code}`));
      try {
        const envelope = JSON.parse(out);
        resolve(typeof envelope.result === "string" ? envelope.result : "");
      } catch {
        reject(new Error("could not parse the claude envelope"));
      }
    });
  });
}

// Whichever provider and model the reader picked, asked once and answered in full
export async function completeWith(
  model: unknown,
  prompt: string,
  opts?: { effort?: unknown; custom?: unknown }
): Promise<string> {
  switch (resolveProvider(model)) {
    case "codex":
      return codexComplete(prompt, { model, effort: opts?.effort });
    case "opencode":
      return opencodeComplete(prompt, { model, effort: opts?.effort });
    case "custom": {
      const cfg = await customConfigFor(model, opts?.custom);
      if (!cfg) throw new Error("custom API is not configured");
      return customComplete({ ...cfg, effort: effortFor(model, opts?.effort) }, [{ role: "user", content: prompt }]);
    }
    default:
      return claudeComplete(prompt, { model, effort: opts?.effort });
  }
}

// ── Codex CLI ───────────────────────────────────────────────────────

type CodexRunOptions = {
  images?: string[];
  // A model spec; "codex" alone runs Codex's own default model
  model?: unknown;
  effort?: unknown;
  resumeId?: string;
  cwd?: string;
  writable?: boolean;
};

export function codexArgs(prompt: string, opts?: CodexRunOptions): string[] {
  // Execution policy belongs to the root Codex parser. In particular,
  // `codex exec resume` does not accept `-s`, even though `codex exec` does.
  // Keep every root option before `exec` so a resumed selection conversation
  // is parsed exactly like its first turn.
  const args = ["--search"];
  if (opts?.cwd) args.push("-C", opts.cwd);
  if (opts?.writable) args.push("-a", "never");
  args.push("-s", opts?.writable ? "workspace-write" : "read-only");
  args.push(...codexMcpArgs()); // Zotero library access
  // Config overrides, like the effort below, so they apply to a resumed turn too.
  // The user's own config is ignored (see below), so without this Codex runs
  // its built-in default model, whatever was picked.
  const parsed = parseModelSpec(opts?.model);
  if (parsed.provider === "codex" && parsed.model) args.push("-c", `model="${parsed.model}"`);
  const eff = effortFor(parsed.provider === "codex" ? opts?.model : "codex", opts?.effort);
  if (eff) args.push("-c", `model_reasoning_effort="${eff}"`);

  args.push("exec");
  // These are documented `codex exec` automation flags. Paper Reader supplies
  // its policy explicitly instead of inheriting a mutable interactive config.
  args.push("--ignore-user-config", "--ignore-rules");
  if (opts?.resumeId) args.push("resume");
  // Sessions are kept (no --ephemeral) so the per-paper conversation can resume
  args.push("--json", "--skip-git-repo-check");
  for (const img of opts?.images ?? []) args.push("-i", img);
  if (opts?.resumeId) args.push(opts.resumeId);
  args.push(sanitizeSpawnArg(prompt));
  return args;
}

export function codexExitMessage(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = [...lines].reverse().find((line) =>
    /(?:error|failed|missing|denied|not found|invalid)/i.test(line)
  ) ?? lines.at(-1);
  const status = code === null ? "unexpectedly" : `with code ${code}`;
  const suffix = detail ? ` ${detail.slice(0, 500)}` : "";
  return `Error: Codex exited ${status} before returning an answer.${suffix}`;
}

export function codexStream(
  prompt: string,
  opts?: CodexRunOptions & { onClose?: () => void }
): ReadableStream {
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      const proc = spawn(codexBin(), codexArgs(prompt, opts), {
        env: prepareCodexEnvironment(),
      });
      child = proc;
      proc.stdin.end();
      let stderr = "";
      let sawAgentText = false;
      let finished = false;
      let closeCallbackCalled = false;

      const runCloseCallback = () => {
        if (closeCallbackCalled) return;
        closeCallbackCalled = true;
        opts?.onClose?.();
      };
      const enqueue = (chunk: Uint8Array) => {
        if (finished || cancelled) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // The HTTP consumer can disappear before the child process exits.
          // Treat that exactly like stream cancellation and let close cleanup
          // run without trying to write to an already-closed controller.
          cancelled = true;
        }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        runCloseCallback();
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          // Cancellation may race the child process close event.
        }
      };
      // What has already been sent for each message, so an item reported while
      // it is still being written contributes only the part that is new. Codex
      // may only report finished messages, in which case this sends the whole
      // one exactly once — but where it does report progress, stopping an
      // answer now keeps the text that had arrived.
      const sent = new Map<string, string>();
      const emitAgentMessage = (item: { id?: unknown; type?: string; text?: unknown }) => {
        if (item?.type !== "agent_message" || typeof item.text !== "string") return;
        const key = typeof item.id === "string" ? item.id : "";
        const already = sent.get(key) ?? "";
        const delta = item.text.startsWith(already) ? item.text.slice(already.length) : item.text;
        sent.set(key, item.text);
        if (delta) {
          sawAgentText = true;
          enqueue(encodeEvent(delta));
        }
      };
      const lines = createLineSplitter((line) => {
        const ev = parseJsonLine(line) as { type?: string; thread_id?: unknown; item?: Record<string, unknown> } | undefined;
        if (!ev) return;
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
          // Normalized session event — client captures it like claude's init
          enqueue(encoder.encode(JSON.stringify({
            type: "system",
            session_id: encodeCodexSessionId(ev.thread_id),
          }) + "\n"));
        } else if (ev.type === "item.updated" || ev.type === "item.completed") {
          const item = ev.item ?? {};
          emitAgentMessage(item);
          if (ev.type === "item.completed" && item.type !== "agent_message" && item.type !== "reasoning") {
            const name = item.type === "web_search"
              ? "web.search"
              : item.type === "command_execution"
                ? "workspace.command"
                : item.type === "mcp_tool_call"
                  ? String(item.server || "mcp") + "." + String(item.tool || "tool")
                  : String(item.type || "tool");
            const detail = String(item.query || item.command || item.status || "Completed").slice(0, 180);
            enqueue(encoder.encode(JSON.stringify({ type: "tool", name, detail, status: "completed" }) + "\n"));
          }
        }
      });
      // Decoded as a stream: a character split across two chunks stays whole
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => lines.push(chunk));
      proc.stdout.on("end", () => lines.end());
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-4000);
        console.error("[codex stderr]", text.slice(0, 400));
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          enqueue(encodeEvent(`${sawAgentText ? "\n\n" : ""}${codexExitMessage(stderr, code)}`));
        } else if (!sawAgentText) {
          const message = stderr.trim()
            ? codexExitMessage(stderr, code)
            : "Error: Codex finished without returning an answer.";
          enqueue(encodeEvent(message));
        }
        finish();
      });
      proc.on("error", (err) => {
        console.error("[codex spawn error]", err);
        enqueue(encodeEvent("Error: could not run the Codex CLI. Is it installed and logged in?"));
        finish();
      });
    },
    // Stopping an answer has to stop the model too; a child left running
    // finishes the reply nobody will read, on the reader's own machine
    cancel() {
      cancelled = true;
      stopChild(child);
    },
  });
}

export async function codexComplete(prompt: string, opts?: { model?: unknown; effort?: unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(codexBin(), codexArgs(prompt, { model: opts?.model, effort: opts?.effort }), {
      env: prepareCodexEnvironment(),
    });
    proc.stdin.end();
    let stderr = "";
    const texts: string[] = [];
    const lines = createLineSplitter((line) => {
      const ev = parseJsonLine(line) as { type?: string; item?: { type?: string; text?: unknown } } | undefined;
      if (ev?.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
        texts.push(ev.item.text);
      }
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => lines.push(c));
    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-4000);
      console.error("[codex stderr]", text.slice(0, 400));
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      lines.end();
      if (code !== 0) return reject(new Error(codexExitMessage(stderr, code)));
      resolve(texts.join("\n"));
    });
  });
}

// ── opencode (headless HTTP server) ─────────────────────────────────

const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS) || 180000;
// Used only when neither the picked model, OPENCODE_MODEL nor opencode's own config names one
const OPENCODE_FALLBACK_MODEL = "opencode/claude-sonnet-4-6";
// Everything that touches the machine stays off: opencode answers from the
// context we inject, exactly like the custom provider. MCP tools are absent
// from this map on purpose — `tools` is a map of overrides, so leaving Zotero
// unlisted keeps it enabled.
const OPENCODE_DISABLED_TOOLS = [
  "bash", "edit", "write", "patch", "read", "glob", "grep", "list", "task", "todowrite",
];
const OPENCODE_SEARCH_TOOLS = ["websearch", "webfetch", "web_search"];

export type OpencodeImage = { mime: string; dataUrl: string };
type OpencodeModelRef = { providerID: string; modelID: string };

function opencodeTools(webSearch?: boolean): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const name of OPENCODE_DISABLED_TOOLS) tools[name] = false;
  for (const name of OPENCODE_SEARCH_TOOLS) tools[name] = webSearch === true;
  return tools;
}

const splitOpencodeModel = (id: string): OpencodeModelRef => {
  const slash = id.indexOf("/");
  return slash > 0 ? { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) } : { providerID: "opencode", modelID: id };
};

async function opencodeModel(baseUrl: string, spec?: unknown): Promise<OpencodeModelRef> {
  const picked = parseModelSpec(spec);
  if (picked.provider === "opencode" && picked.model) return splitOpencodeModel(picked.model);
  let raw = process.env.OPENCODE_MODEL;
  if (!raw) {
    try {
      const res = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout(5000) });
      const cfg = res.ok ? await res.json() : null;
      if (typeof cfg?.model === "string") raw = cfg.model;
    } catch {
      // fall through to the default
    }
  }
  return splitOpencodeModel(raw || OPENCODE_FALLBACK_MODEL);
}

async function openSession(baseUrl: string, title?: string): Promise<string> {
  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title?.slice(0, 120) || "paper-reader" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`opencode session create failed (${res.status})`);
  const data = await res.json();
  if (typeof data?.id !== "string") throw new Error("opencode returned no session id");
  return data.id;
}

function messageBody(
  prompt: string,
  model: OpencodeModelRef,
  opts?: { images?: OpencodeImage[]; spec?: unknown; effort?: unknown; webSearch?: boolean }
) {
  const parts: unknown[] = (opts?.images ?? []).map((img) => ({
    type: "file",
    mime: img.mime,
    url: img.dataUrl,
    filename: "figure.png",
  }));
  parts.push({ type: "text", text: prompt });
  // The effort is the model's own variant name (see lib/model-catalog)
  const variant = effortFor(parseModelSpec(opts?.spec).provider === "opencode" ? opts?.spec : "opencode", opts?.effort);
  return {
    parts,
    model,
    tools: opencodeTools(opts?.webSearch),
    ...(variant ? { variant } : {}),
  };
}

// Text of a finished assistant message, as returned by POST …/message
function assistantText(body: unknown): string {
  const parts = (body as { parts?: { type?: string; text?: string }[] })?.parts ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export function opencodeStream(
  prompt: string,
  opts?: {
    images?: OpencodeImage[];
    model?: unknown;
    effort?: unknown;
    resumeId?: string;
    webSearch?: boolean;
    title?: string;
  }
): ReadableStream {
  const events = new AbortController();
  let baseUrl = "";
  let sessionId = opts?.resumeId ?? "";

  // Cancel the run opencode is doing on our behalf — no other provider here can
  // do this, so a client that navigates away leaves nothing running.
  const abortRun = () => {
    events.abort();
    if (baseUrl && sessionId) {
      fetch(`${baseUrl}/session/${sessionId}/abort`, { method: "POST" }).catch(() => {});
    }
  };

  return new ReadableStream({
    async start(controller) {
      let streamed = "";
      try {
        baseUrl = await ensureServer();
        if (!sessionId) sessionId = await openSession(baseUrl, opts?.title);
        // Emitted before the answer so the id is saved even if the run fails
        controller.enqueue(encoder.encode(JSON.stringify({ type: "system", session_id: sessionId }) + "\n"));

        // Subscribe before prompting, or the first deltas are missed
        const evRes = await fetch(`${baseUrl}/event`, { signal: events.signal });
        const pump = (async () => {
          if (!evRes.ok || !evRes.body) return;
          const reader = evRes.body.getReader();
          const decoder = new TextDecoder();
          const lines = createLineSplitter((line) => {
            const t = line.trim();
            if (!t.startsWith("data:")) return;
            const ev = parseJsonLine(t.slice(5)) as { type?: string; properties?: Record<string, unknown> } | undefined;
            const p = ev?.properties ?? {};
            if (p.sessionID !== sessionId) return;
            if (ev?.type === "message.part.delta" && p.field === "text" && typeof p.delta === "string") {
              streamed += p.delta;
              controller.enqueue(encodeEvent(p.delta));
            }
          });
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            lines.push(decoder.decode(value, { stream: true }));
          }
        })();

        const model = await opencodeModel(baseUrl, opts?.model);
        const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messageBody(prompt, model, { ...opts, spec: opts?.model })),
          signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          controller.enqueue(encodeEvent(`Error: opencode responded with ${res.status}. ${detail}`));
        } else {
          // The POST resolves with the finished message; if the event stream
          // dropped anything, send the tail so the answer is never truncated
          const final = assistantText(await res.json().catch(() => ({})));
          if (final && final.startsWith(streamed) && final.length > streamed.length) {
            controller.enqueue(encodeEvent(final.slice(streamed.length)));
          } else if (final && !streamed) {
            controller.enqueue(encodeEvent(final));
          }
        }
        events.abort();
        await pump.catch(() => {});
      } catch (err) {
        abortRun();
        console.error("[opencode]", err);
        const detail = err instanceof Error ? err.message : String(err);
        controller.enqueue(encodeEvent(`Error: could not reach the opencode server. ${detail}`));
      }
      controller.close();
    },
    cancel() {
      abortRun();
    },
  });
}

export async function opencodeComplete(prompt: string, opts?: { model?: unknown; effort?: unknown }): Promise<string> {
  const baseUrl = await ensureServer();
  const sessionId = await openSession(baseUrl, "paper-reader map");
  const model = await opencodeModel(baseUrl, opts?.model);
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageBody(prompt, model, { spec: opts?.model, effort: opts?.effort })),
    signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`opencode responded with ${res.status}`);
  return assistantText(await res.json());
}

// ── Custom API: OpenAI or Anthropic wire format ─────────────────────

type ChatMessage = { role: string; content: unknown; [field: string]: unknown };

// Anthropic takes the system prompt as a top-level field rather than a message,
// and describes images differently. Callers keep building OpenAI-shaped
// content; the translation happens here so there's only one message builder.
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: ChatMessage[] } {
  const system: string[] = [];
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") system.push(m.content);
      continue;
    }
    out.push({ role: m.role, content: toAnthropicContent(m.content) });
  }
  return { system: system.length ? system.join("\n\n") : undefined, messages: out };
}

function toAnthropicContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const p = part as { type?: string; image_url?: { url?: string } };
    if (p.type !== "image_url" || typeof p.image_url?.url !== "string") return part;
    const url = p.image_url.url;
    const dataUrl = /^data:([^;]+);base64,(.*)$/.exec(url);
    return dataUrl
      ? { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } }
      : { type: "image", source: { type: "url", url } };
  });
}

// Anthropic's own endpoint is /v1/messages; proxies are often configured with
// the /v1 already on the base URL, so don't double it.
function anthropicUrl(baseUrl: string): string {
  return /\/v1$/.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}

type WireFormat = {
  url: string;
  headers: Record<string, string>;
  body: (stream: boolean) => string;
  // Text carried by one streamed SSE payload ("" when the event isn't text)
  deltaText: (event: unknown) => string;
  // Text of a complete, non-streamed response
  fullText: (data: unknown) => string;
};

function wireFormat(cfg: CustomConfig, messages: ChatMessage[]): WireFormat {
  if (cfg.format === "anthropic") {
    const { system, messages: converted } = toAnthropicMessages(messages);
    return {
      url: anthropicUrl(cfg.baseUrl),
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      body: (stream) =>
        JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: converted,
          stream,
        }),
      deltaText: (event) => {
        const e = event as { type?: string; delta?: { type?: string; text?: string } };
        return e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string"
          ? e.delta.text
          : "";
      },
      fullText: (data) => {
        const blocks = (data as { content?: { type?: string; text?: string }[] })?.content ?? [];
        return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
      },
    };
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: (stream) => JSON.stringify({ model: cfg.model, messages, stream, ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}) }),
    deltaText: (event) => {
      const delta = (event as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content;
      return typeof delta === "string" ? delta : "";
    },
    fullText: (data) =>
      (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "",
  };
}

export function customStream(cfg: CustomConfig, messages: ChatMessage[]): ReadableStream {
  const wire = wireFormat(cfg, messages);
  const aborted = new AbortController();
  return new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(wire.url, {
          method: "POST",
          headers: wire.headers,
          body: wire.body(true),
          signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(180000)]),
        });
        if (!res.ok || !res.body) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          controller.enqueue(encodeEvent(`Error: custom API responded with ${res.status}. ${detail}`));
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const lines = createLineSplitter((line) => {
          const t = line.trim();
          if (!t.startsWith("data:")) return;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") return;
          const text = wire.deltaText(parseJsonLine(payload));
          if (text) controller.enqueue(encodeEvent(text));
        });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lines.push(decoder.decode(value, { stream: true }));
        }
        lines.end();
        controller.close();
      } catch {
        if (aborted.signal.aborted) return;
        controller.enqueue(encodeEvent("Error: could not reach the custom API endpoint."));
        controller.close();
      }
    },
    // Stopping an answer stops the request too, so the endpoint stops generating
    cancel() {
      aborted.abort();
    },
  });
}

export async function customComplete(cfg: CustomConfig, messages: ChatMessage[]): Promise<string> {
  const wire = wireFormat(cfg, messages);
  const res = await fetch(wire.url, {
    method: "POST",
    headers: wire.headers,
    body: wire.body(false),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`custom API responded with ${res.status}`);
  return wire.fullText(await res.json());
}

// ── Custom API with the reader's tools ──────────────────────────────
//
// A model behind an API reads the paper with tools that run here
// (lib/endpoint-tools), through the API's own function calling: it is sent
// their definitions, answers with calls when it wants one, and is sent back
// what they returned — round after round until it answers. What it writes on
// the way streams as it comes, and each call is announced to the panel as a
// "tool" event. An endpoint or model that takes no tools is asked again the
// old way, with what `fallback` builds.

export type ToolRunner = {
  specs: ToolSpec[];
  run: (name: string, args: unknown) => Promise<ToolResult>;
};

type ToolCall = { id: string; name: string; args: string };
type StreamEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  choices?: { delta?: { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
};

const TOOL_ROUNDS = 6;

// One response: the text, streamed as it comes, and the calls it ends with
async function readResponse(body: ReadableStream<Uint8Array>, anthropic: boolean, onText: (text: string) => void): Promise<{ text: string; calls: ToolCall[] }> {
  const calls = new Map<number, ToolCall>();
  let text = "";
  const said = (piece: string) => {
    text += piece;
    onText(piece);
  };
  const lines = createLineSplitter((line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const event = parseJsonLine(payload) as StreamEvent | undefined;
    if (!event) return;
    if (anthropic) {
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        calls.set(event.index ?? 0, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", args: "" });
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) said(event.delta.text);
        else if (event.delta?.type === "input_json_delta") {
          const call = calls.get(event.index ?? 0);
          if (call) call.args += event.delta.partial_json ?? "";
        }
      }
      return;
    }
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) said(delta.content);
    for (const piece of delta?.tool_calls ?? []) {
      const index = piece.index ?? 0;
      const call = calls.get(index) ?? { id: "", name: "", args: "" };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name ||= piece.function.name;
      if (piece.function?.arguments) call.args += piece.function.arguments;
      calls.set(index, call);
    }
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true }));
  }
  lines.end();
  return { text, calls: [...calls.values()].filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` })) };
}

const parseArgs = (args: string): unknown => {
  try {
    return args.trim() ? JSON.parse(args) : {};
  } catch {
    return {};
  }
};

export function customAgentStream(cfg: CustomConfig, messages: ChatMessage[], tools: ToolRunner, fallback: () => Promise<ChatMessage[]>): ReadableStream {
  const aborted = new AbortController();
  const anthropic = cfg.format === "anthropic";
  const wire = wireFormat(cfg, messages);
  const converted = anthropic ? toAnthropicMessages(messages) : null;
  const history: ChatMessage[] = converted ? [...converted.messages] : [...messages];
  const body = (last: boolean) =>
    JSON.stringify(anthropic
      ? {
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(converted?.system ? { system: converted.system } : {}),
          messages: history,
          stream: true,
          tools: tools.specs.map((s) => ({ name: s.name, description: s.description, input_schema: s.parameters })),
          // The last round answers with what it has
          ...(last ? { tool_choice: { type: "none" } } : {}),
        }
      : {
          model: cfg.model,
          messages: history,
          stream: true,
          tools: tools.specs.map((s) => ({ type: "function", function: s })),
          ...(last ? { tool_choice: "none" } : {}),
          ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
        });

  return new ReadableStream({
    async start(controller) {
      const text = (piece: string) => controller.enqueue(encodeEvent(piece));
      try {
        for (let round = 0; round < TOOL_ROUNDS; round++) {
          const res = await fetch(wire.url, {
            method: "POST",
            headers: wire.headers,
            body: body(round === TOOL_ROUNDS - 1),
            signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(180000)]),
          });
          if (!res.ok || !res.body) {
            const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
            if (round === 0 && [400, 404, 422].includes(res.status) && /tool|function/i.test(detail)) {
              const reader = customStream(cfg, await fallback()).getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
              return;
            }
            text(`Error: custom API responded with ${res.status}. ${detail.slice(0, 200)}`);
            controller.close();
            return;
          }
          const turn = await readResponse(res.body, anthropic, text);
          if (!turn.calls.length) break;

          const results: ToolResult[] = [];
          for (const call of turn.calls) {
            const result = await tools.run(call.name, parseArgs(call.args)).catch((): ToolResult => ({ text: "The tool failed.", activity: "Working" }));
            controller.enqueue(encoder.encode(JSON.stringify({ type: "tool", name: call.name, detail: result.activity, status: "completed" }) + "\n"));
            results.push(result);
          }
          if (anthropic) {
            history.push({
              role: "assistant",
              content: [
                ...(turn.text ? [{ type: "text", text: turn.text }] : []),
                ...turn.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.args) })),
              ],
            });
            history.push({
              role: "user",
              content: turn.calls.map((c, i) => ({
                type: "tool_result",
                tool_use_id: c.id,
                content: [
                  { type: "text", text: results[i].text },
                  ...(toAnthropicContent((results[i].images ?? []).map((url) => ({ type: "image_url", image_url: { url } }))) as unknown[]),
                ],
              })),
            });
          } else {
            history.push({
              role: "assistant",
              content: turn.text || null,
              tool_calls: turn.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
            });
            turn.calls.forEach((c, i) => history.push({ role: "tool", tool_call_id: c.id, content: results[i].text }));
            // A tool's message holds words only here; the pages it looked at follow
            const images = results.flatMap((r) => r.images ?? []);
            if (images.length) {
              history.push({ role: "user", content: [{ type: "text", text: "The page images the tools returned:" }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] });
            }
          }
        }
        controller.close();
      } catch {
        if (aborted.signal.aborted) return;
        text("Error: could not reach the custom API endpoint.");
        controller.close();
      }
    },
    cancel() {
      aborted.abort();
    },
  });
}
