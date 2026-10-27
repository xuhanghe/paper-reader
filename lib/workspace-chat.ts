// A workspace's conversation with its agent, and which agent it is.
//
// The conversation is the messages and, per provider, the session that
// provider keeps for it — so moving from Claude to Codex and back resumes each
// where it was left, as a paper's conversations do in the Reader.
//
// An answer belongs to the workspace it was asked in: it keeps streaming into
// that conversation while another workspace is on screen, and is there when
// you come back. So the conversation lives here, outside any component — in
// memory while it is shown or being answered, and in localStorage: written at
// once when nothing streams, and at most once a second while an answer does,
// rather than the whole conversation serialized again on every word.
//
// Client-only; on the server every read is empty.
import { normalizeModelSpec, type ProviderId } from "./model-spec";
import { parseAgentMode, type AgentMode } from "./workspace-modes";

export type AgentTool = { name: string; detail: string; status?: string };
export type AgentMessage = { id: string; role: "user" | "assistant"; content: string; tools?: AgentTool[]; imageDataUrl?: string };
export type ProviderSessions = Partial<Record<ProviderId, string>>;
export type WorkspaceChat = { messages: AgentMessage[]; sessions: ProviderSessions };
export type ChatSnapshot = { chat: WorkspaceChat; streaming: boolean };

const CHAT_KEY = "paper-reader:workspace-chat";
const AGENT_KEY = "paper-reader:workspace-agent:v1";
const MODE_KEY = "paper-reader:workspace-mode:v1";
const SAVE_EVERY_MS = 1000;
const PROVIDERS: readonly string[] = ["claude", "codex", "opencode", "custom"];

const EMPTY_SNAPSHOT: ChatSnapshot = { chat: { messages: [], sessions: {} }, streaming: false };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(storage()?.getItem(key) || "null");
  } catch {
    return null;
  }
}

// Saved before sessions were kept per provider: one id, from whichever
// provider made it. Its shape says which.
export function legacySessionProvider(id: string): ProviderId {
  if (id.startsWith("paper-reader-codex-v1:")) return "codex";
  if (id.startsWith("ses_")) return "opencode";
  return "claude";
}

const isMessage = (value: unknown): value is AgentMessage => {
  const m = value as AgentMessage | null;
  return !!m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
};

/** A stored conversation, whatever version wrote it. */
export function parseChat(raw: unknown): WorkspaceChat {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const messages = Array.isArray(value.messages) ? value.messages.filter(isMessage) : [];
  const sessions: ProviderSessions = {};
  if (value.sessions && typeof value.sessions === "object") {
    for (const [provider, id] of Object.entries(value.sessions as Record<string, unknown>)) {
      if (PROVIDERS.includes(provider) && typeof id === "string" && id) sessions[provider as ProviderId] = id;
    }
  } else if (typeof value.session === "string" && value.session) {
    sessions[legacySessionProvider(value.session)] = value.session;
  }
  return { messages, sessions };
}

type Entry = {
  snapshot: ChatSnapshot;
  listeners: Set<() => void>;
  // The answer being streamed, for Stop; null when none is
  controller: AbortController | null;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, Entry>();

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      snapshot: { chat: parseChat(readJson(`${CHAT_KEY}:${id}`)), streaming: false },
      listeners: new Set(),
      controller: null,
      dirty: false,
      timer: null,
    };
    entries.set(id, entry);
  }
  return entry;
}

function write(id: string, entry: Entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.dirty) return;
  entry.dirty = false;
  try {
    storage()?.setItem(`${CHAT_KEY}:${id}`, JSON.stringify(entry.snapshot.chat));
  } catch {
    // Storage full or unavailable: the conversation stays for this visit
  }
}

// Shown nowhere and not being answered: written out, and let go
function release(id: string, entry: Entry) {
  if (entry.listeners.size || entry.controller) return;
  write(id, entry);
  if (entries.get(id) === entry) entries.delete(id);
}

const emit = (entry: Entry) => entry.listeners.forEach((listener) => listener());

/** The conversation as it stands, the same object until it changes. */
export function chatSnapshot(id: string | null): ChatSnapshot {
  return id ? entryFor(id).snapshot : EMPTY_SNAPSHOT;
}

