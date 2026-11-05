// Going to a search result: on this surface, or across to the other one.
//
// A result on the surface already open is announced as an event the page
// acts on. One on the other surface is left in sessionStorage and the app
// moves there; that page takes it once it has finished opening what it opens
// at launch, so the two never race for the same paper. Client-only.
import type { Locator } from "@/lib/search-index";
import { parseChat } from "@/lib/workspace-chat";

export type Surface = "reader" | "workspace";
export type { Locator };

const PENDING = "paper-reader:pending-jump";
const EVENT = "paper-reader:jump";
// A jump left behind and never taken (the tab closed mid-way) is not taken
// on some later visit
const PENDING_MAX_AGE_MS = 60_000;

export const surfaceOf = (loc: Locator): Surface =>
  loc.kind === "workspace-chat" || loc.kind === "workspace-file" ? "workspace" : "reader";

export function goToResult(loc: Locator, here: Surface, navigate: (href: string) => void): void {
  if (surfaceOf(loc) === here) {
    window.dispatchEvent(new CustomEvent<Locator>(EVENT, { detail: loc }));
    return;
  }
  try {
    sessionStorage.setItem(PENDING, JSON.stringify({ loc, at: Date.now() }));
  } catch {
    // without storage the move still happens, without the landing
  }
  navigate(surfaceOf(loc) === "reader" ? "/" : "/workspace");
}

/** The jump left for this surface, once; null when there is none. */
export function takePendingJump(here: Surface, now = Date.now()): Locator | null {
  try {
    const raw = sessionStorage.getItem(PENDING);
    if (!raw) return null;
    const { loc, at } = JSON.parse(raw) as { loc?: Locator; at?: number };
    if (!loc || surfaceOf(loc) !== here) return null;
    sessionStorage.removeItem(PENDING);
    return typeof at === "number" && now - at < PENDING_MAX_AGE_MS ? loc : null;
  } catch {
    return null;
  }
}

export function onJump(handler: (loc: Locator) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<Locator>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

// The Workspace's own key for its list of workspaces (components/WorkspaceShell)
const WORKSPACES_KEY = "paper-reader:research-workspaces:v1";
const CHAT_KEY = "paper-reader:workspace-chat";

/**
 * The workspaces, as a search needs them: where each is, its papers, and its
 * chat — which lives in this browser, so the server cannot read it itself.
 */
export function workspacesForSearch(): unknown[] {
  try {
    const list = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || "[]") as { id: string; name: string; root: string; papers?: { id: string; name: string; zoteroKey?: string }[] }[];
    return list.map((w) => {
      let chat: { id: string; role: string; content: string }[] = [];
      try {
        chat = parseChat(JSON.parse(localStorage.getItem(`${CHAT_KEY}:${w.id}`) || "null")).messages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
      } catch {
        chat = [];
      }
      return { id: w.id, name: w.name, root: w.root, papers: (w.papers ?? []).map((p) => ({ id: p.id, name: p.name, zoteroKey: p.zoteroKey })), chat };
    });
  } catch {
    return [];
  }
}
