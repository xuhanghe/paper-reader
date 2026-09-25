"use client";
import { useEffect, useRef, useState } from "react";
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
  const [dropId, setDropId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

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

  const moveTab = (fromId: string, toId: string) => {
    if (!onReorder || fromId === toId) return;
    const ordered = reorderMaterialTabs(tabs, fromId, toId);
    if (ordered !== tabs) onReorder(ordered);
  };

  return (
    <div
      ref={barRef}
      className="flex items-stretch shrink-0 overflow-x-auto"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const isLoading = tab.id === loadingId;
        const label = tab.name.replace(/\.pdf$/i, "");
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => !isActive && onSelect(tab.id)}
            title={label}
            draggable={!!onReorder}
            onDragStart={(event) => {
              setDragId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragOver={(event) => {
              if (!dragId || dragId === tab.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropId(tab.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromId = dragId || event.dataTransfer.getData("text/plain");
              if (fromId) moveTab(fromId, tab.id);
              setDragId(null);
              setDropId(null);
            }}
            onDragEnd={() => { setDragId(null); setDropId(null); }}
            className="pr-material-tab group flex items-center gap-2 pl-3 pr-2 py-1.5 cursor-pointer select-none shrink-0 max-w-[240px] transition-colors"
            style={{
              borderRight: "1px solid var(--border)",
              borderLeft: dropId === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
              background: isActive ? "var(--paper)" : "transparent",
              boxShadow: isActive ? "inset 0 2px 0 var(--accent)" : "none",
              opacity: dragId === tab.id ? 0.45 : 1,
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
