// Which models each backend offers, and which effort levels each model takes —
// asked of the backend itself rather than written into the app.
//
// A list kept here goes stale the week a provider ships a model, and it cannot
// know what a given account may use: a Claude plan without Opus, a Codex login
// through ChatGPT rather than an API key, an OpenCode set up with three
// providers. So each backend is asked, the way its own clients ask it:
//
//   Claude Code   the `initialize` control request of its SDK protocol — the
//                 answer lists the account's models with the effort levels each
//                 accepts (Haiku 4.5 takes none, newer models take low…max)
//   Codex         `model/list` on `codex app-server`, the protocol its IDE
//                 extensions use: models with their reasoning efforts and default
//   OpenCode      GET /config/providers on its headless server: every connected
//                 provider's models, with each model's variants
//   Custom        GET /models (OpenAI format) or /v1/models (Anthropic format)
//
// Answers are cached for a while — a probe starts a process — and a failure is
// reported as such, never replaced by a guess.

import { spawn } from "node:child_process";
import { claudeBin, codexBin } from "./bin";
import { prepareCodexEnvironment } from "./codex-runtime";
import { codexUpdateStatus, keepCodexCurrent, parseVersion, type CodexUpdate } from "./codex-update";
import { detectCli, type CliId } from "./doctor";
import { listEndpoints, summarizeEndpoint, type CustomEndpoint, type EndpointSummary } from "./endpoints";
import { EFFORT_LEVELS } from "./model-flags";
import { isEffortName, isModelId, modelSpec, parseModelSpec, type ProviderId } from "./model-spec";
import { createLineSplitter, parseJsonLine } from "./ndjson";
import { ensureServer } from "./opencode-server";

export type CatalogModel = {
  // The value a choice is stored and sent as (see lib/model-spec)
  spec: string;
  // The backend's own id
  id: string;
  label: string;
  description?: string;
  // Effort levels the model accepts, in the backend's own words; empty when it takes none
  efforts: string[];
  defaultEffort?: string;
  // The backend's own default model
  isDefault?: boolean;
  // Accepts images, when the backend says
  vision?: boolean;
};

export type CatalogGroup = {
  // "claude" | "codex" | "opencode" | "custom:<endpoint id>"
  key: string;
  provider: ProviderId;
  label: string;
  status: "ready" | "missing" | "error";
  // Why it is not ready, in words the picker can show
  detail?: string;
  // For a provider that isn't installed
  install?: string;
  // The CLI's version, for a provider that is
  version?: string;
  // Codex being brought up to date, or out of date (lib/codex-update)
  update?: CodexUpdate;
  models: CatalogModel[];
  endpoint?: EndpointSummary;
  fetchedAt: number;
};

const CLAUDE_EFFORTS: readonly string[] = EFFORT_LEVELS;
const PROBE_TIMEOUT_MS = 25_000;
const CLIENT_INFO = { name: "paper_reader", title: "Paper Reader", version: process.env.npm_package_version || "0.1.0" };

const text = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const unique = (values: string[]) => [...new Set(values)];

// ── Parsers: a backend's answer → catalog models ─────────────────────────

/** The `models` of Claude Code's initialize response (ModelInfo[]). */
export function parseClaudeModels(models: unknown): CatalogModel[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((raw): CatalogModel[] => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const value = typeof m.value === "string" ? m.value : "";
    if (!isModelId(value)) return [];
    const efforts = m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
      ? unique(m.supportedEffortLevels.filter((e): e is string => typeof e === "string" && CLAUDE_EFFORTS.includes(e)))
      : [];
    return [{
      spec: modelSpec("claude", value === "default" ? undefined : value),
      id: value,
      label: text(m.displayName, 80) ?? value,
      description: text(m.description),
      efforts,
      isDefault: value === "default",
    }];
  });
}

