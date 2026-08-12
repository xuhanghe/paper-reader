// Which backend a model id runs on.
//
// This lives apart from lib/providers.ts because the client needs the same
// answer — it keys each paper's saved session ids by provider — and that module
// imports child_process, so it can't be pulled into the browser bundle. Keeping
// one implementation here stops the two copies drifting: a model routed to
// "opencode" on the server but keyed as "claude" on the client would resume the
// wrong conversation.

export type ProviderId = "claude" | "codex" | "custom" | "opencode";

export function providerIdFor(model: unknown): ProviderId {
  if (model === "codex") return "codex";
  if (model === "custom") return "custom";
  if (model === "opencode") return "opencode";
  return "claude";
}
