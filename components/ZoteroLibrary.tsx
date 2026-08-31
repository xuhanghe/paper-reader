"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { DocType } from "@/types/session";
import { GrowingTextarea } from "./GrowingTextarea";

// Device-level preference for how root collections are arranged
const ORDER_KEY = "paper-reader:collection-order";
type OrderPrefs = { pinned: string[]; order: string[] };

function loadOrderPrefs(): OrderPrefs {
  if (typeof window === "undefined") return { pinned: [], order: [] };
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      pinned: Array.isArray(parsed?.pinned) ? parsed.pinned : [],
      order: Array.isArray(parsed?.order) ? parsed.order : [],
    };
  } catch {
    return { pinned: [], order: [] };
  }
}

export type ZoteroListItem = {
  key: string;
  title: string;
  creators: string;
  year: string;
  itemType: string;
};

type ZoteroCollection = {
  key: string;
  name: string;
  parentKey: string | null;
  numItems: number;
};

type Props = {
  onDocumentLoaded: (name: string, data: string, docType: DocType, zoteroKey?: string, attachmentKey?: string, sourceUrl?: string) => void;
  activeDocName: string;
  isOpen: boolean;
  onToggle: () => void;
  width?: number;
  refreshSignal?: number; // bump to reload the library (e.g. after a save)
  /** Collection to open and scroll to — set by the open paper's collection chip */
  revealCollection?: { key: string; nonce: number } | null;
};

