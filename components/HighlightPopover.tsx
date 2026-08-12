"use client";
import { useState } from "react";
import { HIGHLIGHT_COLORS } from "@/lib/highlight-colors";
import { isSubmitKey } from "@/lib/keys";

type Props = {
  rect: DOMRect;
  color?: string;
  note?: string;
  onRecolor: (color: string) => void;
  onEditNote: (note: string) => void;
  onRemove: () => void;
  onDismiss: () => void;
};

// Shown when an existing highlight is clicked: recolour it, edit its note, or
// take it off. Every edit here goes straight to the one copy in Zotero.
export function HighlightPopover({ rect, color, note, onRecolor, onEditNote, onRemove, onDismiss }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note || "");

  const saveNote = () => {
    const next = draft.trim();
    if (next !== (note || "")) onEditNote(next);
    setEditing(false);
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      className="pr-fade-up"
      style={{
        position: "fixed",
        top: rect.bottom + 8,
        left: Math.max(120, rect.left + rect.width / 2),
        transform: "translateX(-50%)",
        zIndex: 50,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-card)",
        padding: "6px 8px",
      }}
    >
      <div className="flex items-center gap-1">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.id}
            onClick={() => onRecolor(c.hex)}
            className="w-4 h-4 rounded-full transition-transform hover:scale-125"
            style={{
              background: c.hex,
              boxShadow: color?.toLowerCase() === c.hex ? "0 0 0 2px var(--surface), 0 0 0 3.5px var(--ink-muted)" : "none",
            }}
            title={`Change to ${c.label}`}
          />
        ))}
        <span className="mx-1" style={{ color: "var(--border)" }}>|</span>
        <button
          onClick={() => { setDraft(note || ""); setEditing((v) => !v); }}
          className="text-xs px-1.5 py-0.5 rounded transition-colors"
          style={{ color: editing ? "var(--accent)" : "var(--ink-muted)" }}
          title={note ? "Edit this note" : "Add a note"}
        >
          ✎ {note ? "Edit note" : "Note"}
        </button>
        <button
          onClick={onRemove}
          className="text-xs px-1.5 py-0.5 rounded transition-colors"
          style={{ color: "#F87171" }}
          title="Remove this highlight"
        >
          🗑 Remove
        </button>
        <button
          onClick={onDismiss}
          className="btn-icon w-5 h-5 text-[10px]"
          title="Close"
        >
          ✕
        </button>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5 mt-1.5">
          <input
            type="text"
            autoFocus
            value={draft}
            placeholder="Write a note — empty clears it"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isSubmitKey(e)) saveNote();
              if (e.key === "Escape") setEditing(false);
            }}
            className="flex-1 min-w-[220px] text-xs px-2 py-1 rounded focus:outline-none"
            style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
          />
          <button onClick={saveNote} className="btn-primary text-xs px-2.5 py-1 shrink-0">Save</button>
        </div>
      ) : (
        note && (
          <p className="mt-1.5 px-1 text-[10px] leading-snug max-w-[260px]" style={{ color: "var(--ink-muted)" }}>
            ✎ {note}
          </p>
        )
      )}
    </div>
  );
}
