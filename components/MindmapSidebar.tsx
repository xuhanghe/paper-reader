"use client";
import { useState, useRef, useEffect } from "react";
import { Mindmap, MindmapNode, ConceptEntry, Highlight } from "@/types/session";
import { isSubmitKey } from "@/lib/keys";
import { GrowingTextarea } from "./GrowingTextarea";

// How long a note entry stays lit after jumping to it from the paper
const ENTRY_FLASH_MS = 1600;

type Tab = "map" | "concepts" | "notes";

type Props = {
  mindmap: Mindmap | null | undefined;
  mindmapLoading: boolean;
  mindmapError: string | null;
  hasPdf: boolean;
  onGenerateMindmap: () => void;
  onJumpToSource: (page: number, quote: string) => void;
  // Scrolls to a highlight's own position on the page, falling back to a text
  // search when the passage isn't painted (e.g. its page hasn't rendered)
  onJumpToHighlight: (id: string, page: number | undefined, text: string) => void;
  onAskAboutNode: (text: string, question: string, page?: number) => void;
  concepts: ConceptEntry[];
  // Conversations whose summary is being written right now
  summarizingIds?: Set<string>;
  // Called when the Concepts tab comes into view, so summaries are written
  // on demand rather than after every answer
  onConceptsShown?: () => void;
  onResummarize?: (annotationId: string) => void;
  // The list is notes as much as it is a summary: the reader can rewrite a
  // line, add one, or drop one, and an edited list is left alone by the
  // automatic pass afterwards
  onEditTakeaways?: (annotationId: string, takeaways: string[]) => void;
  onSelectConcept: (annotationId: string) => void;
  highlights: Highlight[];
  onRemoveHighlight: (id: string) => void;
  // Writes the note onto the annotation itself, in Zotero. Ids are the unified
  // form: "zotero-<key>" for annotations read from Zotero, the highlight id
  // for ones this session made.
  onEditNote: (id: string, note: string) => void;
  // Set when a highlight is clicked in the paper: opens the Notes tab and
  // brings its entry into view. The counter makes repeat clicks on the same
  // highlight register as new requests.
  focusNote?: { id: string; n: number } | null;
  zoteroNotes: { key: string; html: string }[];
  zoteroAnnotations: { key: string; text: string; comment: string; page?: number; type: string }[];
  onRemoveZoteroAnnotation: (key: string) => void;
  isOpen: boolean;
  onToggle: () => void;
  width?: number;
  modelControls?: React.ReactNode;
};

// The paper text a node stands for — used as the quoted context when asking
function nodeContext(node: MindmapNode): string {
  if (node.quote) return `${node.label}: "${node.quote}"`;
  return node.note ? `${node.label} — ${node.note}` : node.label;
}

// Inline editor for the note attached to a highlighted passage
function NoteBox({ initial, onSave, onCancel }: { initial: string; onSave: (note: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="flex items-end gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
      <GrowingTextarea
        autoFocus
        value={draft}
        placeholder="Write a note — empty clears it"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) { e.preventDefault(); onSave(draft.trim()); }
          if (e.key === "Escape") onCancel();
        }}
        className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded focus:outline-none resize-none"
        style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
      />
      <button onClick={() => onSave(draft.trim())} className="btn-primary text-[11px] px-2 py-1 shrink-0">
        Save
      </button>
    </div>
  );
}

