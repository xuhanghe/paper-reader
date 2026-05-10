"use client";
import { useRef, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Annotation, Model } from "@/types/session";

type Props = {
  annotations: Annotation[];
  activeId: string | null;
  model: Model;
  streamingIds: Set<string>;
  onFollowUp: (annotationId: string, question: string) => void;
  onDelete: (annotationId: string) => void;
  onReExplainImage: (annotationId: string) => void;
  onViewInPdf: (annotationId: string) => void;
  annotationRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
};

function ImageLightbox({
  src,
  onClose,
  onExplain,
}: {
  src: string;
  onClose: () => void;
  onExplain?: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: "rgba(28,25,23,0.75)" }}
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt="captured figure"
          className="max-w-full max-h-[80vh] object-contain"
          style={{ borderRadius: "4px", boxShadow: "0 8px 40px rgba(28,25,23,0.5)" }}
        />
        <div className="flex items-center gap-3">
          {onExplain && (
            <button
              onClick={() => { onExplain(); onClose(); }}
              className="btn-primary flex items-center gap-1.5 text-sm px-4 py-2"
            >
              ✦ Explain with AI
            </button>
          )}
          <button
            onClick={onClose}
            className="text-sm px-3 py-2 transition-opacity hover:opacity-70"
            style={{ color: "rgba(250,248,245,0.6)" }}
          >
            Close
          </button>
        </div>
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-7 h-7 rounded-full flex items-center justify-center text-sm font-medium"
          style={{ background: "var(--paper)", color: "var(--ink-muted)", boxShadow: "0 2px 8px rgba(28,25,23,0.2)" }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20];
const DEFAULT_FONT_IDX = 2; // 14px
const COLLAPSE_CHARS = 300;