/** Every page of `model/list` results from codex app-server (Model[]). */
export function parseCodexModels(models: unknown): CatalogModel[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.flatMap((raw): CatalogModel[] => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (m.hidden === true) return [];
    const id = typeof m.model === "string" && m.model ? m.model : typeof m.id === "string" ? m.id : "";
    if (!isModelId(id) || seen.has(id)) return [];
    seen.add(id);
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? unique(m.supportedReasoningEfforts
          .map((e) => (typeof e === "string" ? e : (e as { reasoningEffort?: unknown; effort?: unknown })?.reasoningEffort ?? (e as { effort?: unknown })?.effort))
          .filter(isEffortName))
      : [];
    const modalities = Array.isArray(m.inputModalities) ? m.inputModalities : null;
    return [{
      spec: modelSpec("codex", id),
      id,
      label: text(m.displayName, 80) ?? id,
      description: text(m.description),
      efforts,
      defaultEffort: isEffortName(m.defaultReasoningEffort) && efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : undefined,
      isDefault: m.isDefault === true,
      ...(modalities ? { vision: modalities.includes("image") } : {}),
    }];
  });
}

type OpencodeModel = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  variants?: unknown;
  attachment?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown };
  capabilities?: { attachment?: unknown; input?: unknown };
};

/**
 * GET /config/providers ({ providers, default }), or GET /provider
 * ({ all, default, connected }) — OpenCode has shipped both, and a model's
 * capabilities have lived both on it and under `capabilities`.
 */
export function parseOpencodeProviders(body: unknown): CatalogModel[] {
  const b = (body ?? {}) as { providers?: unknown; all?: unknown; connected?: unknown; default?: unknown };
  const connected = Array.isArray(b.connected) ? new Set(b.connected.filter((c): c is string => typeof c === "string")) : null;
  const providers = (Array.isArray(b.providers) ? b.providers : Array.isArray(b.all) ? b.all : []) as Record<string, unknown>[];
  const defaults = (b.default && typeof b.default === "object" ? b.default : {}) as Record<string, unknown>;
  return providers.flatMap((provider): CatalogModel[] => {
    const providerId = typeof provider?.id === "string" ? provider.id : "";
    if (!providerId || (connected && !connected.has(providerId))) return [];
    const providerName = text(provider.name, 60) ?? providerId;
    const models = provider.models;
    const entries: [string, OpencodeModel][] = Array.isArray(models)
      ? models.map((m) => [String((m as OpencodeModel)?.id ?? ""), m as OpencodeModel])
      : models && typeof models === "object"
        ? Object.entries(models as Record<string, OpencodeModel>)
        : [];
    return entries.flatMap(([key, m]): CatalogModel[] => {
      const modelId = typeof m?.id === "string" && m.id ? m.id : key;
      const id = `${providerId}/${modelId}`;
      if (!isModelId(id)) return [];
      const variants = Array.isArray(m.variants)
        ? m.variants.map((v) => (typeof v === "string" ? v : (v as { id?: unknown; name?: unknown })?.id ?? (v as { name?: unknown })?.name))
        : m.variants && typeof m.variants === "object" ? Object.keys(m.variants) : [];
      const inputs = m.modalities?.input ?? m.capabilities?.input;
      const vision = m.attachment === true || m.capabilities?.attachment === true || (Array.isArray(inputs) && inputs.includes("image"));
      return [{
        spec: modelSpec("opencode", id),
        id,
        label: text(m.name, 80) ?? modelId,
        description: providerName,
        efforts: unique(variants.filter(isEffortName)),
        isDefault: defaults[providerId] === modelId,
        vision,
      }];
    });
  });
}

// Chat endpoints list everything they serve: embeddings, speech, images too
const NOT_A_CHAT_MODEL = /(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|davinci|babbage|search-api)([-_.:]|$)/i;

/** GET /models (OpenAI, OpenRouter, Ollama, LM Studio, …) or GET /v1/models (Anthropic). */
export function parseEndpointModels(body: unknown, endpoint: Pick<CustomEndpoint, "id" | "vision">): CatalogModel[] {
  const b = (body ?? {}) as { data?: unknown; models?: unknown };
  const list = (Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : Array.isArray(body) ? body : []) as Record<string, unknown>[];
  const dated = list.length > 0 && list.every((m) => typeof m?.created === "number");
  const ordered = dated ? [...list].sort((a, z) => (z.created as number) - (a.created as number)) : list;
  const seen = new Set<string>();
  return ordered.flatMap((m): CatalogModel[] => {
    const id = typeof m?.id === "string" ? m.id : typeof m?.name === "string" ? m.name : "";
    if (!isModelId(id) || seen.has(id) || NOT_A_CHAT_MODEL.test(id)) return [];
    seen.add(id);
    const arch = (m.architecture ?? {}) as { input_modalities?: unknown; modality?: unknown };
    const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : null;
    const vision = inputs ? inputs.includes("image") : typeof arch.modality === "string" ? /image/.test(arch.modality.split("->")[0]) : endpoint.vision;
    // OpenRouter says which models take its normalized reasoning effort
    const reasoning = Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning");
    return [{
      spec: modelSpec("custom", id, endpoint.id),
      id,
      label: text(m.display_name, 80) ?? text(m.name, 80) ?? id,
      description: text(m.description, 140),
      efforts: reasoning ? ["low", "medium", "high"] : [],
      vision,
    }];
  });
}