// One conversation in the Concepts list: what it established, and whatever the
// reader has since made of that.
//
// These are notes, not just output — a line can be rewritten, dropped, or added
// by hand. Once that happens the automatic pass leaves the list alone; only an
// explicit ↻ overwrites work someone did themselves.
function ConceptCard({
  concept,
  busy,
  onSelect,
  onResummarize,
  onEdit,
}: {
  concept: ConceptEntry;
  busy: boolean;
  onSelect: () => void;
  onResummarize?: () => void;
  onEdit?: (takeaways: string[]) => void;
}) {
  const lines = concept.takeaways ?? [];
  // -1 is the line being added; null is not editing at all
  const [editingAt, setEditingAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (i: number) => { setEditingAt(i); setDraft(lines[i]); };
  const startAdd = () => { setEditingAt(-1); setDraft(""); };
  const commit = () => {
    const text = draft.replace(/\s+/g, " ").trim();
    if (!onEdit) return setEditingAt(null);
    if (editingAt === -1) {
      if (text) onEdit([...lines, text]);
    } else if (editingAt !== null) {
      // An emptied line is a deleted line — the same gesture, one fewer button
      onEdit(text ? lines.map((l, i) => (i === editingAt ? text : l)) : lines.filter((_, i) => i !== editingAt));
    }
    setEditingAt(null);
  };
  const remove = (i: number) => onEdit?.(lines.filter((_, x) => x !== i));

  const editor = (
    <div className="flex items-end gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
      <GrowingTextarea
        autoFocus
        value={draft}
        placeholder={editingAt === -1 ? "Add a note…" : "Empty to remove this line"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) { e.preventDefault(); commit(); }
          if (e.key === "Escape") setEditingAt(null);
        }}
        className="flex-1 min-w-0 text-xs px-2 py-1 rounded focus:outline-none resize-none"
        style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
      />
      <button onClick={commit} className="btn-primary text-[11px] px-2 py-1 shrink-0">Save</button>
    </div>
  );

  return (
    <div
      className="rounded px-2 py-1.5 transition-colors group/concept"
      style={{ background: "rgba(230,237,243,0.03)", border: "1px solid var(--border-light)" }}
    >
      <div className="flex items-start gap-1.5">
        <span
          className="shrink-0 mt-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
          style={
            concept.type === "image"
              ? { background: "var(--badge-fig-bg)", color: "var(--badge-fig-fg)" }
              : { background: "var(--badge-text-bg)", color: "var(--badge-text-fg)" }
          }
        >
          {concept.type === "image" ? "Fig" : "Txt"}
        </span>
        <button
          onClick={onSelect}
          className="min-w-0 flex-1 text-left text-[11px] leading-tight truncate transition-opacity hover:opacity-70"
          style={{ color: "var(--ink-faint)" }}
          title={`Open this conversation\n\n${concept.label}`}
        >
          {concept.label}
        </button>
        {concept.edited && (
          <span className="shrink-0 text-[10px] mt-0.5" style={{ color: "var(--ink-faint)" }} title="Edited by you — the automatic summary leaves it alone">
            ✎
          </span>
        )}
        {onResummarize && (
          <button
            onClick={onResummarize}
            disabled={busy}
            className="btn-icon shrink-0 w-5 h-5 text-[10px] opacity-0 group-hover/concept:opacity-100 focus:opacity-100 transition-opacity"
            title={concept.edited ? "Summarise again — this replaces your edits" : "Summarise this conversation again"}
            aria-label="Summarise again"
          >
            ↻
          </button>
        )}
      </div>

      {busy && lines.length === 0 ? (
        <p className="text-[11px] mt-1 pl-1" style={{ color: "var(--ink-faint)" }}>summarising…</p>
      ) : lines.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {lines.map((line, i) =>
            editingAt === i ? (
              <li key={i}>{editor}</li>
            ) : (
              <li key={i} className="group/line flex gap-1.5 text-xs leading-snug" style={{ color: "var(--ink-muted)" }}>
                <span className="shrink-0 select-none" style={{ color: "var(--accent)" }}>·</span>
                {onEdit ? (
                  <button
                    onClick={() => startEdit(i)}
                    className="min-w-0 flex-1 text-left break-words hover:opacity-70"
                    title="Edit this note"
                  >
                    {line}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 break-words">{line}</span>
                )}
                {onEdit && (
                  <button
                    onClick={() => remove(i)}
                    className="shrink-0 text-[10px] opacity-0 group-hover/line:opacity-100 focus:opacity-100 transition-opacity"
                    style={{ color: "var(--ink-faint)" }}
                    title="Remove this line"
                    aria-label="Remove note line"
                  >
                    ✕
                  </button>
                )}
              </li>
            )
          )}
        </ul>
      ) : editingAt === null ? (
        <p className="text-[11px] mt-1 pl-1" style={{ color: "var(--ink-faint)" }}>not summarised yet</p>
      ) : null}

      {editingAt === -1 && editor}
      {onEdit && editingAt === null && (
        <button
          onClick={startAdd}
          className="mt-1 text-[10px] opacity-0 group-hover/concept:opacity-100 focus:opacity-100 transition-opacity"
          style={{ color: "var(--accent)" }}
        >
          + note
        </button>
      )}
    </div>
  );
}