export function subscribeChat(id: string, listener: () => void): () => void {
  const entry = entryFor(id);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    release(id, entry);
  };
}

function apply(id: string, entry: Entry, update: (chat: WorkspaceChat) => WorkspaceChat) {
  const chat = update(entry.snapshot.chat);
  if (chat === entry.snapshot.chat) return;
  entry.snapshot = { ...entry.snapshot, chat };
  entry.dirty = true;
  if (!entry.controller) write(id, entry);
  else entry.timer ??= setTimeout(() => write(id, entry), SAVE_EVERY_MS);
  emit(entry);
  release(id, entry);
}

/** Changes a conversation that is not being answered. */
export function updateChat(id: string, update: (chat: WorkspaceChat) => WorkspaceChat) {
  apply(id, entryFor(id), update);
}

/**
 * Starts an answer in a workspace: the controller to stop it with, or null
 * while another answer there is still streaming.
 */
export function beginRun(id: string): AbortController | null {
  const entry = entryFor(id);
  if (entry.controller) return null;
  const controller = new AbortController();
  entry.controller = controller;
  entry.snapshot = { ...entry.snapshot, streaming: true };
  emit(entry);
  return controller;
}

/**
 * Changes the conversation for the answer `controller` started — and only
 * while that answer is still the live one, so nothing lands in a workspace
 * removed, or an answer stopped, in the meantime.
 */
export function updateRun(id: string, controller: AbortController, update: (chat: WorkspaceChat) => WorkspaceChat) {
  const entry = entries.get(id);
  if (!entry || entry.controller !== controller || controller.signal.aborted) return;
  apply(id, entry, update);
}

export function endRun(id: string, controller: AbortController) {
  const entry = entries.get(id);
  if (!entry || entry.controller !== controller) return;
  entry.controller = null;
  entry.snapshot = { ...entry.snapshot, streaming: false };
  write(id, entry);
  emit(entry);
  release(id, entry);
}

export function stopRun(id: string) {
  entries.get(id)?.controller?.abort();
}

/** A workspace removed: its answer stopped, its conversation and agent forgotten. */
export function forgetChat(id: string) {
  const entry = entries.get(id);
  if (entry) {
    entry.controller?.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(id);
  }
  try {
    storage()?.removeItem(`${CHAT_KEY}:${id}`);
    storage()?.removeItem(`${AGENT_KEY}:${id}`);
    storage()?.removeItem(`${MODE_KEY}:${id}`);
  } catch {
    // nothing to clean up then
  }
}

// Leaving the page mid-answer keeps what has arrived
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => entries.forEach((entry, id) => write(id, entry)));
}

// ── Which agent ───────────────────────────────────────────────────────

export type AgentChoice = { model: string; effort?: string };
export const DEFAULT_AGENT: AgentChoice = { model: "claude:sonnet", effort: "high" };

function readChoice(key: string): AgentChoice | null {
  const value = readJson(key) as { model?: unknown; effort?: unknown } | null;
  if (!value || typeof value.model !== "string") return null;
  return { model: normalizeModelSpec(value.model), effort: typeof value.effort === "string" ? value.effort : undefined };
}

/** The agent a workspace was last asked with; a new workspace starts on the one chosen most recently anywhere. */
export function loadAgentChoice(workspaceId: string | null): AgentChoice {
  return (workspaceId ? readChoice(`${AGENT_KEY}:${workspaceId}`) : null) ?? readChoice(AGENT_KEY) ?? DEFAULT_AGENT;
}

export function saveAgentChoice(workspaceId: string, choice: AgentChoice) {
  const text = JSON.stringify(choice);
  try {
    storage()?.setItem(`${AGENT_KEY}:${workspaceId}`, text);
    storage()?.setItem(AGENT_KEY, text);
  } catch {
    // the choice holds for this visit
  }
}

// How the agent is run in each workspace: a discussion, or implementing
export function loadAgentMode(workspaceId: string | null): AgentMode {
  return parseAgentMode(workspaceId ? readJson(`${MODE_KEY}:${workspaceId}`) : null);
}

export function saveAgentMode(workspaceId: string, mode: AgentMode) {
  try {
    storage()?.setItem(`${MODE_KEY}:${workspaceId}`, JSON.stringify(mode));
  } catch {
    // the mode holds for this visit
  }
}