// ── Probes: ask a backend ────────────────────────────────────────────────

const lastLine = (output: string) => output.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";

/** Claude Code's models, from the initialize request of its SDK protocol. Nothing is sent to a model. */
export function probeClaudeModels(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = "paper-reader-models";
    const proc = spawn(claudeBin(), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
    let stderr = "";
    let settled = false;
    const settle = (error: Error | null, models?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => settle(new Error("Claude Code did not list its models in time.")), PROBE_TIMEOUT_MS);
    const lines = createLineSplitter((line) => {
      const event = parseJsonLine(line) as { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: unknown }; error?: unknown } } | undefined;
      if (event?.type !== "control_response" || event.response?.request_id !== requestId) return;
      if (event.response.subtype === "success") settle(null, event.response.response?.models ?? []);
      else settle(new Error(text(event.response.error) ?? "Claude Code refused to list its models."));
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => lines.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (error) => settle(error));
    proc.on("close", (code) => settle(new Error(lastLine(stderr) || `Claude Code exited (${code}) before listing its models.`)));
    proc.stdin.on("error", () => {});
    proc.stdin.end(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n");
  });
}

/** Codex's models, from `model/list` on its app-server, every page of it. */
export function probeCodexModels(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(codexBin(), ["app-server"], { env: prepareCodexEnvironment() });
    const models: unknown[] = [];
    let nextId = 1;
    let pages = 0;
    let stderr = "";
    let settled = false;
    const send = (message: object) => proc.stdin.write(JSON.stringify(message) + "\n");
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdin.end();
      proc.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => settle(new Error("Codex did not list its models in time.")), PROBE_TIMEOUT_MS);
    const listPage = (cursor?: string) => send({ method: "model/list", id: ++nextId, params: { includeHidden: false, ...(cursor ? { cursor } : {}) } });
    const lines = createLineSplitter((line) => {
      const message = parseJsonLine(line) as { id?: unknown; result?: { data?: unknown; nextCursor?: unknown }; error?: { message?: unknown } } | undefined;
      // Notifications and the server's own requests carry no id of ours
      if (typeof message?.id !== "number") return;
      if (message.error) return settle(new Error(text(message.error.message) ?? "Codex refused to list its models."));
      if (message.id === 1) {
        send({ method: "initialized" });
        return listPage();
      }
      if (Array.isArray(message.result?.data)) models.push(...message.result.data);
      const cursor = message.result?.nextCursor;
      if (typeof cursor === "string" && cursor && ++pages < 10) listPage(cursor);
      else settle(null);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => lines.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (error) => settle(error));
    proc.on("close", (code) => settle(new Error(lastLine(stderr) || `Codex exited (${code}) before listing its models.`)));
    proc.stdin.on("error", () => {});
    send({ method: "initialize", id: 1, params: { clientInfo: CLIENT_INFO, capabilities: null } });
  });
}

export async function probeOpencodeModels(): Promise<unknown> {
  const baseUrl = await ensureServer();
  const res = await fetch(`${baseUrl}/config/providers`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenCode answered ${res.status} when asked for its models.`);
  return res.json();
}

export function endpointModelsRequest(endpoint: Pick<CustomEndpoint, "baseUrl" | "apiKey" | "format">): { url: string; headers: Record<string, string> } {
  if (endpoint.format === "anthropic") {
    const base = /\/v1$/.test(endpoint.baseUrl) ? endpoint.baseUrl : `${endpoint.baseUrl}/v1`;
    return {
      url: `${base}/models?limit=1000`,
      headers: { "anthropic-version": "2023-06-01", ...(endpoint.apiKey ? { "x-api-key": endpoint.apiKey } : {}) },
    };
  }
  return { url: `${endpoint.baseUrl}/models`, headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {} };
}

export async function probeEndpointModels(endpoint: Pick<CustomEndpoint, "baseUrl" | "apiKey" | "format">): Promise<unknown> {
  const { url, headers } = endpointModelsRequest(endpoint);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw Object.assign(new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`.trim()), { status: res.status });
  }
  return res.json();
}