function AskBox({ node, onAsk, onClose }: { node: MindmapNode; onAsk: Props["onAskAboutNode"]; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  return (
    <div className="flex items-end gap-1 px-1 pb-1.5" onClick={(e) => e.stopPropagation()}>
      <GrowingTextarea
        autoFocus
        value={question}
        placeholder={`Ask about “${node.label}”…`}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitKey(e) && question.trim()) {
            e.preventDefault();
            onAsk(nodeContext(node), question.trim(), node.page);
            onClose();
          }
          if (e.key === "Escape") onClose();
        }}
        className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded focus:outline-none resize-none"
        style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
      />
      <button
        onClick={() => {
          if (question.trim()) {
            onAsk(nodeContext(node), question.trim(), node.page);
            onClose();
          }
        }}
        className="btn-primary text-[11px] px-2 py-1 shrink-0"
      >
        Ask
      </button>
    </div>
  );
}

function SourcePin({ node, onJump }: { node: MindmapNode; onJump: Props["onJumpToSource"] }) {
  if (!node.quote || !node.page) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onJump(node.page!, node.quote!); }}
      className="shrink-0 text-[10px] px-1 rounded transition-opacity hover:opacity-70"
      style={{ color: "var(--accent)" }}
      title={`Jump to source on page ${node.page}: “${node.quote}”`}
    >
      p.{node.page} ↩
    </button>
  );
}

