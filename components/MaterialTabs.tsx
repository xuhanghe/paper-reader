"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocType } from "@/types/session";

export type MaterialTab = {
  id: string; // paper id (Zotero key or name slug)
  name: string;
  docType: DocType;
  // Display only, for surfaces that open more than papers: the Workspace also
  // opens editable project files, and its tabs mark them differently.
  kind?: "paper" | "file";
  zoteroKey?: string;
  attachmentKey?: string;
  sourceUrl?: string;
};

type Props = {
  tabs: MaterialTab[];
  activeId: string | null;
  loadingId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder?: (tabs: MaterialTab[]) => void;
  // Names this bar so its scroll offset survives the bar being unmounted —
  // crossing to the Workspace and back — and the tab you left is the tab
  // you find
  rememberAs?: string;
};

// Where the bar should scroll so the active tab is in view: null when it
// already is, otherwise the offset that centres it — clamped to what the bar
// can scroll to, so a tab at either end sits at that end.
export function tabBarScrollFor(bar: { scrollLeft: number; clientWidth: number; scrollWidth: number }, tab: { left: number; width: number }): number | null {
  const visible = tab.left >= bar.scrollLeft && tab.left + tab.width <= bar.scrollLeft + bar.clientWidth;
  if (visible) return null;
  const centred = tab.left + tab.width / 2 - bar.clientWidth / 2;
  return Math.round(Math.max(0, Math.min(centred, bar.scrollWidth - bar.clientWidth)));
}

// Each bar's last scroll offset, by name, across unmounts
const remembered = new Map<string, number>();

// The order with one tab moved to sit at `index` of the others — the slot
// between two tabs the pointer was over, from 0 (before the first) to the
// count (after the last).
export function moveMaterialTab(tabs: MaterialTab[], fromId: string, index: number): MaterialTab[] {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  if (from < 0) return tabs;
  const rest = tabs.filter((tab) => tab.id !== fromId);
  const at = Math.max(0, Math.min(index > from ? index - 1 : index, rest.length));
  if (at === from) return tabs;
  return [...rest.slice(0, at), tabs[from], ...rest.slice(at)];
}

// Which slot a pointer at `x` over a tab means: before it or after it. The
// rect is where the tab rests, not where it has eased to — deciding from the
// moved tab fed back on itself and made it flutter. Across the middle fifth
// of the tab the current slot holds, so a pointer resting on the midpoint
// cannot flip it; past that, the side the pointer is on decides.
const HOLD = 0.1;
export function slotAt(x: number, rect: { left: number; width: number }, tabIndex: number, current: number | null = null): number {
  const mid = rect.left + rect.width / 2;
  const zone = rect.width * HOLD;
  if (current !== null && (current === tabIndex || current === tabIndex + 1) && Math.abs(x - mid) < zone) return current;
  return x < mid ? tabIndex : tabIndex + 1;
}

export function reorderMaterialTabs(tabs: MaterialTab[], fromId: string, toId: string): MaterialTab[] {
  if (fromId === toId) return tabs;
  const from = tabs.findIndex((tab) => tab.id === fromId);
  const to = tabs.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0) return tabs;
  const ordered = [...tabs];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  return ordered;
}

