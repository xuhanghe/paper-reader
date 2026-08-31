"use client";
import { useEffect, useState } from "react";

export type ItemCollection = { key: string; name: string; path: string };

type Props = {
  /** Zotero item (or attachment) key for the open paper; absent for local files */
  zoteroKey?: string;
  onReveal?: (collectionKey: string) => void;
};

// Which Zotero collection the open paper filed under. Silent for anything not
// from Zotero, and silent when Zotero has it filed nowhere — an empty chip
// would be noise, not information.
export function CollectionChip({ zoteroKey, onReveal }: Props) {
  // Keyed by the paper it describes, so switching tabs can't briefly show the
  // previous paper's collection — and so clearing on switch needs no
  // synchronous setState in the effect.
  const [loaded, setLoaded] = useState<{ key: string; list: ItemCollection[] } | null>(null);

  useEffect(() => {
    if (!zoteroKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/zotero/item-collections?key=${encodeURIComponent(zoteroKey)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setLoaded({ key: zoteroKey, list: Array.isArray(data.collections) ? data.collections : [] });
      } catch {
        // a missing chip is the right failure here — never an error surface
      }
    })();
    return () => { cancelled = true; };
  }, [zoteroKey]);

  const collections = zoteroKey && loaded?.key === zoteroKey ? loaded.list : [];
  if (!collections.length) return null;

  const [first, ...rest] = collections;
  const title = collections.length > 1
    ? `Filed in ${collections.map((c) => c.path).join(", ")}`
    : `Filed in ${first.path}`;

  return (
    <span className="pr-collection-chip" title={title}>
      <span aria-hidden>▤</span>
      <button type="button" onClick={() => onReveal?.(first.key)} title={`Show “${first.path}” in the library`}>
        {first.name}
      </button>
      {rest.length > 0 && <small>+{rest.length}</small>}
    </span>
  );
}