function NodeView({ node, depth, onJump, onAsk }: { node: MindmapNode; depth: number; onJump: Props["onJumpToSource"]; onAsk: Props["onAskAboutNode"] }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [asking, setAsking] = useState(false);
  const hasChildren = !!node.children?.length;

  const askButton = (
    <button
      onClick={(e) => { e.stopPropagation(); setAsking((v) => !v); }}
      className="shrink-0 text-[10px] px-1 rounded transition-opacity hover:opacity-70"
      style={{ color: asking ? "var(--accent)" : "var(--ink-faint)" }}
      title="Ask a question about this point"
    >
      ✦
    </button>
  );

  if (depth === 0) {
    // Stage node — a card in the paper's flow
    return (
      <div
        className="rounded-lg transition-all"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(232,120,76,0.35)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
      >
        <div
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left px-2.5 py-2 flex items-start gap-1.5 cursor-pointer select-none"
        >
          <span className="text-[10px] mt-0.5 shrink-0" style={{ color: "var(--accent)" }}>
            {hasChildren ? (expanded ? "▾" : "▸") : "•"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium leading-snug" style={{ color: "var(--ink)" }}>
              {node.label}
            </span>
            {node.note && (
              <span className="block text-[10px] leading-snug mt-0.5" style={{ color: "var(--ink-muted)" }}>
                {node.note}
              </span>
            )}
          </span>
          <SourcePin node={node} onJump={onJump} />
          {askButton}
        </div>
        {asking && <AskBox node={node} onAsk={onAsk} onClose={() => setAsking(false)} />}
        {expanded && hasChildren && (
          <div className="pb-2 pr-2 pl-4">
            {node.children!.map((child, i) => (
              <NodeView key={i} node={child} depth={depth + 1} onJump={onJump} onAsk={onAsk} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Concept node — indented row with a connector line
  return (
    <div style={{ borderLeft: "1px solid var(--border-light)" }} className="pl-2">
      <div
        onClick={() => hasChildren && setExpanded((v) => !v)}
        title={node.note}
        className={`w-full text-left flex items-start gap-1.5 px-1 py-1 rounded transition-colors select-none ${hasChildren ? "cursor-pointer" : "cursor-default"}`}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(230,237,243,0.05)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <span className="text-[9px] mt-[3px] shrink-0" style={{ color: hasChildren ? "var(--accent)" : "var(--ink-faint)" }}>
          {hasChildren ? (expanded ? "▾" : "▸") : "–"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] leading-snug" style={{ color: "var(--ink-muted)" }}>{node.label}</span>
          {expanded && node.note && (
            <span className="block text-[10px] leading-snug mt-0.5" style={{ color: "var(--ink-faint)" }}>{node.note}</span>
          )}
        </span>
        <SourcePin node={node} onJump={onJump} />
        {askButton}
      </div>
      {asking && <AskBox node={node} onAsk={onAsk} onClose={() => setAsking(false)} />}
      {expanded && hasChildren && (
        <div className="pl-2.5">
          {node.children!.map((child, i) => (
            <NodeView key={i} node={child} depth={depth + 1} onJump={onJump} onAsk={onAsk} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MindmapSidebar({
  mindmap,
  mindmapLoading,
  mindmapError,
  hasPdf,
  onGenerateMindmap,
  onJumpToSource,
  onJumpToHighlight,
  onAskAboutNode,
  concepts,
  summarizingIds,
  onConceptsShown,
  onResummarize,
  onEditTakeaways,
  onSelectConcept,
  highlights,
  onRemoveHighlight,
  onEditNote,
  focusNote,
  zoteroNotes,
  zoteroAnnotations,
  onRemoveZoteroAnnotation,
  isOpen,
  onToggle,
  width = 336,
  modelControls,
}: Props) {
  const [askingHighlightId, setAskingHighlightId] = useState<string | null>(null);
  const [highlightQuestion, setHighlightQuestion] = useState("");
  // Entry whose note is being written; clicking a card opens its editor
  const [notingId, setNotingId] = useState<string | null>(null);
  const toggleNote = (id: string) => {
    setAskingHighlightId(null);
    setNotingId((prev) => (prev === id ? null : id));
  };
  // Clicking an entry takes you to the passage in the paper and opens its note
  const openEntry = (id: string, page: number | undefined, text: string) => {
    onJumpToHighlight(id, page, text);
    toggleNote(id);
  };
  const saveNote = (id: string, note: string) => {
    onEditNote(id, note);
    setNotingId(null);
  };

  const [tab, setTab] = useState<Tab>("map");

  // Summaries are written when the list is looked at, not after every answer
  useEffect(() => {
    if (tab === "concepts") onConceptsShown?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Clicking a highlight in the paper brings its note entry into view: switch
  // to the Notes tab, wait for it to render, then scroll the entry in and
  // light it briefly.
  const entryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [flashEntry, setFlashEntry] = useState<string | null>(null);
  useEffect(() => {
    if (!focusNote) return;
    let scrollFrame = 0;
    const showFrame = requestAnimationFrame(() => {
      setTab("notes");
      // Clear first, so clicking the same highlight again restarts the pulse
      // instead of leaving the class untouched
      setFlashEntry(null);
      scrollFrame = requestAnimationFrame(() => {
        setFlashEntry(focusNote.id);
        entryRefs.current[focusNote.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    const timer = setTimeout(() => setFlashEntry(null), ENTRY_FLASH_MS);
    return () => {
      cancelAnimationFrame(showFrame);
      cancelAnimationFrame(scrollFrame);
      clearTimeout(timer);
    };
  }, [focusNote]);

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="flex flex-col items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(230,237,243,0.05)]"
        style={{ width: "2.25rem", borderLeft: "1px solid var(--border)", background: "var(--surface)" }}
        title="Show the notebook"
      >
        <span className="flex items-center justify-center h-9 w-full shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="rotate-90 text-xs" style={{ color: "var(--ink-faint)" }}>≡</span>
        </span>
        <span
          className="mt-3 text-[10px] uppercase tracking-widest select-none"
          style={{ color: "var(--ink-faint)", writingMode: "vertical-rl" }}
        >
          Notebook
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden" style={{ width: `${width}px`, minWidth: 230, borderLeft: "1px solid var(--border)", background: "var(--paper)" }}>
      {/* Tabs */}
      <div className="flex items-center h-9 shrink-0 px-1" style={{ borderBottom: "1px solid var(--border)" }}>
        {([["map", "Map"], ["concepts", "Concepts"], ["notes", "Notes"]] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="text-xs px-2.5 h-full transition-all font-medium"
            style={{
              color: tab === id ? "var(--ink)" : "var(--ink-faint)",
              boxShadow: tab === id ? "inset 0 -2px 0 var(--accent)" : "inset 0 -2px 0 transparent",
              background: tab === id ? "linear-gradient(180deg, transparent 60%, rgba(232,120,76,0.07))" : "transparent",
            }}
          >
            {label}
            {id === "concepts" && concepts.length > 0 && (
              <span
                className="ml-1.5 text-[9px] px-1 py-px rounded-full tabular-nums align-middle"
                style={{ color: "var(--ink-muted)", background: "rgba(230,237,243,0.07)" }}
              >{concepts.length}</span>
            )}
            {id === "notes" && highlights.length + zoteroNotes.length + zoteroAnnotations.length > 0 && (
              <span
                className="ml-1.5 text-[9px] px-1 py-px rounded-full tabular-nums align-middle"
                style={{ color: "var(--ink-muted)", background: "rgba(230,237,243,0.07)" }}
              >{highlights.length + zoteroNotes.length + zoteroAnnotations.length}</span>
            )}
          </button>
        ))}
        <button
          onClick={onToggle}
          className="btn-icon ml-auto w-6 h-6 text-xs mr-1"
          title="Collapse"
        >
          ›
        </button>
      </div>

      {/* Map tab */}
      {tab === "map" && (
        <div className="flex-1 overflow-y-auto p-3">
          {modelControls && (
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>Map model</span>
              {modelControls}
            </div>
          )}
          {!hasPdf && (
            <p className="text-xs text-center mt-6 px-3" style={{ color: "var(--ink-faint)" }}>
              Open a PDF to map the paper&apos;s flow
            </p>
          )}

          {hasPdf && !mindmap && !mindmapLoading && (
            <div className="flex flex-col items-center gap-3 mt-6 px-3">
              <p className="text-xs text-center leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                Generate a map of the paper&apos;s flow — its stages and the key concepts in each.
              </p>
              <button onClick={onGenerateMindmap} className="btn-primary text-xs px-4 py-1.5">
                ✦ Generate paper map
              </button>
            </div>
          )}

          {mindmapLoading && (
            <div className="flex flex-col items-center gap-2 mt-8">
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:0ms]" style={{ background: "var(--accent)" }} />
                <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:150ms]" style={{ background: "var(--accent)" }} />
                <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:300ms]" style={{ background: "var(--accent)" }} />
              </span>
              <p className="text-xs" style={{ color: "var(--ink-faint)" }}>Reading the paper…</p>
            </div>
          )}

          {mindmapError && !mindmapLoading && (
            <div className="mt-3 px-3 py-2.5 rounded text-xs leading-relaxed" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", color: "#F87171" }}>
              {mindmapError}
            </div>
          )}

          {mindmap && !mindmapLoading && (
            <div>
              {/* Root: paper title */}
              <div className="rounded px-3 py-2 mb-1" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent)" }}>
                <p className="text-xs font-semibold leading-snug" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
                  {mindmap.title}
                </p>
              </div>

              {/* Flow: stage cards connected vertically */}
              {mindmap.children.map((stage, i) => (
                <div key={i}>
                  <div className="flex justify-center py-0.5">
                    <span className="text-[10px] leading-none" style={{ color: "var(--ink-faint)" }}>↓</span>
                  </div>
                  <NodeView node={stage} depth={0} onJump={onJumpToSource} onAsk={onAskAboutNode} />
                </div>
              ))}

              <div className="flex justify-center mt-3">
                <button onClick={onGenerateMindmap} className="btn-ghost text-[11px] px-3 py-1">
                  ↻ Regenerate
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Notes tab — highlights and notes, quotable into the Ask panel */}
      {tab === "notes" && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {/* Notes stored on the item in Zotero */}
          {zoteroNotes.length > 0 && (
            <div className="space-y-1.5 mb-2">
              <p className="text-[10px] uppercase tracking-widest px-1" style={{ color: "var(--ink-faint)" }}>
                Zotero notes
              </p>
              {zoteroNotes.map((n) => {
                const plain = n.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                const askId = `zn:${n.key}`;
                return (
                  <div
                    key={n.key}
                    className="rounded px-2 py-1.5"
                    style={{ background: "var(--surface)", border: "1px solid var(--border-light)", borderLeft: "2px solid var(--badge-fig-fg)" }}
                  >
                    <div
                      className="text-[11px] leading-snug zotero-note-html"
                      style={{ color: "var(--ink-muted)" }}
                      dangerouslySetInnerHTML={{ __html: n.html }}
                      onClick={(e) => {
                        // Quotes in Zotero notes carry a data-annotation payload
                        // linking back to the PDF position — make them jumpable
                        const el = (e.target as HTMLElement).closest("span.highlight[data-annotation]");
                        if (!el) return;
                        try {
                          const meta = JSON.parse(decodeURIComponent(el.getAttribute("data-annotation")!));
                          const pos = typeof meta.position === "string" ? JSON.parse(meta.position) : meta.position;
                          const page = typeof pos?.pageIndex === "number" ? pos.pageIndex + 1 : 1;
                          const quote = (el.textContent || "").replace(/^[“"]|[”"]$/g, "").trim();
                          if (quote) onJumpToSource(page, quote);
                        } catch {
                          // annotation payload unreadable — ignore the click
                        }
                      }}
                    />
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        onClick={() => {
                          setAskingHighlightId(askingHighlightId === askId ? null : askId);
                          setHighlightQuestion("");
                        }}
                        className="text-[10px] transition-opacity hover:opacity-70"
                        style={{ color: askingHighlightId === askId ? "var(--accent)" : "var(--ink-faint)" }}
                        title="Ask about this note"
                      >
                        ✦ ask
                      </button>
                    </div>
                    {askingHighlightId === askId && (
                      <div className="flex items-end gap-1 mt-1.5">
                        <GrowingTextarea
                          autoFocus
                          value={highlightQuestion}
                          placeholder="Ask about this note…"
                          onChange={(e) => setHighlightQuestion(e.target.value)}
                          onKeyDown={(e) => {
                            if (isSubmitKey(e) && highlightQuestion.trim()) {
                              e.preventDefault();
                              onAskAboutNode(`My Zotero note on this paper: ${plain.slice(0, 800)}`, highlightQuestion.trim());
                              setAskingHighlightId(null);
                            }
                            if (e.key === "Escape") setAskingHighlightId(null);
                          }}
                          className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded focus:outline-none resize-none"
                          style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
                        />
                        <button
                          onClick={() => {
                            if (highlightQuestion.trim()) {
                              onAskAboutNode(`My Zotero note on this paper: ${plain.slice(0, 800)}`, highlightQuestion.trim());
                              setAskingHighlightId(null);
                            }
                          }}
                          className="btn-primary text-[11px] px-2 py-1 shrink-0"
                        >
                          Ask
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Highlights made in Zotero's own PDF reader */}
          {zoteroAnnotations.length > 0 && (
            <div className="space-y-1.5 mb-2">
              <p className="text-[10px] uppercase tracking-widest px-1" style={{ color: "var(--ink-faint)" }}>
                Zotero PDF annotations
              </p>
              {zoteroAnnotations.map((a) => (
                <div
                  key={a.key}
                  ref={(el) => { entryRefs.current[`zotero-${a.key}`] = el; }}
                  onClick={() => openEntry(`zotero-${a.key}`, a.page, a.text)}
                  className={`rounded px-2 py-1.5 cursor-pointer transition-colors${flashEntry === `zotero-${a.key}` ? " pr-entry-flash" : ""}`}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border-light)",
                    borderLeft: `2px solid ${notingId === `zotero-${a.key}` ? "var(--accent)" : "var(--badge-fig-fg)"}`,
                  }}
                  title="Click to jump to this passage and write a note on it"
                >
                  {a.text && (
                    <p className="text-[11px] leading-snug" style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-mono), monospace" }}>
                      “{a.text.length > 140 ? a.text.slice(0, 140) + "…" : a.text}”
                    </p>
                  )}
                  {a.comment && (
                    <p className="text-[11px] leading-snug mt-1" style={{ color: "var(--ink)" }}>✎ {a.comment}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {a.page && a.text && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onJumpToSource(a.page!, a.text); }}
                        className="text-[10px] transition-opacity hover:opacity-70"
                        style={{ color: "var(--accent)" }}
                        title="Jump to this passage in the PDF"
                      >
                        p.{a.page} ↩
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleNote(`zotero-${a.key}`); }}
                      className="text-[10px] transition-opacity hover:opacity-70"
                      style={{ color: notingId === `zotero-${a.key}` ? "var(--accent)" : "var(--ink-faint)" }}
                      title="Write a note on this passage (saved to Zotero)"
                    >
                      ✎ {a.comment ? "edit note" : "note"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setNotingId(null);
                        setAskingHighlightId(askingHighlightId === `za:${a.key}` ? null : `za:${a.key}`);
                        setHighlightQuestion("");
                      }}
                      className="text-[10px] transition-opacity hover:opacity-70"
                      style={{ color: askingHighlightId === `za:${a.key}` ? "var(--accent)" : "var(--ink-faint)" }}
                      title="Ask about this annotation"
                    >
                      ✦ ask
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemoveZoteroAnnotation(a.key); }}
                      className="ml-auto text-[10px] transition-opacity hover:opacity-70"
                      style={{ color: "var(--ink-faint)" }}
                      title="Delete this annotation (also removes it from Zotero)"
                    >
                      ✕
                    </button>
                  </div>
                  {notingId === `zotero-${a.key}` && (
                    <NoteBox
                      key={a.key}
                      initial={a.comment || ""}
                      onSave={(note) => saveNote(`zotero-${a.key}`, note)}
                      onCancel={() => setNotingId(null)}
                    />
                  )}
                  {askingHighlightId === `za:${a.key}` && (
                    <div className="flex items-end gap-1 mt-1.5">
                      <GrowingTextarea
                        autoFocus
                        value={highlightQuestion}
                        placeholder="Ask about this passage…"
                        onChange={(e) => setHighlightQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          if (isSubmitKey(e) && highlightQuestion.trim()) {
                            e.preventDefault();
                            onAskAboutNode(a.comment ? `${a.text}\n\nMy Zotero annotation: ${a.comment}` : a.text, highlightQuestion.trim(), a.page);
                            setAskingHighlightId(null);
                          }
                          if (e.key === "Escape") setAskingHighlightId(null);
                        }}
                        className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded focus:outline-none resize-none"
                        style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
                      />
                      <button
                        onClick={() => {
                          if (highlightQuestion.trim()) {
                            onAskAboutNode(a.comment ? `${a.text}\n\nMy Zotero annotation: ${a.comment}` : a.text, highlightQuestion.trim(), a.page);
                            setAskingHighlightId(null);
                          }
                        }}
                        className="btn-primary text-[11px] px-2 py-1 shrink-0"
                      >
                        Ask
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {highlights.length === 0 && zoteroNotes.length === 0 && zoteroAnnotations.length === 0 && (
            <p className="text-xs text-center mt-4 px-3 leading-relaxed" style={{ color: "var(--ink-faint)" }}>
              Select text in the paper and choose <span style={{ color: "var(--badge-text-fg)" }}>🖍 Highlight</span> or <span style={{ color: "var(--ink-muted)" }}>✎ Note</span> — they&apos;ll be saved here
            </p>
          )}
          {highlights.map((h) => (
            <div
              key={h.id}
              ref={(el) => { entryRefs.current[h.id] = el; }}
              onClick={() => openEntry(h.id, h.pageNumber, h.text)}
              className={`rounded px-2 py-1.5 cursor-pointer transition-colors${flashEntry === h.id ? " pr-entry-flash" : ""}`}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border-light)",
                borderLeft: h.note || notingId === h.id ? "2px solid var(--accent)" : "2px solid var(--badge-text-fg)",
              }}
              title="Click to jump to this passage and write a note on it"
            >
              <p className="text-[11px] leading-snug" style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-mono), monospace" }}>
                “{h.text.length > 140 ? h.text.slice(0, 140) + "…" : h.text}”
              </p>
              {h.note && (
                <p className="text-[11px] leading-snug mt-1" style={{ color: "var(--ink)" }}>
                  ✎ {h.note}
                </p>
              )}
              <div className="flex items-center gap-2 mt-1">
                {h.pageNumber && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onJumpToSource(h.pageNumber!, h.text); }}
                    className="text-[10px] transition-opacity hover:opacity-70"
                    style={{ color: "var(--accent)" }}
                    title="Jump to this passage"
                  >
                    p.{h.pageNumber} ↩
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleNote(h.id); }}
                  className="text-[10px] transition-opacity hover:opacity-70"
                  style={{ color: notingId === h.id ? "var(--accent)" : "var(--ink-faint)" }}
                  title="Write a note on this passage (saved to Zotero)"
                >
                  ✎ {h.note ? "edit note" : "note"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setNotingId(null);
                    setAskingHighlightId(askingHighlightId === h.id ? null : h.id);
                    setHighlightQuestion("");
                  }}
                  className="text-[10px] transition-opacity hover:opacity-70"
                  style={{ color: askingHighlightId === h.id ? "var(--accent)" : "var(--ink-faint)" }}
                  title="Ask about this passage"
                >
                  ✦ ask
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveHighlight(h.id); }}
                  className="ml-auto text-[10px] transition-opacity hover:opacity-70"
                  style={{ color: "var(--ink-faint)" }}
                  title="Remove highlight"
                >
                  ✕
                </button>
              </div>
              {notingId === h.id && (
                <NoteBox
                  key={h.id}
                  initial={h.note || ""}
                  onSave={(note) => saveNote(h.id, note)}
                  onCancel={() => setNotingId(null)}
                />
              )}
              {askingHighlightId === h.id && (
                <div className="flex items-end gap-1 mt-1.5">
                  <GrowingTextarea
                    autoFocus
                    value={highlightQuestion}
                    placeholder="Ask about this passage…"
                    onChange={(e) => setHighlightQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (isSubmitKey(e) && highlightQuestion.trim()) {
                        e.preventDefault();
                        onAskAboutNode(h.note ? `${h.text}\n\nMy note: ${h.note}` : h.text, highlightQuestion.trim(), h.pageNumber);
                        setAskingHighlightId(null);
                      }
                      if (e.key === "Escape") setAskingHighlightId(null);
                    }}
                    className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded focus:outline-none resize-none"
                    style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
                  />
                  <button
                    onClick={() => {
                      if (highlightQuestion.trim()) {
                        onAskAboutNode(h.note ? `${h.text}\n\nMy note: ${h.note}` : h.text, highlightQuestion.trim(), h.pageNumber);
                        setAskingHighlightId(null);
                      }
                    }}
                    className="btn-primary text-[11px] px-2 py-1 shrink-0"
                  >
                    Ask
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Concepts tab — what each conversation established, and your own notes on it */}
      {tab === "concepts" && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {concepts.length === 0 && (
            <p className="text-xs text-center mt-4 px-2" style={{ color: "var(--ink-faint)" }}>
              What you work out in the Ask panel is summarised here
            </p>
          )}
          {concepts.map((c) => (
            <ConceptCard
              key={c.annotationId}
              concept={c}
              busy={summarizingIds?.has(c.annotationId) ?? false}
              onSelect={() => onSelectConcept(c.annotationId)}
              onResummarize={onResummarize ? () => onResummarize(c.annotationId) : undefined}
              onEdit={onEditTakeaways ? (lines) => onEditTakeaways(c.annotationId, lines) : undefined}
            />
          ))}
        </div>
      )}

    </div>
  );
}
