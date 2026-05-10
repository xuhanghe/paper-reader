"use client";
import { ConceptEntry } from "@/types/session";

type Props = {
  concepts: ConceptEntry[];
  onSelect: (annotationId: string) => void;
  isOpen: boolean;
  onToggle: () => void;
};

export function ConceptSidebar({ concepts, onSelect, isOpen, onToggle }: Props) {
  return (
    <div
      className="flex flex-col transition-all duration-200"
      style={{
        width: isOpen ? "14rem" : "2.25rem",
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <button
        onClick={onToggle}
        className="flex items-center justify-center h-9 shrink-0 transition-opacity hover:opacity-70"
        style={{ borderBottom: "1px solid var(--border)", color: "var(--ink-muted)" }}
        title={isOpen ? "Collapse" : "Show concepts"}
      >
        {isOpen ? (
          <span className="flex items-center gap-1 px-2 text-xs w-full">
            <span style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif", color: "var(--ink-muted)" }}>Concepts</span>
            <span className="ml-auto" style={{ color: "var(--ink-faint)" }}>›</span>
          </span>
        ) : (
          <span className="rotate-90 text-xs" style={{ color: "var(--ink-faint)" }}>≡</span>
        )}
      </button>

      {isOpen && (
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {concepts.length === 0 && (
            <p className="text-xs text-center mt-4 px-2" style={{ color: "var(--ink-faint)" }}>
              Explained concepts will appear here
            </p>
          )}
          {concepts.map((c) => (
            <button
              key={c.annotationId}
              onClick={() => onSelect(c.annotationId)}
              className="w-full text-left text-xs rounded px-2 py-1.5 transition-colors flex items-start gap-1.5"
              style={{ color: "var(--ink-muted)" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(230,237,243,0.07)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--ink)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--ink-muted)";
              }}
            >
              <span
                className="shrink-0 mt-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
                style={
                  c.type === "image"
                    ? { background: "var(--badge-fig-bg)", color: "var(--badge-fig-fg)" }
                    : { background: "var(--badge-text-bg)", color: "var(--badge-text-fg)" }
                }
              >
                {c.type === "image" ? "Fig" : "Txt"}
              </span>
              <span className="leading-tight break-words">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
