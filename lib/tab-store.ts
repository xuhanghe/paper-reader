// One mechanism for "which documents are open", used by both surfaces.
//
// Reader and Workspace are separate routes, so a switch unmounts one and
// mounts the other and anything in component state is lost. Each surface needs
// the same three things: read what was open, write it back, and hear when it
// changed. Rather than two hand-rolled copies that drift, this is the single
// implementation; each surface makes its own store over its own key.

export type TabLike = { id: string };

export type TabStore<T extends TabLike> = {
  key: string;
  load: () => T[];
  save: (tabs: T[]) => void;
  /** Returns an unsubscribe function */
  subscribe: (onChange: () => void) => () => void;
};

// `isValid` guards what comes back out of storage, which may have been written
// by an older version of the app. Each surface knows what a usable entry looks
// like: a Reader tab needs a name to render, a workspace document needs a kind.
export function createTabStore<T extends TabLike>(
  key: string,
  isValid: (entry: unknown) => boolean = (entry) => !!(entry as TabLike | null)?.id
): TabStore<T> {
  // `storage` only fires in *other* browser tabs, so a surface would never
  // hear about its own write without a same-document event as well.
  const changed = `${key}:changed`;

  const load = (): T[] => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return Array.isArray(parsed) ? (parsed.filter(isValid) as T[]) : [];
    } catch {
      return [];
    }
  };

  const save = (tabs: T[]): void => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, JSON.stringify(tabs));
      window.dispatchEvent(new CustomEvent(changed));
    } catch {
      // a full or blocked localStorage costs persistence, never the session
    }
  };

  const subscribe = (onChange: () => void): (() => void) => {
    if (typeof window === "undefined") return () => {};
    const fromOtherBrowserTab = (event: StorageEvent) => {
      if (event.key === key) onChange();
    };
    window.addEventListener(changed, onChange);
    window.addEventListener("storage", fromOtherBrowserTab);
    return () => {
      window.removeEventListener(changed, onChange);
      window.removeEventListener("storage", fromOtherBrowserTab);
    };
  };

  return { key, load, save, subscribe };
}

// Adds or refreshes one tab without disturbing the order of the rest.
export function upsertTab<T extends TabLike>(tabs: T[], entry: T): T[] {
  return tabs.some((tab) => tab.id === entry.id)
    ? tabs.map((tab) => (tab.id === entry.id ? { ...tab, ...entry } : tab))
    : [...tabs, entry];
}
