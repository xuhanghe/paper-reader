// Custom API endpoints: any OpenAI-compatible or Anthropic-format service the
// reader adds by hand — OpenRouter, a local Ollama, a company proxy.
//
// They are kept on the server, in the data folder next to .env.local, rather
// than in the browser: the keys never sit in localStorage or travel with every
// question, the Reader and the Workspace see the same list, and the desktop
// app keeps them when it starts on a different port (localStorage is per
// origin, and so per port). The file holds API keys, so it is written owner-
// only, and it is listed in .gitignore for checkouts that use the repo as the
// data folder.

import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homePath } from "./home";
import { isEndpointId, isModelId } from "./model-spec";

export type EndpointFormat = "openai" | "anthropic";

export type CustomEndpoint = {
  id: string;
  name: string;
  format: EndpointFormat;
  baseUrl: string;
  apiKey: string;
  // Used when a question names the endpoint but no model
  defaultModel: string;
  // Whether to send figures and page images when the endpoint's model list
  // doesn't say what each model accepts
  vision: boolean;
  maxTokens?: number;
  // Which preset it was made from, for the dialog; never used for routing
  preset?: string;
  updatedAt: number;
};

/** What the browser may see: everything but the key. */
export type EndpointSummary = Omit<CustomEndpoint, "apiKey"> & { hasKey: boolean; keyHint: string };

export type EndpointInput = {
  id?: unknown;
  name?: unknown;
  format?: unknown;
  baseUrl?: unknown;
  // undefined keeps the saved key; "" removes it
  apiKey?: unknown;
  defaultModel?: unknown;
  vision?: unknown;
  maxTokens?: unknown;
  preset?: unknown;
};

const endpointsFile = () => homePath(".paper-reader-endpoints.json");

export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** Checks an edit against what is saved. Pure, so the rules can be tested without a file. */
export function validateEndpointInput(
  input: EndpointInput,
  existing: CustomEndpoint | null,
  now = Date.now(),
  newId = () => `ep_${randomBytes(5).toString("hex")}`
): { endpoint: CustomEndpoint } | { error: string } {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl);
  if (!baseUrl) return { error: "Enter the endpoint's base URL, starting with http:// or https://." };
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : existing?.defaultModel ?? "";
  if (!isModelId(defaultModel)) return { error: "Choose a model, or type its id exactly as the endpoint names it." };
  const format: EndpointFormat = (input.format ?? existing?.format) === "anthropic" ? "anthropic" : "openai";
  const name = (typeof input.name === "string" ? input.name.trim() : "") || existing?.name || new URL(baseUrl).host;
  const apiKey = input.apiKey === undefined ? existing?.apiKey ?? "" : typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const maxTokens = Number(input.maxTokens);
  return {
    endpoint: {
      id: existing?.id ?? newId(),
      name: name.slice(0, 60),
      format,
      baseUrl,
      apiKey,
      defaultModel,
      vision: input.vision === undefined ? existing?.vision ?? false : input.vision === true,
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      ...(typeof input.preset === "string" && /^[a-z0-9-]{1,32}$/.test(input.preset) ? { preset: input.preset } : existing?.preset ? { preset: existing.preset } : {}),
      updatedAt: now,
    },
  };
}

function readEndpoint(value: unknown): CustomEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isEndpointId(v.id)) return null;
  const result = validateEndpointInput(v, null, typeof v.updatedAt === "number" ? v.updatedAt : 0, () => v.id as string);
  return "endpoint" in result ? result.endpoint : null;
}

export async function listEndpoints(): Promise<CustomEndpoint[]> {
  try {
    const data = JSON.parse(await readFile(endpointsFile(), "utf8"));
    const list = Array.isArray(data?.endpoints) ? data.endpoints : [];
    return list.map(readEndpoint).filter((e: CustomEndpoint | null): e is CustomEndpoint => e !== null);
  } catch {
    return [];
  }
}

export async function getEndpoint(id: unknown): Promise<CustomEndpoint | null> {
  if (!isEndpointId(id)) return null;
  return (await listEndpoints()).find((e) => e.id === id) ?? null;
}

// One write at a time, so two saves in quick succession never interleave
let queue: Promise<unknown> = Promise.resolve();
const serially = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};

async function writeAll(endpoints: CustomEndpoint[]): Promise<void> {
  const file = endpointsFile();
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, endpoints }, null, 2), { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  // Rename is atomic: a reader sees the old list or the new one, never half
  await rename(temp, file);
}

export function saveEndpoint(input: EndpointInput): Promise<CustomEndpoint> {
  return serially(async () => {
    const all = await listEndpoints();
    let existing = isEndpointId(input.id) ? all.find((e) => e.id === input.id) ?? null : null;
    if (!existing && input.id !== undefined) throw new Error("That endpoint no longer exists.");
    // The same service added twice (a settings migration run in two tabs, a
    // double click) updates the one already there instead of duplicating it
    if (!existing) {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const model = String(input.defaultModel ?? "").trim();
      const name = typeof input.name === "string" ? input.name.trim() : "";
      existing = all.find((e) => e.baseUrl === baseUrl && e.defaultModel === model && (!name || e.name === name)) ?? null;
    }
    const result = validateEndpointInput(input, existing);
    if ("error" in result) throw new Error(result.error);
    const next = existing ? all.map((e) => (e.id === existing!.id ? result.endpoint : e)) : [...all, result.endpoint];
    await writeAll(next);
    return result.endpoint;
  });
}

export function deleteEndpoint(id: unknown): Promise<boolean> {
  return serially(async () => {
    const all = await listEndpoints();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  });
}

export function summarizeEndpoint(endpoint: CustomEndpoint): EndpointSummary {
  const { apiKey, ...rest } = endpoint;
  const keyHint = !apiKey ? "" : apiKey.length > 10 ? `…${apiKey.slice(-4)}` : "saved";
  return { ...rest, hasKey: !!apiKey, keyHint };
}