export function ExplainPanel({ annotations, activeId, model, streamingIds, onFollowUp, onDelete, onReExplainImage, onViewInPdf, annotationRefs }: Props) {
  const [followUpText, setFollowUpText] = useState<Record<string, string>>({});
  const [lightboxState, setLightboxState] = useState<{ src: string; annotationId: string } | null>(null);
  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());
  const [fontIdx, setFontIdx] = useState(DEFAULT_FONT_IDX);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fontSize = FONT_SIZES[fontIdx];
  const canIncrease = fontIdx < FONT_SIZES.length - 1;
  const canDecrease = fontIdx > 0;

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setFontIdx((i) => e.deltaY < 0
        ? Math.min(FONT_SIZES.length - 1, i + 1)
        : Math.max(0, i - 1)
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (activeId && annotationRefs.current[activeId]) {
      annotationRefs.current[activeId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [activeId, annotationRefs]);

  const toolbar = (
    <div className="shrink-0 flex items-center gap-1 px-3 py-1.5" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
      <span className="text-[10px] uppercase tracking-widest mr-1" style={{ color: "var(--ink-faint)" }}>Text</span>
      <button
        onClick={() => setFontIdx((i) => Math.max(0, i - 1))}
        disabled={!canDecrease}
        className="btn-icon w-7 h-7 text-base leading-none"
        title="Smaller text (Ctrl+scroll)"
      >−</button>
      <button
        onClick={() => setFontIdx(DEFAULT_FONT_IDX)}
        className="btn-icon px-2 py-0.5 text-xs min-w-[44px] text-center tabular-nums"
        title="Reset text size"
      >
        {fontSize}px
      </button>
      <button
        onClick={() => setFontIdx((i) => Math.min(FONT_SIZES.length - 1, i + 1))}
        disabled={!canIncrease}
        className="btn-icon w-7 h-7 text-base leading-none"
        title="Larger text (Ctrl+scroll)"
      >+</button>
    </div>
  );

  if (annotations.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
        {toolbar}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--ink-faint)" }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <p className="text-sm text-center" style={{ color: "var(--ink-muted)" }}>
            Select text in the PDF and click <span style={{ color: "var(--ink)" }}>Explain this ↗</span>
          </p>
          <p className="text-xs text-center" style={{ color: "var(--ink-faint)" }}>
            Hold <kbd className="px-1 rounded text-[11px]" style={{ background: "var(--border)", color: "var(--ink-muted)" }}>Alt</kbd> and drag to capture a figure or graph
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
      {toolbar}

      {lightboxState && (
        <ImageLightbox
          src={lightboxState.src}
          onClose={() => setLightboxState(null)}
          onExplain={() => onReExplainImage(lightboxState.annotationId)}
        />
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4" style={{ fontSize }}>
        {annotations.map((annotation) => {
          const isActive = annotation.id === activeId;
          return (
            <div
              key={annotation.id}
              ref={(el) => { annotationRefs.current[annotation.id] = el; }}
              className="rounded overflow-hidden transition-all"
              style={{
                background: "var(--surface)",
                border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                boxShadow: isActive ? "0 0 0 1px var(--accent), 0 4px 20px rgba(232,120,76,0.15)" : "none",
              }}
            >
              {/* Card header */}
              <div className="flex items-center gap-2 px-3 py-2" style={{ background: "var(--surface)", borderBottom: "1px solid var(--border-light)" }}>
                <span
                  className="shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded"
                  style={
                    annotation.type === "image"
                      ? { background: "var(--badge-fig-bg)", color: "var(--badge-fig-fg)" }
                      : { background: "var(--badge-text-bg)", color: "var(--badge-text-fg)" }
                  }
                >
                  {annotation.type === "image" ? "Figure" : "Text"}
                </span>

                {annotation.type === "image" && annotation.imageDataUrl ? (
                  <button
                    onClick={() => setLightboxState({ src: annotation.imageDataUrl!, annotationId: annotation.id })}
                    className="group flex items-center gap-1.5 transition-opacity hover:opacity-70"
                    title="Click to view full size"
                  >
                    <img
                      src={annotation.imageDataUrl}
                      alt="captured region"
                      className="max-h-9 object-contain opacity-90"
                      style={{ border: "1px solid var(--border)", borderRadius: "2px", filter: "brightness(0.9)" }}
                    />
                    <span className="text-[10px]" style={{ color: "var(--ink-faint)" }}>view ↗</span>
                  </button>
                ) : (
                  <span className="text-xs flex-1 min-w-0 truncate" style={{ color: "var(--ink-faint)" }}>
                    {annotation.label}
                  </span>
                )}

                <button
                  onClick={() => onDelete(annotation.id)}
                  className="btn-icon ml-auto shrink-0 w-6 h-6 text-xs"
                  title="Delete this annotation"
                >
                  ✕
                </button>
              </div>

              {/* Selected text block — text annotations only */}
              {annotation.type === "text" && annotation.selectedText && (() => {
                const text = annotation.selectedText;
                const long = text.length > COLLAPSE_CHARS;
                const expanded = expandedText.has(annotation.id);
                const shown = long && !expanded ? text.slice(0, COLLAPSE_CHARS) + "…" : text;
                const canJump = !!annotation.pageNumber;
                return (
                  <div className="mx-4 mt-3 mb-1 rounded overflow-hidden" style={{ background: "var(--border-light)", borderLeft: "2px solid var(--border)" }}>
                    <div className="flex items-center justify-between px-3 pt-2 pb-1">
                      <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>Selected text</p>
                      {canJump && (
                        <button
                          onClick={() => onViewInPdf(annotation.id)}
                          className="text-[10px] transition-opacity hover:opacity-70 flex items-center gap-1"
                          style={{ color: "var(--accent)" }}
                          title="Jump to this text in the PDF"
                        >
                          view in PDF ↩
                        </button>
                      )}
                    </div>
                    <p className="px-3 pb-2 text-xs leading-relaxed whitespace-pre-wrap" style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-mono), monospace" }}>
                      {shown}
                    </p>
                    {long && (
                      <button
                        className="px-3 pb-2 text-[10px] transition-opacity hover:opacity-70 block"
                        style={{ color: "var(--accent)" }}
                        onClick={() => setExpandedText((s) => {
                          const next = new Set(s);
                          expanded ? next.delete(annotation.id) : next.add(annotation.id);
                          return next;
                        })}
                      >
                        {expanded ? "show less ↑" : "show more ↓"}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Streaming indicator */}
              {streamingIds.has(annotation.id) && (
                <div className="px-4 pt-3 flex items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}>
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:0ms]" style={{ background: "var(--accent)" }} />
                    <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:150ms]" style={{ background: "var(--accent)" }} />
                    <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:300ms]" style={{ background: "var(--accent)" }} />
                  </span>
                  Thinking…
                </div>
              )}

              {/* Messages */}
              <div className="px-4 pt-3 pb-2 space-y-3">
                {annotation.messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const isFollowUp = isUser && i > 0;
                  return (
                    <div key={i} className={isFollowUp ? "pt-3" : ""} style={isFollowUp ? { borderTop: "1px solid var(--border-light)" } : {}}>
                      <p className="text-[10px] font-semibold mb-1 tracking-wide uppercase" style={{ color: isUser ? "var(--ink-faint)" : "var(--accent)" }}>
                        {isUser ? "you" : "explainer"}
                      </p>

                      {isUser ? (
                        <p style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>{msg.content}</p>
                      ) : (
                        <div className="prose-paper">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content || (streamingIds.has(annotation.id) ? "" : "▌")}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Follow-up */}
              <div className="px-4 pb-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Ask a follow-up…"
                    value={followUpText[annotation.id] || ""}
                    onChange={(e) =>
                      setFollowUpText((prev) => ({ ...prev, [annotation.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && followUpText[annotation.id]?.trim()) {
                        onFollowUp(annotation.id, followUpText[annotation.id].trim());
                        setFollowUpText((prev) => ({ ...prev, [annotation.id]: "" }));
                      }
                    }}
                    className="flex-1 text-sm px-3 py-1.5 rounded focus:outline-none transition-colors"
                    style={{
                      border: "1px solid var(--border)",
                      background: "var(--paper)",
                      color: "var(--ink)",
                      fontFamily: "var(--font-geist-mono), monospace",
                      fontSize: "0.8em",
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                    onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                  />
                  <button
                    onClick={() => {
                      if (followUpText[annotation.id]?.trim()) {
                        onFollowUp(annotation.id, followUpText[annotation.id].trim());
                        setFollowUpText((prev) => ({ ...prev, [annotation.id]: "" }));
                      }
                    }}
                    className="btn-primary text-sm px-3 py-1.5"
                  >
                    Ask
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
