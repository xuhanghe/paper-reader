// The events the ask routes stream to the browser, as far as the pages read
// them: Claude Code's stream-json, with Codex, OpenCode and the custom
// endpoints translated into the same shapes by lib/providers.
//
// Client-safe.
import { parseJsonLine } from "./ndjson";

export type AgentEventBlock = { type?: string; text?: string; name?: string; input?: unknown };

export type AgentEvent = {
  type?: string;
  // "system": the provider's session, to resume the conversation with
  session_id?: string;
  // "turn": what the model will cite this ask as
  turn?: number;
  // "content_block_delta": a piece of the answer
  delta?: { type?: string; text?: string };
  // "assistant": finished blocks — text, or a tool the agent called
  message?: { content?: AgentEventBlock[] };
  // "result": the whole answer, for a provider that sent no pieces
  result?: unknown;
  // "tool": a tool the agent used, as Codex and OpenCode report one
  name?: string;
  detail?: string;
  status?: string;
};

/** One line of the stream as an event, or null for a line that is not one. */
export function parseAgentEvent(line: string): AgentEvent | null {
  const value = parseJsonLine(line);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AgentEvent) : null;
}
