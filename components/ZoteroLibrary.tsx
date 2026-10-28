"use client";
import { useState, useEffect, useRef, useCallback, useMemo, memo, type CSSProperties } from "react";
import { DocType } from "@/types/session";
import { CollapsedRail } from "@/components/ResizablePanel";
import { fetchZoteroDocument } from "@/lib/paper-data";
import { GrowingTextarea } from "./GrowingTextarea";
import styles from "./library.module.css";

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

export const ZoteroLibrary = memo(function ZoteroLibrary({ onDocumentLoaded, activeDocName, isOpen, onToggle, width = 272, refreshSignal, revealCollection }: Props) {
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
  // A paper being dragged onto a collection. Separate from dragKey, which is
  // the collection-reordering drag — the two look identical to the drop
  // handler otherwise, and reordering would fire when filing a paper.
  const [dragPaper, setDragPaper] = useState<{ key: string; from: string | null; title: string } | null>(null);
  const [filing, setFiling] = useState<string | null>(null);

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
      const loaded = await fetchZoteroDocument(item.key);
      const name = loaded.docType === "html" ? item.title : `${item.title}.pdf`;
      onDocumentLoaded(name, loaded.data, loaded.docType, item.key, loaded.attachmentKey, loaded.sourceUrl);
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

  // Drop a paper onto a collection: it leaves the collection it was dragged
  // out of and joins the target. Dragged from a flat list (search, All papers)
  // there is no source to leave, so it is filed as an addition.
  const filePaper = useCallback(async (paper: { key: string; from: string | null; title: string }, to: string) => {
    if (paper.from === to) return;
    setFiling(paper.key);
    setError(null);
    try {
      const res = await fetch("/api/zotero/item-collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: paper.key, from: paper.from ?? undefined, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not move that paper.");
      // Zotero syncs the change back down to the local API, which the sidebar
      // reads — reload both ends of the move rather than guessing
      setItemsByCollection((current) => {
        const next = { ...current };
        if (paper.from) delete next[paper.from];
        delete next[to];
        return next;
      });
      if (paper.from && expanded.has(paper.from)) void fetchItems(paper.from);
      if (expanded.has(to)) void fetchItems(to);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move that paper.");
    } finally {
      setFiling(null);
    }
  }, [expanded, fetchItems]);

  const renderItem = (item: ZoteroListItem, indent: number, sourceCollection: string | null = null, canDrag = true) => {
    const opening = openingKey === item.key;
    const isActive = activeDocName === item.title || activeDocName === `${item.title}.pdf`;
    const confirming = confirmKey === item.key;
    const removing = removingKey === item.key;
    const indentStyle = { "--indent": `${indent}rem` } as CSSProperties;

    // Asking before removing, in the row itself. The trash is recoverable, but
    // a stray click on a paper you are reading still shouldn't take it away.
    if (confirming) {
      return (
        <div key={item.key} className={styles.confirm} style={indentStyle}>
          <p>{item.title}</p>
          <div>
            <span>{removing ? "Moving to trash…" : "Move to Zotero trash?"}</span>
            {!removing && (
              <>
                <button type="button" onClick={() => handleRemove(item)} className={styles.danger}>
                  Move
                </button>
                <button type="button" onClick={() => setConfirmKey(null)}>
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
        draggable={canDrag}
        onDragStart={(event) => {
          setDragPaper({ key: item.key, from: sourceCollection, title: item.title });
          event.dataTransfer.effectAllowed = "move";
          // Some browsers refuse to start a drag with no payload
          event.dataTransfer.setData("text/plain", item.key);
        }}
        onDragEnd={() => { setDragPaper(null); setDropTargetKey(null); }}
        className={styles.item}
        data-active={isActive || undefined}
        data-dragging={dragPaper?.key === item.key || undefined}
        data-filing={filing === item.key || undefined}
        style={indentStyle}
        title={!canDrag ? undefined : sourceCollection ? "Drag onto a collection to move this paper there" : "Drag onto a collection to file this paper there"}
      >
        <button type="button" onClick={() => handleOpen(item)} disabled={openingKey !== null} className={styles.open}>
          <span className={styles.title}>
            {item.title}
            {opening && <span className={styles.opening}>opening…</span>}
          </span>
          <span className={styles.meta}>{[item.creators, item.year].filter(Boolean).join(" · ") || item.itemType}</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirmKey(item.key)}
          className={styles.trash}
          title="Move this item to the Zotero trash"
          aria-label={`Move “${item.title}” to the Zotero trash`}
        >
          <TrashIcon />
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
    // A collection accepts a dragged paper at any depth; the reorder drag is
    // top-level only, so the two drop behaviours stay distinct.
    const takesPaper = !!dragPaper && dragPaper.from !== collection.key;
    const isDropTarget =
      dropTargetKey === collection.key && (takesPaper || (depth === 0 && dragKey !== collection.key));
    // Reordering inserts *before* a collection, so it marks the edge; filing a
    // paper goes *into* one, so it lights the whole row.
    const drop = isDropTarget ? (dragPaper ? "into" : "edge") : undefined;
    const childIndent = 1.375 + depth * 0.75;
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
          onDragOver={(e) => {
            if (!dragPaper && depth !== 0) return;
            if (dragPaper && !takesPaper) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTargetKey(collection.key);
          }}
          onDragLeave={() => setDropTargetKey((current) => (current === collection.key ? null : current))}
          onDrop={(e) => {
            if (!dragPaper && depth !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (dragPaper) {
              const paper = dragPaper;
              setDragPaper(null);
              void filePaper(paper, collection.key);
            } else {
              handleDropOn(collection.key);
              setDragKey(null);
            }
            setDropTargetKey(null);
          }}
          onDragEnd={depth === 0 ? () => { setDragKey(null); setDropTargetKey(null); } : undefined}
          className={styles.collection}
          data-open={isExpanded || undefined}
          data-drop={drop}
          data-dragging={dragKey === collection.key || undefined}
          style={{ "--depth": depth } as CSSProperties}
          title={dragPaper ? `File “${dragPaper.title}” into ${collection.name}` : depth === 0 ? "Drag to reorder" : undefined}
        >
          <Chevron />
          <svg className={styles.folder} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.04l1.5 1.6H13c.69 0 1.25.56 1.25 1.25v6.4c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" />
          </svg>
          <span className={styles.name}>{collection.name}</span>
          {collection.numItems > 0 && <span className={styles.count}>{collection.numItems}</span>}
          {depth === 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePin(collection.key); }}
              className={styles.pin}
              aria-pressed={isPinned}
              title={isPinned ? "Unpin" : "Pin to top"}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m8 2.25 1.7 3.55 3.9.5-2.85 2.7.72 3.85L8 11l-3.47 1.85.72-3.85L2.4 6.3l3.9-.5z" />
              </svg>
            </button>
          )}
        </div>
        {isExpanded && (
          <div>
            {children.map((c) => renderCollection(c, depth + 1))}
            {isLoading && (
              <p className={styles.hint} style={{ "--indent": `${childIndent}rem` } as CSSProperties}>loading…</p>
            )}
            {items?.length === 0 && !isLoading && children.length === 0 && (
              <p className={styles.hint} style={{ "--indent": `${childIndent}rem` } as CSSProperties}>no papers</p>
            )}
            {items?.map((item) => renderItem(item, childIndent, collection.key))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) {
    return <CollapsedRail label="Zotero" side="left" onExpand={onToggle} title="Show Zotero library" />;
  }

  const showSearch = query.trim().length > 0;

  return (
    <div className={styles.panel} style={{ width }}>
      <div className={styles.head}>
        <strong>Zotero library</strong>
        <button type="button" onClick={reloadLibrary} className={styles.iconButton} title="Refresh library">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
            <path d="M13.25 2.5v3.25H10" />
          </svg>
        </button>
        <button type="button" onClick={onToggle} className={styles.iconButton} title="Collapse">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
        </button>
      </div>

      <div className={styles.search}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.25 10.25 3.25 3.25" />
        </svg>
        <GrowingTextarea
          value={query}
          placeholder="Search papers…"
          aria-label="Search the Zotero library"
          onChange={(e) => handleSearch(e.target.value)}
          // A query is one line; Enter must not put a newline in it
          onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
        />
      </div>

      {notice && (
        <div className={styles.notice}>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} title="Dismiss">✕</button>
        </div>
      )}

      {/* Tree / search results */}
      <div className={styles.tree}>
        {error && (
          <div className={styles.error}>
            {error}
            <button type="button" onClick={() => { setError(null); setLoaded(false); }}>
              Try again
            </button>
          </div>
        )}

        {!loaded && !error && <p className={styles.status}>Loading library…</p>}

        {showSearch ? (
          <>
            {searching && <p className={styles.status}>Searching…</p>}
            {!searching && searchResults?.length === 0 && <p className={styles.status}>No papers match your search</p>}
            {!searching && searchResults?.map((item) => renderItem(item, 0.625, null, false))}
          </>
        ) : (
          loaded && !error && (
            <>
              {orderedRoots.map((c) => renderCollection(c, 0))}

              {/* All papers — mirrors Zotero's "My Library" root */}
              <div className={styles.all}>
                <button
                  type="button"
                  onClick={() => toggleCollection("__all__")}
                  className={styles.collection}
                  data-open={expanded.has("__all__") || undefined}
                >
                  <Chevron />
                  <svg className={styles.library} viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5.25 1.75h5.5l2.5 2.5v8.5h-8z" />
                    <path d="M10.75 1.75v2.5h2.5" />
                    <path d="M2.75 4.25v10h7.5" />
                  </svg>
                  <span className={styles.name}>All papers (recent)</span>
                </button>
                {expanded.has("__all__") && (
                  <div>
                    {loadingKeys.has("__all__") && <p className={styles.hint}>loading…</p>}
                    {itemsByCollection["__all__"]?.map((item) => renderItem(item, 1.375))}
                  </div>
                )}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
});

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 1.75 6.75 5 3.5 8.25" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 4.5h10.5M6.25 4.5V3.25a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1V4.5M4.25 4.5l.6 8.4a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.4M6.75 7v4.25M9.25 7v4.25" />
    </svg>
  );
}
