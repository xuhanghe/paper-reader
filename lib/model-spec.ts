// A model choice, as one string.
//
// One string fits every place a model was already kept — a paper's session,
// the Workspace's settings, a request body — so nothing else had to change
// shape, and values saved before providers had models keep their meaning:
//
//   claude:<model>                       a Claude Code model or alias: claude:opus, claude:default
//   claude-…                             (saved before) a full Claude model id
//   codex  |  codex:<model>              Codex with its default model, or a named one
//   opencode  |  opencode:<provider>/<model>
//   custom  |  custom:<endpoint>  |  custom:<endpoint>:<model>
//                                        a saved custom endpoint, with its default model or a named one
//
// Model names come from the backends themselves (see lib/model-catalog), so
// they are never listed here; this file only parses and checks them.
//
// Client-safe: no Node imports, so the browser keys sessions the same way the
// server routes them.

export type ProviderId = "claude" | "codex" | "opencode" | "custom";

export type ParsedModel = {
  provider: ProviderId;
  // The backend's own model id; absent means the backend's default
  model?: string;
  // custom only: which saved endpoint
  endpointId?: string;
};

// Every character a model id is known to use: Claude Code aliases with a
// context suffix ("sonnet[1m]"), Ollama tags ("llama3:8b"), OpenRouter and
// OpenCode paths ("anthropic/claude-…", "openai/gpt-…:free"). A value is only
// ever passed as one argv element, never through a shell; the leading
// character rule keeps it from being read as a CLI flag.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,159}$/;
const ENDPOINT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Effort names are the backend's own words: Claude's low…max, Codex's
// minimal/none/xhigh, OpenCode's variant names
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const isModelId = (value: unknown): value is string => typeof value === "string" && MODEL_ID.test(value);
export const isEndpointId = (value: unknown): value is string => typeof value === "string" && ENDPOINT_ID.test(value);
export const isEffortName = (value: unknown): value is string => typeof value === "string" && EFFORT_NAME.test(value);

const checked = (value: string): string | undefined => (isModelId(value) ? value : undefined);

export function parseModelSpec(value: unknown): ParsedModel {
  if (typeof value !== "string" || !value) return { provider: "claude" };
  const colon = value.indexOf(":");
  const head = colon < 0 ? value : value.slice(0, colon);
  const rest = colon < 0 ? "" : value.slice(colon + 1);
  switch (head) {
    case "claude":
      return { provider: "claude", model: rest && rest !== "default" ? checked(rest) : undefined };
    case "codex":
      return { provider: "codex", model: rest ? checked(rest) : undefined };
    case "opencode":
      return { provider: "opencode", model: rest ? checked(rest) : undefined };
    case "custom": {
      if (!rest) return { provider: "custom" };
      const split = rest.indexOf(":");
      const endpoint = split < 0 ? rest : rest.slice(0, split);
      const model = split < 0 ? "" : rest.slice(split + 1);
      return {
        provider: "custom",
        endpointId: isEndpointId(endpoint) ? endpoint : undefined,
        model: model ? checked(model) : undefined,
      };
    }
    default:
      // A full Claude model id, as sessions stored before this format existed
      return { provider: "claude", model: checked(value) };
  }
}

export function providerIdFor(value: unknown): ProviderId {
  return parseModelSpec(value).provider;
}

export function modelSpec(provider: ProviderId, model?: string, endpointId?: string): string {
  switch (provider) {
    case "claude":
      return `claude:${model || "default"}`;
    case "codex":
    case "opencode":
      return model ? `${provider}:${model}` : provider;
    case "custom":
      if (!endpointId) return "custom";
      return model ? `custom:${endpointId}:${model}` : `custom:${endpointId}`;
  }
}

/** The same choice, written the current way: "claude-sonnet-4-6" and "claude:claude-sonnet-4-6" are one model. */
export function normalizeModelSpec(value: unknown): string {
  const parsed = parseModelSpec(value);
  return modelSpec(parsed.provider, parsed.model, parsed.endpointId);
}