// ── Groups, cached ───────────────────────────────────────────────────────

const PROVIDERS: { id: Exclude<ProviderId, "custom">; label: string; cli: CliId }[] = [
  { id: "claude", label: "Claude Code", cli: "claude" },
  { id: "codex", label: "Codex", cli: "codex" },
  { id: "opencode", label: "OpenCode", cli: "opencode" },
];

const READY_TTL_MS = 10 * 60_000;
const OTHER_TTL_MS = 30_000;

type Holder = { groups: Map<string, CatalogGroup>; running: Map<string, Promise<CatalogGroup>> };
const holder: Holder = ((globalThis as { __paperReaderCatalog?: Holder }).__paperReaderCatalog ??= {
  groups: new Map(),
  running: new Map(),
});

const fresh = (group: CatalogGroup | undefined) =>
  !!group && Date.now() - group.fetchedAt < (group.status === "ready" ? READY_TTL_MS : OTHER_TTL_MS);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

// A finished Codex update is asked for its models the next time anyone looks
const forgetCodex = () => forgetCatalogGroup("codex");

/** `asked`: someone pressed refresh, so Codex is also checked for a newer release afresh. */
async function buildProviderGroup(provider: (typeof PROVIDERS)[number], asked = false): Promise<CatalogGroup> {
  const base = { key: provider.id, provider: provider.id, label: provider.label, models: [] as CatalogModel[], fetchedAt: Date.now() };
  const cli = await detectCli(provider.cli);
  if (!cli.found) return { ...base, status: "missing", detail: "Not installed on this computer.", install: cli.install };
  if (cli.source === "probed") return { ...base, status: "error", detail: cli.note ?? "Installed, but not on the server's PATH." };
  const found = { ...base, version: parseVersion(cli.version) };
  try {
    const models =
      provider.id === "claude" ? parseClaudeModels(await probeClaudeModels())
      // Asked alongside, so this very answer already says whether it is updating
      : provider.id === "codex" ? parseCodexModels((await Promise.all([probeCodexModels(), keepCodexCurrent(cli, forgetCodex, asked)]))[0])
      : parseOpencodeProviders(await probeOpencodeModels());
    if (!models.length) return { ...found, status: "error", detail: "It answered, but listed no models. Is it signed in?" };
    return { ...found, status: "ready", models, fetchedAt: Date.now() };
  } catch (error) {
    return { ...found, status: "error", detail: reason(error), fetchedAt: Date.now() };
  }
}

async function buildEndpointGroup(endpoint: CustomEndpoint): Promise<CatalogGroup> {
  const base = {
    key: `custom:${endpoint.id}`,
    provider: "custom" as const,
    label: endpoint.name,
    endpoint: summarizeEndpoint(endpoint),
    fetchedAt: Date.now(),
  };
  // The saved default model is always offered, even when the list can't be read
  const saved: CatalogModel = { spec: modelSpec("custom", endpoint.defaultModel, endpoint.id), id: endpoint.defaultModel, label: endpoint.defaultModel, efforts: [], isDefault: true, vision: endpoint.vision };
  try {
    const listed = parseEndpointModels(await probeEndpointModels(endpoint), endpoint);
    const models = listed.some((m) => m.id === endpoint.defaultModel)
      ? listed.map((m) => (m.id === endpoint.defaultModel ? { ...m, isDefault: true } : m))
      : [saved, ...listed];
    return { ...base, status: "ready", models };
  } catch (error) {
    return { ...base, status: "error", detail: `Could not list its models: ${reason(error)}`, models: [saved] };
  }
}

