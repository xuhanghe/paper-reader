"use client";
import { useState } from "react";
import { HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import { isSubmitKey } from "@/lib/keys";

type Props = {
  rect: DOMRect;
  selectedText: string;
  onExplain: () => void;
  onAsk: (question: string) => void;
  onHighlight?: (color: string) => void;
  onNote?: (note: string, color: string) => void;
  onDismiss: () => void;
};

export function SelectionPopover({ rect, selectedText, onExplain, onAsk, onHighlight, onNote, onDismiss }: Props) {
  const [question, setQuestion] = useState("");
  const [noteMode, setNoteMode] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [focused, setFocused] = useState(false);
  const [color, setColor] = useState<string>(DEFAULT_HIGHLIGHT_COLOR);

  const submitQuestion = () => {
    if (question.trim()) onAsk(question.trim());
  };
  const submitNote = () => {
    if (noteText.trim() && onNote) onNote(noteText.trim(), color);
  };

  const snippet = selectedText.length > 90 ? selectedText.slice(0, 90) + "…" : selectedText;

  return (
    <div
      // Focusing an input clears the browser selection; stop mouse events from
      // reaching the container's selection handler so the popover survives.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: rect.bottom + 8,
        left: Math.max(150, rect.left + rect.width / 2),
        transform: "translateX(-50%)",
        zIndex: 50,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        padding: "6px 8px",
        width: "290px",
      }}
    >
      <div className="flex items-center gap-0.5">
        <button
          onClick={onExplain}
          className="text-sm font-medium transition-opacity hover:opacity-80 px-1"
          style={{ color: "var(--accent)", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
        >
          Explain ↗
        </button>
        {onHighlight && (
          <>
            <span style={{ color: "var(--border)" }}>|</span>
            <span className="flex items-center gap-1 px-1" title="Highlight in this colour">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setColor(c.hex);
                    // In note mode the colour applies when the note is saved
                    if (!noteMode) onHighlight(c.hex);
                  }}
                  className="w-4 h-4 rounded-full transition-transform hover:scale-125"
                  style={{
                    background: c.hex,
                    boxShadow: color === c.hex ? "0 0 0 2px var(--surface), 0 0 0 3.5px var(--ink-muted)" : "none",
                  }}
                  title={noteMode ? `Note in ${c.label}` : `Highlight in ${c.label}`}
                />
              ))}
            </span>
          </>
        )}
        {onNote && (
          <>
            <span style={{ color: "var(--border)" }}>|</span>
            <button
              onClick={() => setNoteMode((v) => !v)}
              className="text-xs transition-opacity hover:opacity-80 px-1"
              style={{ color: noteMode ? "var(--accent)" : "var(--ink-muted)" }}
              title="Highlight with a note"
            >
              ✎ Note
            </button>
          </>
        )}
        <button
          onClick={onDismiss}
          className="ml-auto text-xs transition-opacity hover:opacity-70 px-1"
          style={{ color: "var(--ink-faint)" }}
        >
          ✕
        </button>
      </div>

      {(focused || noteMode) && (
        <p
          className="mt-1.5 px-1 text-[10px] leading-snug"
          style={{ color: "var(--ink-faint)", fontFamily: "var(--font-geist-mono), monospace" }}
        >
          “{snippet}”
        </p>
      )}

      {noteMode ? (
        <div className="flex items-center gap-1.5 mt-1.5">
          <input
            type="text"
            autoFocus
            value={noteText}
            placeholder="Write a note for this passage…"
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (isSubmitKey(e)) submitNote();
              if (e.key === "Escape") setNoteMode(false);
            }}
            className="flex-1 min-w-0 text-xs px-2 py-1 rounded focus:outline-none"
            style={{
              border: "1px solid var(--accent)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
            }}
          />
          {noteText.trim() && (
            <button onClick={submitNote} className="btn-primary text-xs px-2.5 py-1 shrink-0">
              Save
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 mt-1.5">
          <input
            type="text"
            value={question}
            placeholder="or ask a question about it…"
            onChange={(e) => setQuestion(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={(e) => {
              if (isSubmitKey(e)) submitQuestion();
              if (e.key === "Escape") onDismiss();
            }}
            className="flex-1 min-w-0 text-xs px-2 py-1 rounded focus:outline-none"
            style={{
              border: "1px solid var(--border)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
            }}
          />
          {question.trim() && (
            <button onClick={submitQuestion} className="btn-primary text-xs px-2.5 py-1 shrink-0">
              Ask
            </button>
          )}
        </div>
      )}
    </div>
  );
}
