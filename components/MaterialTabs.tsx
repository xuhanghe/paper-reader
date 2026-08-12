"use client";
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
};

// Open materials, switchable like browser tabs. Each tab keeps its own
// conversation, paper map and highlights — switching restores that paper's
// session rather than starting over.
export function MaterialTabs({ tabs, activeId, loadingId, onSelect, onClose }: Props) {
  if (tabs.length === 0) return null;

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
            className="group flex items-center gap-2 pl-3 pr-2 py-1.5 cursor-pointer select-none shrink-0 max-w-[240px] transition-colors"
            style={{
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--paper)" : "transparent",
              boxShadow: isActive ? "inset 0 2px 0 var(--accent)" : "none",
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
              className="text-xs truncate"
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
