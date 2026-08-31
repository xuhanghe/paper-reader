// The set of open papers, shared by both surfaces.
//
// Reader and Workspace are separate routes, so switching between them unmounts
// one and mounts the other. Anything held only in component state is lost on
// the way across — which is why a paper opened in the Workspace used to be
// closed by the time you came back to it. This module is the single place the
// list lives, so both surfaces read and write the same tabs.

import type { MaterialTab } from "@/components/MaterialTabs";

export const OPEN_TABS_KEY = "paper-reader:open-tabs";

// Same-document notification. `storage` only fires in *other* tabs of the
// browser, so a surface that saves would never hear about its own write.
const CHANGED = "paper-reader:open-tabs-changed";

export function loadOpenTabs(): MaterialTab[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || "null");
    return Array.isArray(parsed) ? parsed.filter((tab) => tab?.id && tab?.name) : [];
  } catch {
    return [];
  }
}

export function saveOpenTabs(tabs: MaterialTab[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs));
    window.dispatchEvent(new CustomEvent(CHANGED));
  } catch {
    // a full or blocked localStorage costs persistence, never the session
  }
}

export function subscribeOpenTabs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fromOtherBrowserTab = (event: StorageEvent) => {
    if (event.key === OPEN_TABS_KEY) onChange();
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", fromOtherBrowserTab);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", fromOtherBrowserTab);
  };
}

// Adds or refreshes one paper without disturbing the order of the rest.
export function upsertOpenTab(tabs: MaterialTab[], entry: MaterialTab): MaterialTab[] {
  return tabs.some((tab) => tab.id === entry.id)
    ? tabs.map((tab) => (tab.id === entry.id ? { ...tab, ...entry } : tab))
    : [...tabs, entry];
}