// Open materials, switchable like browser tabs. Each tab keeps its own
// conversation, paper map and highlights — switching restores that paper's
// session rather than starting over.
export function MaterialTabs({ tabs, activeId, loadingId, onSelect, onClose, onReorder, rememberAs }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  // The slot the dragged tab would land in, while it is over the bar
  const [slot, setSlot] = useState<number | null>(null);
  const [dragWidth, setDragWidth] = useState(0);
  const barRef = useRef<HTMLDivElement | null>(null);
  // Whether the pointer has really left the bar is settled by time, not by
  // dragleave's relatedTarget: Safari leaves that null, and a gap opening
  // under the pointer fires dragleave on the tab that eased away — read as
  // leaving, the gap closed, the tab came back, and so on, fast.
  const lastOver = useRef(0);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tabs move at most once every 180ms, and only for a slot the pointer has
  // meant for 50ms: whatever a browser does with its drag events, no tab
  // can flutter faster than that
  const pending = useRef<{ slot: number; since: number } | null>(null);
  const lastMove = useRef(0);
  const settleSlot = useCallback((next: number, current: number | null) => {
    const now = Date.now();
    if (next === current) { pending.current = null; return; }
    if (!pending.current || pending.current.slot !== next) { pending.current = { slot: next, since: now }; return; }
    if (now - pending.current.since < 50 || now - lastMove.current < 180) return;
    pending.current = null;
    lastMove.current = now;
    setSlot(next);
  }, []);
  const stillOver = useCallback(() => {
    lastOver.current = Date.now();
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
  }, []);

  // The active tab is always in view. A bar fresh from a remount starts at
  // its left edge, so the offset it was left at comes back first: if the tab
  // was in view when the reader left, it is where they left it; if not, or
  // if the active tab changed, the bar scrolls to put it in the middle.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (rememberAs && restoredFor.current !== rememberAs) {
      restoredFor.current = rememberAs;
      const last = remembered.get(rememberAs);
      if (last !== undefined) bar.scrollLeft = last;
    }
    const tab = activeId ? (bar.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`) as HTMLElement | null) : null;
    if (!tab) return;
    const to = tabBarScrollFor(bar, { left: tab.offsetLeft, width: tab.offsetWidth });
    if (to !== null) bar.scrollTo({ left: to, behavior: "smooth" });
  }, [activeId, tabs, rememberAs]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !rememberAs) return;
    const note = () => remembered.set(rememberAs, bar.scrollLeft);
    bar.addEventListener("scroll", note, { passive: true });
    return () => {
      bar.removeEventListener("scroll", note);
      // Detached, the bar reads 0; the last offset seen is the one to keep
      if (bar.isConnected) note();
    };
  }, [rememberAs, tabs.length]);

  if (tabs.length === 0) return null;

  // Dragging a tab opens a gap where it would land: the tabs between its old
  // slot and the new one ease aside by its width, its own slot closing behind
  // it, and the tab itself travels with the pointer as the browser's drag
  // image. Dropping puts it in the gap. Leaving the bar closes the gap.
  const fromIndex = dragId ? tabs.findIndex((tab) => tab.id === dragId) : -1;
  const shiftFor = (i: number): number => {
    if (slot === null || fromIndex < 0 || i === fromIndex) return 0;
    if (slot <= fromIndex && i >= slot && i < fromIndex) return dragWidth;
    if (slot > fromIndex && i > fromIndex && i < slot) return -dragWidth;
    return 0;
  };
  const finish = (index: number | null) => {
    if (onReorder && dragId && index !== null) {
      const ordered = moveMaterialTab(tabs, dragId, index);
      if (ordered !== tabs) onReorder(ordered);
    }
    setDragId(null);
    setSlot(null);
  };

  return (
    <div
      ref={barRef}
      className="flex items-stretch shrink-0 overflow-x-auto"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
      onDragOver={(event) => {
        if (!dragId || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        stillOver();
        // Over the bar itself: the gap that has opened keeps its slot; past
        // the last tab, the slot at the end
        const last = event.currentTarget.lastElementChild?.getBoundingClientRect();
        if (last && event.clientX > last.right) settleSlot(tabs.length, slot);
      }}
      onDrop={(event) => { if (!dragId) return; event.preventDefault(); finish(slot); }}
      onDragLeave={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => { if (Date.now() - lastOver.current > 120) setSlot(null); }, 150);
      }}
    >
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeId;
        const isLoading = tab.id === loadingId;
        const isDragged = tab.id === dragId;
        const label = tab.name.replace(/\.pdf$/i, "");
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => !isActive && onSelect(tab.id)}
            title={label}
            draggable={!!onReorder}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
              const width = event.currentTarget.getBoundingClientRect().width;
              // Not yet: WebKit abandons a drag whose source changes while
              // dragstart is being handled, and the re-render would change
              // this tab's look. A frame later it is safe.
              setTimeout(() => { setDragId(tab.id); setDragWidth(width); }, 0);
            }}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              stillOver();
              const rect = event.currentTarget.getBoundingClientRect();
              settleSlot(slotAt(event.clientX, { left: rect.left - shiftFor(i), width: rect.width }, i, slot), slot);
            }}
            onDrop={(event) => { event.preventDefault(); finish(slot); }}
            onDragEnd={() => { setDragId(null); setSlot(null); pending.current = null; }}
            className="pr-material-tab group flex items-center gap-2 pl-3 pr-2 py-1.5 cursor-pointer select-none shrink-0 max-w-[240px]"
            style={{
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--paper)" : "transparent",
              boxShadow: isActive ? "inset 0 2px 0 var(--accent)" : "none",
              // The picked-up tab leaves a dim outline of itself until it lands
              opacity: isDragged ? (slot !== null ? 0.15 : 0.5) : 1,
              transform: `translateX(${shiftFor(i)}px)`,
              transition: "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 120ms ease, background-color 120ms ease",
            }}
            onMouseEnter={(e) => {
              if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(230,237,243,0.04)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                background: isLoading
                  ? "var(--badge-text-fg)"
                  : isActive
                    ? "var(--accent)"
                    : tab.kind === "file" || tab.docType === "html"
                      ? "var(--badge-fig-fg)"
                      : "var(--ink-faint)",
              }}
            />
            <span
              className="text-[11px] truncate"
              style={{ color: isActive ? "var(--ink)" : "var(--ink-muted)" }}
            >
              {label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              className="btn-icon w-4 h-4 text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Close tab"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
