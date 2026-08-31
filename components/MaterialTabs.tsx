"use client";
import { useState } from "react";
import { DocType } from "@/types/session";

export type MaterialTab = {
  id: string; // paper id (Zotero key or name slug)
  name: string;
  docType: DocType;
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
  /** Pinned to the right of the row — stays put while the tabs scroll */
  trailing?: React.ReactNode;
};

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
export function MaterialTabs({ tabs, activeId, loadingId, onSelect, onClose, onReorder, trailing }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  if (tabs.length === 0) return null;

  const moveTab = (fromId: string, toId: string) => {
    if (!onReorder || fromId === toId) return;
    const ordered = reorderMaterialTabs(tabs, fromId, toId);
    if (ordered !== tabs) onReorder(ordered);
  };

  return (
    <div
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
                    : tab.docType === "html"
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
      {trailing && (
        // sticky, so it stays visible when many tabs push the row into scroll
        <div className="sticky right-0 ml-auto flex items-center shrink-0 pl-2" style={{ background: "var(--surface)" }}>
          {trailing}
        </div>
      )}
    </div>
  );
}