export function ZoteroLibrary({ onDocumentLoaded, activeDocName, isOpen, onToggle, width = 272, refreshSignal, revealCollection }: Props) {
  const [query, setQuery] = useState("");
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemsByCollection, setItemsByCollection] = useState<Record<string, ZoteroListItem[]>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<ZoteroListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orderPrefs, setOrderPrefs] = useState<OrderPrefs>(loadOrderPrefs);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const savePrefs = useCallback((prefs: OrderPrefs) => {
    setOrderPrefs(prefs);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(prefs)); } catch {}
  }, []);

  // Root collections in display order: pinned first (user order), then the
  // user's custom order, then Zotero's alphabetical order for the rest
  const orderedRoots = useMemo(() => {
    const roots = collections.filter((c) => !c.parentKey);
    const pinnedIdx = new Map(orderPrefs.pinned.map((k, i) => [k, i]));
    const orderIdx = new Map(orderPrefs.order.map((k, i) => [k, i]));
    return [...roots].sort((a, b) => {
      const ap = pinnedIdx.has(a.key);
      const bp = pinnedIdx.has(b.key);
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && bp) return pinnedIdx.get(a.key)! - pinnedIdx.get(b.key)!;
      const ai = orderIdx.get(a.key) ?? Infinity;
      const bi = orderIdx.get(b.key) ?? Infinity;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  }, [collections, orderPrefs]);

  const togglePin = useCallback((key: string) => {
    const pinned = orderPrefs.pinned.includes(key)
      ? orderPrefs.pinned.filter((k) => k !== key)
      : [...orderPrefs.pinned, key];
    savePrefs({ ...orderPrefs, pinned });
  }, [orderPrefs, savePrefs]);

  // Drag-and-drop reordering of root collections. Dropping onto a row inserts
  // the dragged collection before it and adopts that row's pinned/unpinned group.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const handleDropOn = useCallback((targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    const keys = orderedRoots.map((c) => c.key);
    const pinnedSet = new Set(orderPrefs.pinned);
    keys.splice(keys.indexOf(dragKey), 1);
    keys.splice(keys.indexOf(targetKey), 0, dragKey);
    if (pinnedSet.has(targetKey)) pinnedSet.add(dragKey);
    else pinnedSet.delete(dragKey);
    savePrefs({
      pinned: keys.filter((k) => pinnedSet.has(k)),
      order: keys.filter((k) => !pinnedSet.has(k)),
    });
  }, [dragKey, orderedRoots, orderPrefs, savePrefs]);

  const fetchCollections = useCallback(async () => {
    try {
      const res = await fetch("/api/zotero/collections");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load Zotero collections");
      setCollections(data.collections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Zotero collections");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Load the collection tree the first time the panel is opened
  useEffect(() => {
    if (!isOpen || loaded) return;
    const t = setTimeout(fetchCollections, 0);
    return () => clearTimeout(t);
  }, [isOpen, loaded, fetchCollections]);

  const reloadLibrary = useCallback(() => {
    setItemsByCollection({});
    setExpanded(new Set());
    setLoaded(false);
  }, []);

  // A save just happened — reload so the new item appears without manual ↻.
  // Small delay gives Zotero a moment to finish creating the item.
  useEffect(() => {
    if (!refreshSignal) return;
    const t = setTimeout(reloadLibrary, 900);
    return () => clearTimeout(t);
  }, [refreshSignal, reloadLibrary]);

  const fetchItems = useCallback(async (collectionKey: string) => {
    setLoadingKeys((s) => new Set(s).add(collectionKey));
    try {
      const param = collectionKey === "__all__" ? "" : `collection=${encodeURIComponent(collectionKey)}`;
      const res = await fetch(`/api/zotero/items?${param}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load items");
      setItemsByCollection((prev) => ({ ...prev, [collectionKey]: data.items }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load items");
    } finally {
      setLoadingKeys((s) => { const next = new Set(s); next.delete(collectionKey); return next; });
    }
  }, []);

  const toggleCollection = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    if (!itemsByCollection[key]) fetchItems(key);
  }, [itemsByCollection, fetchItems]);

  // Reveal a collection on request: expand it (loading its items if this is
  // the first time), clear any search that would be hiding the tree, and
  // bring it into view. Keyed by nonce so asking twice for the same
  // collection still scrolls.
  useEffect(() => {
    if (!revealCollection) return;
    const { key } = revealCollection;
    // Deferred as one batch: updating state synchronously here would cascade
    // a render, and the scroll has to wait for the expanded rows anyway.
    const timer = setTimeout(() => {
      setQuery("");
      setSearchResults(null);
      setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      if (!itemsByCollection[key]) fetchItems(key);
      requestAnimationFrame(() => {
        const container = document.querySelector(`[data-collection-key="${key}"]`);
        // Centre the collection's header row, not the container: once expanded
        // the container is taller than the pane, so centring it scrolls the
        // name itself off the top.
        (container?.firstElementChild ?? container)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }, 0);
    return () => clearTimeout(timer);
    // itemsByCollection is deliberately out: it changes as items load, and
    // re-running would fight the user's own scrolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealCollection, fetchItems]);

  const handleSearch = (q: string) => {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/zotero/items?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Search failed");
        setSearchResults(data.items);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const handleOpen = async (item: ZoteroListItem) => {
    setOpeningKey(item.key);
    setError(null);
    try {
      const res = await fetch(`/api/zotero/file?key=${encodeURIComponent(item.key)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not fetch the file from Zotero");
      }
      const contentType = res.headers.get("Content-Type") || "";
      const attachmentKey = res.headers.get("X-Attachment-Key") || undefined;
      const rawSourceUrl = res.headers.get("X-Source-Url");
      const sourceUrl = rawSourceUrl ? decodeURIComponent(rawSourceUrl) : undefined;
      if (contentType.includes("text/html")) {
        const html = await res.text();
        onDocumentLoaded(item.title, html, "html", item.key, attachmentKey, sourceUrl);
      } else {
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read PDF data"));
          reader.readAsDataURL(blob);
        });
        onDocumentLoaded(`${item.title}.pdf`, dataUrl, "pdf", item.key, attachmentKey, sourceUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open this item");
    } finally {
      setOpeningKey(null);
    }
  };

  // Drop a trashed item from every list it appears in, rather than reloading
  // the whole library — a reload would collapse the tree the user is working in.
  const forgetItem = useCallback((key: string) => {
    // Which collections were showing it, so their counts stay honest. "__all__"
    // is the flat recent list, not a collection, so it has no count to adjust.
    const affected = new Set(
      Object.entries(itemsByCollection)
        .filter(([k, list]) => k !== "__all__" && list.some((i) => i.key === key))
        .map(([k]) => k)
    );
    setItemsByCollection((prev) =>
      Object.fromEntries(Object.entries(prev).map(([k, list]) => [k, list.filter((i) => i.key !== key)]))
    );
    setSearchResults((prev) => prev?.filter((i) => i.key !== key) ?? prev);
    if (affected.size > 0) {
      setCollections((prev) =>
        prev.map((c) => (affected.has(c.key) ? { ...c, numItems: Math.max(0, c.numItems - 1) } : c))
      );
    }
  }, [itemsByCollection]);

  const handleRemove = useCallback(async (item: ZoteroListItem) => {
    setRemovingKey(item.key);
    setError(null);
    try {
      const res = await fetch(`/api/zotero/items?key=${encodeURIComponent(item.key)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not move this item to the trash");
      forgetItem(item.key);
      setConfirmKey(null);
      // The list is read from the local Zotero API, but the trashing went
      // through zotero.org. Until that syncs back down, ↻ will show the item
      // again — say so, rather than let it look like the removal failed.
      setNotice(`“${item.title}” is in the Zotero trash. It may reappear here until Zotero syncs.`);
    } catch (e) {
      // The row stays put on failure — nothing was removed in Zotero either
      setError(e instanceof Error ? e.message : "Could not move this item to the trash");
      setConfirmKey(null);
    } finally {
      setRemovingKey(null);
    }
  }, [forgetItem]);

  const renderItem = (item: ZoteroListItem, indent: number) => {
    const opening = openingKey === item.key;
    const isActive = activeDocName === item.title || activeDocName === `${item.title}.pdf`;
    const confirming = confirmKey === item.key;
    const removing = removingKey === item.key;

    // Asking before removing, in the row itself. The trash is recoverable, but
    // a stray click on a paper you are reading still shouldn't take it away.
    if (confirming) {
      return (
        <div
          key={item.key}
          className="w-full py-1.5 pr-2"
          style={{ paddingLeft: `${indent}rem`, borderLeft: "2px solid #F87171", background: "rgba(248,113,113,0.08)" }}
        >
          <p className="text-[11px] leading-snug truncate" style={{ color: "var(--ink)" }}>{item.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px]" style={{ color: "var(--ink-muted)" }}>
              {removing ? "Moving to trash…" : "Move to Zotero trash?"}
            </span>
            {!removing && (
              <>
                <button
                  onClick={() => handleRemove(item)}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ color: "#F87171", border: "1px solid rgba(248,113,113,0.4)" }}
                >
                  Move
                </button>
                <button
                  onClick={() => setConfirmKey(null)}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ color: "var(--ink-faint)" }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        key={item.key}
        className="group/item w-full flex items-center transition-colors"
        style={{
          borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
          background: isActive ? "var(--accent-dim)" : "transparent",
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(230,237,243,0.05)"; }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <button
          onClick={() => handleOpen(item)}
          disabled={openingKey !== null}
          className="min-w-0 flex-1 text-left py-1.5 pr-1 disabled:opacity-50"
          style={{ paddingLeft: `${indent}rem` }}
        >
          <p className="text-[11px] leading-snug" style={{ color: "var(--ink)" }}>
            {item.title}
            {opening && <span className="ml-1.5 text-[10px]" style={{ color: "var(--accent)" }}>opening…</span>}
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--ink-faint)" }}>
            {[item.creators, item.year].filter(Boolean).join(" · ") || item.itemType}
          </p>
        </button>
        <button
          onClick={() => setConfirmKey(item.key)}
          className="btn-icon w-5 h-5 mr-1.5 text-[10px] shrink-0 opacity-0 group-hover/item:opacity-100 focus:opacity-100 transition-opacity"
          style={{ color: "#F87171" }}
          title="Move this item to the Zotero trash"
          aria-label={`Move “${item.title}” to the Zotero trash`}
        >
          🗑
        </button>
      </div>
    );
  };

  const renderCollection = (collection: ZoteroCollection, depth: number) => {
    const isExpanded = expanded.has(collection.key);
    const children = collections.filter((c) => c.parentKey === collection.key);
    const items = itemsByCollection[collection.key];
    const isLoading = loadingKeys.has(collection.key);
    const isPinned = orderPrefs.pinned.includes(collection.key);
    const isDropTarget = depth === 0 && dropTargetKey === collection.key && dragKey !== collection.key;
    return (
      <div key={collection.key} data-collection-key={collection.key}>
        <div
          onClick={() => toggleCollection(collection.key)}
          draggable={depth === 0}
          onDragStart={depth === 0 ? (e) => {
            setDragKey(collection.key);
            e.dataTransfer.effectAllowed = "move";
            // Some browsers refuse to start a drag without payload data
            e.dataTransfer.setData("text/plain", collection.key);
          } : undefined}
          onDragOver={depth === 0 ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTargetKey(collection.key); } : undefined}
          onDrop={depth === 0 ? (e) => { e.preventDefault(); handleDropOn(collection.key); setDragKey(null); setDropTargetKey(null); } : undefined}
          onDragEnd={depth === 0 ? () => { setDragKey(null); setDropTargetKey(null); } : undefined}
          className="group w-full text-left flex items-center gap-1.5 py-1.5 pr-2 transition-colors cursor-pointer select-none"
          style={{
            paddingLeft: `${0.625 + depth * 0.75}rem`,
            boxShadow: isDropTarget ? "inset 0 2px 0 var(--accent)" : "none",
            opacity: dragKey === collection.key ? 0.4 : 1,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(230,237,243,0.05)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          title={depth === 0 ? "Drag to reorder" : undefined}
        >
          <span className="text-[9px] shrink-0" style={{ color: "var(--accent)" }}>{isExpanded ? "▾" : "▸"}</span>
          <span className="text-xs truncate" style={{ color: "var(--ink-muted)" }}>
            {isPinned && <span title="Pinned" style={{ color: "var(--accent)" }}>⭑ </span>}
            {collection.name}
          </span>
          <span className="ml-auto text-[10px] shrink-0 tabular-nums" style={{ color: "var(--ink-faint)" }}>
            {collection.numItems > 0 ? collection.numItems : ""}
          </span>
          {depth === 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); togglePin(collection.key); }}
              className="btn-icon w-4 h-4 text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              style={isPinned ? { color: "var(--accent)", opacity: 1 } : {}}
              title={isPinned ? "Unpin" : "Pin to top"}
            >⭑</button>
          )}
        </div>
        {isExpanded && (
          <div>
            {children.map((c) => renderCollection(c, depth + 1))}
            {isLoading && (
              <p className="text-[10px] py-1" style={{ color: "var(--ink-faint)", paddingLeft: `${1.375 + depth * 0.75}rem` }}>loading…</p>
            )}
            {items?.length === 0 && !isLoading && children.length === 0 && (
              <p className="text-[10px] py-1" style={{ color: "var(--ink-faint)", paddingLeft: `${1.375 + depth * 0.75}rem` }}>no papers</p>
            )}
            {items?.map((item) => renderItem(item, 1.375 + depth * 0.75))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="flex flex-col items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(230,237,243,0.05)]"
        style={{ width: "2.25rem", borderRight: "1px solid var(--border)", background: "var(--surface)" }}
        title="Show Zotero library"
      >
        <span className="flex items-center justify-center h-9 w-full shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="rotate-90 text-xs" style={{ color: "var(--ink-faint)" }}>≡</span>
        </span>
        <span
          className="mt-3 text-[10px] uppercase tracking-widest select-none"
          style={{ color: "var(--ink-faint)", writingMode: "vertical-rl" }}
        >
          Zotero
        </span>
      </button>
    );
  }

  const showSearch = query.trim().length > 0;

  return (
    <div className="flex flex-col overflow-hidden" style={{ width: `${width}px`, minWidth: 170, borderRight: "1px solid var(--border)", background: "var(--surface)" }}>
      {/* Header */}
      <div className="flex items-center h-9 shrink-0 px-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-xs font-medium" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
          Zotero Library
        </span>
        <button
          onClick={reloadLibrary}
          className="btn-icon ml-auto w-6 h-6 text-[11px]"
          title="Refresh library"
        >
          ↻
        </button>
        <button onClick={onToggle} className="btn-icon w-6 h-6 text-xs" title="Collapse">
          ‹
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 py-2 shrink-0" style={{ borderBottom: "1px solid var(--border-light)" }}>
        <div className="relative">
          <span
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm leading-none pointer-events-none"
            style={{ color: "var(--ink-faint)" }}
          >
            ⌕
          </span>
          <GrowingTextarea
            value={query}
            placeholder="Search papers…"
            onChange={(e) => handleSearch(e.target.value)}
            // A query is one line; Enter must not put a newline in it
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
            className="w-full text-xs pl-7 pr-2.5 py-1.5 rounded-md focus:outline-none transition-colors resize-none"
            style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
          />
        </div>
      </div>

      {notice && (
        <div className="mx-2.5 mt-2 px-2.5 py-1.5 rounded text-[10px] leading-relaxed flex items-start gap-1.5"
             style={{ background: "var(--accent-dim)", color: "var(--ink-muted)" }}>
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="shrink-0" style={{ color: "var(--ink-faint)" }} title="Dismiss">✕</button>
        </div>
      )}

      {/* Tree / search results */}
      <div className="flex-1 overflow-y-auto py-1">
        {error && (
          <div className="m-2.5 px-2.5 py-2 rounded text-[11px] leading-relaxed" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", color: "#F87171" }}>
            {error}
            <button onClick={() => { setError(null); setLoaded(false); }} className="block mt-1.5 underline" style={{ color: "#F87171" }}>
              Try again
            </button>
          </div>
        )}

        {!loaded && !error && (
          <p className="text-xs text-center py-6" style={{ color: "var(--ink-faint)" }}>Loading library…</p>
        )}

        {showSearch ? (
          <>
            {searching && <p className="text-xs text-center py-4" style={{ color: "var(--ink-faint)" }}>Searching…</p>}
            {!searching && searchResults?.length === 0 && (
              <p className="text-xs text-center py-4 px-3" style={{ color: "var(--ink-faint)" }}>No papers match your search</p>
            )}
            {!searching && searchResults?.map((item) => renderItem(item, 0.625))}
          </>
        ) : (
          loaded && !error && (
            <>
              {orderedRoots.map((c) => renderCollection(c, 0))}

              {/* All papers — mirrors Zotero's "My Library" root */}
              <button
                onClick={() => toggleCollection("__all__")}
                className="w-full text-left flex items-center gap-1.5 py-1.5 px-2.5 transition-colors mt-1"
                style={{ borderTop: "1px solid var(--border-light)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(230,237,243,0.05)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <span className="text-[9px] shrink-0" style={{ color: "var(--accent)" }}>{expanded.has("__all__") ? "▾" : "▸"}</span>
                <span className="text-xs" style={{ color: "var(--ink-muted)" }}>All papers (recent)</span>
              </button>
              {expanded.has("__all__") && (
                <div>
                  {loadingKeys.has("__all__") && <p className="text-[10px] py-1 pl-5" style={{ color: "var(--ink-faint)" }}>loading…</p>}
                  {itemsByCollection["__all__"]?.map((item) => renderItem(item, 1.375))}
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
