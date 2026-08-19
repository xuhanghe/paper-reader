import { spawn } from "child_process";
import { sanitizeSpawnArg } from "./model-flags";
import { codexMcpArgs } from "./mcp-config";
import { ensureServer } from "./opencode-server";
import { providerIdFor } from "./provider-id";
import { codexBin } from "./bin";

// Multi-provider backend. Every provider emits newline-delimited JSON with
// {type:"content_block_delta", delta:{type:"text_delta", text}} events — the
// same shape the client already parses from the claude CLI stream.

export type Provider = "claude" | "codex" | "custom" | "opencode";
export type CustomApiFormat = "openai" | "anthropic";
export type CustomConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  vision?: boolean;
  format: CustomApiFormat;
  maxTokens?: number;
};

const ANTHROPIC_VERSION = "2023-06-01";
// Anthropic rejects a request without max_tokens, so one is always sent
const DEFAULT_MAX_TOKENS = 8192;

export function resolveProvider(model: unknown): Provider {
  return providerIdFor(model);
}

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

const encoder = new TextEncoder();
const encodeEvent = (text: string) =>
  encoder.encode(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }) + "\n");

export function streamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

// ── Codex CLI ───────────────────────────────────────────────────────

function codexEffort(effort: unknown): string | null {
  if (typeof effort !== "string") return null;
  if (effort === "max") return "xhigh";
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : null;
}

function codexArgs(prompt: string, opts?: { images?: string[]; effort?: unknown; resumeId?: string }): string[] {
  const args = ["exec"];
  if (opts?.resumeId) args.push("resume", opts.resumeId);
  // Sessions are kept (no --ephemeral) so the per-paper conversation can resume
  args.push("--json", "--skip-git-repo-check", "-s", "read-only");
  args.push(...codexMcpArgs()); // Zotero library access
  const eff = codexEffort(opts?.effort);
  if (eff) args.push("-c", `model_reasoning_effort="${eff}"`);
  for (const img of opts?.images ?? []) args.push("-i", img);
  args.push(sanitizeSpawnArg(prompt));
  return args;
}

export function codexStream(
  prompt: string,
  opts?: { images?: string[]; effort?: unknown; resumeId?: string; onClose?: () => void }
): ReadableStream {
  let child: ReturnType<typeof spawn> | null = null;
  return new ReadableStream({
    start(controller) {
      const proc = spawn(codexBin(), codexArgs(prompt, opts));
      child = proc;
      proc.stdin.end();
      let buf = "";
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
        if (delta) controller.enqueue(encodeEvent(delta));
      };
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
              // Normalized session event — client captures it like claude's init
              controller.enqueue(
                encoder.encode(JSON.stringify({ type: "system", session_id: ev.thread_id }) + "\n")
              );
            } else if (ev.type === "item.updated" || ev.type === "item.completed") {
              emitAgentMessage(ev.item ?? {});
            }
          } catch {
            // non-JSON line
          }
        }
      });
      proc.stdout.on("end", () => { opts?.onClose?.(); controller.close(); });
      proc.stderr.on("data", (d: Buffer) => console.error("[codex stderr]", d.toString().slice(0, 400)));
      proc.on("error", (err) => {
        opts?.onClose?.();
        console.error("[codex spawn error]", err);
        controller.enqueue(encodeEvent("Error: could not run the codex CLI. Is it installed and logged in?"));
        controller.close();
      });
    },
    // Stopping an answer has to stop the model too; a child left running
    // finishes the reply nobody will read, on the reader's own machine
    cancel() {
      if (!child || child.killed) return;
      const proc = child;
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000).unref?.();
    },
  });
}

export async function codexComplete(prompt: string, effort?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(codexBin(), codexArgs(prompt, { effort }));
    proc.stdin.end();
    let out = "";
    const texts: string[] = [];
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr.on("data", (d: Buffer) => console.error("[codex stderr]", d.toString().slice(0, 400)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`codex exited with ${code}`));
      for (const line of out.split("\n")) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
            texts.push(ev.item.text);
          }
        } catch {
          // skip
        }
      }
      resolve(texts.join("\n"));
    });
  });
}

// ── opencode (headless HTTP server) ─────────────────────────────────

const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS) || 180000;
// Used only when neither OPENCODE_MODEL nor opencode's own config names one
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

function opencodeVariant(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  if (effort === "low") return "minimal";
  if (effort === "high" || effort === "xhigh") return "high";
  if (effort === "max") return "max";
  return undefined; // "medium" and anything unknown: let the provider decide
}

function opencodeTools(webSearch?: boolean): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const name of OPENCODE_DISABLED_TOOLS) tools[name] = false;
  for (const name of OPENCODE_SEARCH_TOOLS) tools[name] = webSearch === true;
  return tools;
}

async function opencodeModel(baseUrl: string): Promise<{ providerID: string; modelID: string }> {
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
  const id = raw || OPENCODE_FALLBACK_MODEL;
  const slash = id.indexOf("/");
  return slash > 0
    ? { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
    : { providerID: "opencode", modelID: id };
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
  model: { providerID: string; modelID: string },
  opts?: { images?: OpencodeImage[]; effort?: unknown; webSearch?: boolean }
) {
  const parts: unknown[] = (opts?.images ?? []).map((img) => ({
    type: "file",
    mime: img.mime,
    url: img.dataUrl,
    filename: "figure.png",
  }));
  parts.push({ type: "text", text: prompt });
  const variant = opencodeVariant(opts?.effort);
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
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop()!;
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              try {
                const ev = JSON.parse(t.slice(5));
                const p = ev?.properties ?? {};
                if (p.sessionID !== sessionId) continue;
                if (ev.type === "message.part.delta" && p.field === "text" && typeof p.delta === "string") {
                  streamed += p.delta;
                  controller.enqueue(encodeEvent(p.delta));
                }
              } catch {
                // partial or unrelated event
              }
            }
          }
        })();

        const model = await opencodeModel(baseUrl);
        const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messageBody(prompt, model, opts)),
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

export async function opencodeComplete(prompt: string, effort?: unknown): Promise<string> {
  const baseUrl = await ensureServer();
  const sessionId = await openSession(baseUrl, "paper-reader map");
  const model = await opencodeModel(baseUrl);
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageBody(prompt, model, { effort })),
    signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`opencode responded with ${res.status}`);
  return assistantText(await res.json());
}

// ── Custom API: OpenAI or Anthropic wire format ─────────────────────

type ChatMessage = { role: string; content: unknown };

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
    body: (stream) => JSON.stringify({ model: cfg.model, messages, stream }),
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
  return new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(wire.url, {
          method: "POST",
          headers: wire.headers,
          body: wire.body(true),
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok || !res.body) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          controller.enqueue(encodeEvent(`Error: custom API responded with ${res.status}. ${detail}`));
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const text = wire.deltaText(JSON.parse(payload));
              if (text) controller.enqueue(encodeEvent(text));
            } catch {
              // partial JSON — skip
            }
          }
        }
        controller.close();
      } catch {
        controller.enqueue(encodeEvent("Error: could not reach the custom API endpoint."));
        controller.close();
      }
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