function cachedRun(key: string, build: () => Promise<CatalogGroup>, refresh: boolean): Promise<CatalogGroup> {
  const cached = holder.groups.get(key);
  if (!refresh && fresh(cached)) return Promise.resolve(cached!);
  const running = holder.running.get(key);
  if (running) return running;
  const run = build()
    .then((group) => {
      holder.groups.set(key, group);
      return group;
    })
    .finally(() => holder.running.delete(key));
  holder.running.set(key, run);
  return run;
}

// Read when the catalog is, not kept with the group: an update outlives the answer it started with
const withUpdate = (group: CatalogGroup): CatalogGroup => {
  const update = group.key === "codex" ? codexUpdateStatus() : undefined;
  return update ? { ...group, update } : group;
};

/** Every provider and saved endpoint with its models. `refresh` re-asks all, or the one group named. */
export async function getCatalog(refresh: boolean | string = false): Promise<CatalogGroup[]> {
  const endpoints = await listEndpoints();
  const live = new Set(["claude", "codex", "opencode", ...endpoints.map((e) => `custom:${e.id}`)]);
  for (const key of holder.groups.keys()) if (!live.has(key)) holder.groups.delete(key);
  return Promise.all([
    ...PROVIDERS.map((p) => {
      const asked = refresh === true || refresh === p.id;
      return cachedRun(p.id, () => buildProviderGroup(p, asked), asked).then(withUpdate);
    }),
    ...endpoints.map((e) => {
      const key = `custom:${e.id}`;
      // An edited endpoint is listed again: its URL or key may have changed
      const stale = (holder.groups.get(key)?.endpoint?.updatedAt ?? 0) !== e.updatedAt;
      return cachedRun(key, () => buildEndpointGroup(e), refresh === true || refresh === key || stale);
    }),
  ]);
}

/** Forgets a group, so the next catalog asks again (after an endpoint is edited or removed). */
export function forgetCatalogGroup(key: string) {
  holder.groups.delete(key);
}

/** What the catalog last said about a model, if it has been asked. Never starts a probe. */
export function knownModel(spec: unknown): CatalogModel | undefined {
  const parsed = parseModelSpec(spec);
  const key = parsed.provider === "custom" ? `custom:${parsed.endpointId ?? ""}` : parsed.provider;
  const group = holder.groups.get(key);
  if (!group || group.status !== "ready") return undefined;
  const id = parsed.provider === "claude" ? parsed.model ?? "default" : parsed.model;
  return id ? group.models.find((m) => m.id === id) : group.models.find((m) => m.isDefault);
}

/** Asks for a provider's models in the background, so effort checks have them next time. */
export function warmCatalog(spec: unknown) {
  const parsed = parseModelSpec(spec);
  if (parsed.provider === "custom") return;
  const provider = PROVIDERS.find((p) => p.id === parsed.provider);
  if (provider && !fresh(holder.groups.get(provider.id))) void cachedRun(provider.id, () => buildProviderGroup(provider), false).catch(() => {});
}

// What sessions saved before efforts came from the backends mean to OpenCode
const LEGACY_OPENCODE_VARIANT: Record<string, string | undefined> = { low: "minimal", medium: undefined, high: "high", xhigh: "high", max: "max" };

/**
 * The effort to actually send: the one asked for when the model takes it, and
 * nothing when it doesn't — a CLI given an effort its model rejects fails the
 * whole question. Uses what the catalog has learnt; with nothing learnt yet it
 * passes on what is plausibly valid.
 */
export function effortFor(spec: unknown, effort: unknown): string | undefined {
  if (!isEffortName(effort)) return undefined;
  const provider = parseModelSpec(spec).provider;
  const known = knownModel(spec);
  if (!known) warmCatalog(spec);
  switch (provider) {
    case "claude":
      if (!CLAUDE_EFFORTS.includes(effort)) return undefined;
      return !known || known.efforts.includes(effort) ? effort : undefined;
    case "codex": {
      const asked = effort === "max" ? "xhigh" : effort; // saved before Codex said its own levels
      if (!known) return asked;
      return known.efforts.includes(asked) ? asked : known.defaultEffort;
    }
    case "opencode":
      if (known) return known.efforts.includes(effort) ? effort : undefined;
      return effort in LEGACY_OPENCODE_VARIANT ? LEGACY_OPENCODE_VARIANT[effort] : effort;
    case "custom":
      return known?.efforts.includes(effort) ? effort : undefined;
  }
}
