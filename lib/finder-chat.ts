// The agent search, as a conversation: "not this one, the one about SM5"
// refines the last answer instead of starting over. Kept here, outside any
// component, so it survives moving between the Reader and the Workspace;
// kept nowhere else, so closing it forgets it. Each message is its own
// one-shot, read-only agent run (lib/search-agent), sent the conversation so
// far. Client-only.
import { readLines } from "@/lib/ndjson";
import { workspacesForSearch, type Locator } from "@/lib/search-nav";

export type FoundItem = { id: string; kind: Locator["kind"]; title: string; where: string; why?: string; locator: Locator };
export type FinderTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "agent"; status: "running" | "done" | "error"; activity: string[]; reply?: string; results: FoundItem[]; error?: string };
export type FinderState = { open: boolean; turns: FinderTurn[]; running: boolean };

const CLOSED: FinderState = { open: false, turns: [], running: false };
let state: FinderState = CLOSED;
let controller: AbortController | null = null;
let counter = 0;
const listeners = new Set<() => void>();

const set = (next: FinderState) => {
  state = next;
  listeners.forEach((l) => l());
};
const updateTurn = (id: string, change: (turn: Extract<FinderTurn, { role: "agent" }>) => Extract<FinderTurn, { role: "agent" }>) =>
  set({ ...state, turns: state.turns.map((t) => (t.id === id && t.role === "agent" ? change(t) : t)) });

export const finderSnapshot = () => state;
export const closedSnapshot = () => CLOSED;
export function subscribeFinder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// What the next run is told of this conversation: each thing said, and what
// was found for it, by id and title
function historyFor(turns: FinderTurn[]) {
  return turns.slice(-12).map((t) =>
    t.role === "user"
      ? { role: "user" as const, text: t.text }
      : { role: "agent" as const, text: t.reply ?? t.error ?? "", found: t.results.map((r) => ({ id: r.id, title: r.title })) }
  );
}

export async function sendToFinder(text: string, reading?: { id: string; title: string }): Promise<void> {
  const message = text.trim();
  if (!message || state.running) return;
  const history = historyFor(state.turns);
  const agentId = `a${++counter}`;
  set({
    open: true,
    running: true,
    turns: [...state.turns, { id: `u${++counter}`, role: "user", text: message }, { id: agentId, role: "agent", status: "running", activity: [], results: [] }],
  });
  const mine = new AbortController();
  controller = mine;
  try {
    const res = await fetch("/api/search/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: message, history, paperId: reading?.id, workspaces: workspacesForSearch() }),
      signal: mine.signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.text()) || "The search did not start.");
    let finished = false;
    await readLines(res.body, (line) => {
      let event: { type?: string; text?: string; reply?: string; results?: FoundItem[]; message?: string };
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "activity" && event.text) {
        updateTurn(agentId, (t) => ({ ...t, activity: [...t.activity, event.text!].slice(-6) }));
      } else if (event.type === "results") {
        finished = true;
        updateTurn(agentId, (t) => ({ ...t, status: "done", reply: event.reply, results: event.results ?? [] }));
      } else if (event.type === "error") {
        finished = true;
        updateTurn(agentId, (t) => ({ ...t, status: "error", error: event.message || "The search failed." }));
      }
    });
    if (!finished) updateTurn(agentId, (t) => ({ ...t, status: "error", error: "The search ended without an answer." }));
  } catch (error) {
    // Closed, or stopped: a closed finder has nothing left to update
    if (mine.signal.aborted) {
      if (state.open) updateTurn(agentId, (t) => (t.status === "running" ? { ...t, status: "error", error: "Stopped." } : t));
    } else {
      updateTurn(agentId, (t) => ({ ...t, status: "error", error: error instanceof Error ? error.message : "The search failed." }));
    }
  } finally {
    if (controller === mine) controller = null;
    if (state.open) set({ ...state, running: false });
  }
}

/** Opens the finder; with a first message, asks it at once. */
export function openFinder(first?: string, reading?: { id: string; title: string }): void {
  if (!state.open) set({ ...state, open: true });
  if (first?.trim() && !state.running) void sendToFinder(first, reading);
}

export function stopFinder(): void {
  controller?.abort();
}

/** Closes the finder, and everything said in it is gone. */
export function closeFinder(): void {
  controller?.abort();
  controller = null;
  set(CLOSED);
}
