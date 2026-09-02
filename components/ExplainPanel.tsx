"use client";
import { useRef, useEffect, useLayoutEffect, useMemo, useState, memo, useImperativeHandle } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Annotation, Model } from "@/types/session";
import { isSubmitKey } from "@/lib/keys";
import { loadPanelScroll, savePanelScroll } from "@/lib/panel-scroll";
import { withQuotes, quotePreview, quoteLabel, parseQuotes, addQuote as pushQuote, type Quote, type QuotedPassage } from "@/lib/quotes";
import { clearMarks, markTextInContainer } from "@/lib/highlight-dom";
import { parseCitation, citationLabel } from "@/lib/citations";
import { GrowingTextarea } from "./GrowingTextarea";

type Props = {
  annotations: Annotation[];
  activeId: string | null;
  model: Model;
  streamingIds: Set<string>;
  onFollowUp: (annotationId: string, question: string, imageDataUrl?: string) => void;
  // Cancel the answer being streamed into a conversation
  onStop?: (annotationId: string) => void;
  // Rewrite a question already asked and send it again
  onEditMessage?: (annotationId: string, index: number, text: string) => void;
  onAskGeneral: (question: string, imageDataUrl?: string, reference?: { key: string; title: string }, webSearch?: boolean) => void;
  onDelete: (annotationId: string) => void;
  onReExplainImage: (annotationId: string) => void;
  onViewInPdf: (annotationId: string) => void;
  // Land on a passage the model cited, by page and verbatim text. The third
  // argument is the conversation the citation was written in, so the passage
  // can be marked on the page as belonging to that answer.
  onCitePaper?: (page: number, quote: string, fromAnnotationId?: string) => void;
  annotationRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  // Filled in with how to read and restore this pane's scroll, for going back
  // to where a jump started
  scrollHandle?: React.Ref<PanelScroll>;
  // Undoing a jump, and redoing it
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  isOpen: boolean;
  onToggle: () => void;
  width?: number;
  modelControls?: React.ReactNode;
  // Identity to remember the list's scroll offset against — the open paper.
  // Absent means nothing is remembered.
  positionKey?: string;
};

// ── Citations the model writes ──────────────────────────────────────
// The model links what it is drawing on: `paper:12` for a passage, `turn:7`
// for something already settled in this conversation. Both become jumps;
// anything else it links to stays an ordinary link.
//
// The handlers arrive through a ref rather than as props so this component's
// identity is stable across renders — recreating it on every streaming chunk
// would remount every citation in the answer, taking the reader's selection
// with it.
// react-markdown drops link protocols it does not recognise — a safe default,
// and it silently emptied the href of every citation the model wrote. The two
// private schemes are allowed through by name; everything else still goes
// through the sanitiser.
const citationUrlTransform = (url: string): string =>
  parseCitation(url) ? url : defaultUrlTransform(url);

// How the page reads and restores this pane's scroll, for going back to where
// a jump started
export type PanelScroll = { get: () => number; set: (top: number) => void };

type MarkdownComponents = {
  a: (props: { href?: string; children?: React.ReactNode }) => React.ReactElement;
};

// Click-time behaviour, read from a ref when a citation is actually clicked.
// What has to be decided while rendering — whether the target exists at all —
// arrives as a plain prop, so nothing reads a ref during render.
type CiteHandlers = {
  paper?: (page: number, quote: string, fromAnnotationId?: string) => void;
  turn?: (turn: number) => void;
};

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: React.ReactNode } };
  return el.props?.children === undefined ? "" : textOf(el.props.children);
}

function CitationAnchor({
  href,
  children,
  cite,
  knownTurns,
  canJumpToPaper,
}: {
  href?: string;
  children?: React.ReactNode;
  cite: React.RefObject<CiteHandlers>;
  knownTurns: Set<number>;
  canJumpToPaper: boolean;
}) {
  const citation = parseCitation(href);
  if (!citation) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>
        {children}
      </a>
    );
  }

  const raw = textOf(children);
  const label = citationLabel(raw) || raw;

  if (citation.kind === "turn") {
    // A number that points at nothing reads as plain words rather than as a
    // link that goes nowhere — the model does sometimes invent one
    if (!knownTurns.has(citation.turn)) return <span>{label}</span>;
    return (
      <button
        type="button"
        onClick={() => cite.current.turn?.(citation.turn)}
        className="pr-cite pr-cite-turn"
        title={`Go back to turn ${citation.turn} of this conversation`}
      >
        {label}
        <span className="pr-cite-tag">↩{citation.turn}</span>
      </button>
    );
  }

  if (!canJumpToPaper) return <span>{label}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Which conversation this citation was written in — read off the card
        // rather than threaded through props, which would break the memo that
        // keeps answers from re-rendering as they stream
        const card = (e.currentTarget as HTMLElement).closest("[data-annotation-id]") as HTMLElement | null;
        cite.current.paper?.(citation.page, raw, card?.dataset.annotationId);
      }}
      className="pr-cite pr-cite-paper"
      title={`Find this passage on page ${citation.page}`}
    >
      {label}
      <span className="pr-cite-tag">p{citation.page}</span>
    </button>
  );
}

// An answer, re-rendered only when its own text changes.
//
// Markdown is parsed from scratch on every render — remark, rehype and a fresh
// React tree — so without this, one keystroke in the follow-up box re-parsed
// every answer on screen. Typing lagged in proportion to how much had been
// said, which is exactly backwards.
//
// The plugin list is module-level for the same reason: a new array each render
// is a new prop, and nothing downstream can memoise past it.
const REMARK_PLUGINS = [remarkGfm];

const Answer = memo(function Answer({
  content,
  components,
}: {
  content: string;
  components: MarkdownComponents;
}) {
  return (
    <div className="prose-paper">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={citationUrlTransform}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

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
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm pr-backdrop"
      style={{ background: "rgba(1,4,9,0.75)" }}
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3 pr-modal-pop" onClick={(e) => e.stopPropagation()}>
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
const DEFAULT_FONT_IDX = 3; // 15px
const COLLAPSE_CHARS = 300;

export function ExplainPanel({ annotations, activeId, model, streamingIds, onFollowUp, onStop, onEditMessage, onAskGeneral, onDelete, onReExplainImage, onViewInPdf, onCitePaper, annotationRefs, scrollHandle, canGoBack, canGoForward, onGoBack, onGoForward, isOpen, onToggle, width = 460, modelControls, positionKey }: Props) {
  const [followUpText, setFollowUpText] = useState<Record<string, string>>({});
  const [generalQuestion, setGeneralQuestion] = useState("");
  const [composerImage, setComposerImage] = useState<string | null>(null);
  const [composerRef, setComposerRef] = useState<{ key: string; title: string } | null>(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refQuery, setRefQuery] = useState("");
  const [refResults, setRefResults] = useState<{ key: string; title: string }[]>([]);
  const refSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchLibrary = (q: string) => {
    setRefQuery(q);
    if (refSearchTimer.current) clearTimeout(refSearchTimer.current);
    refSearchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/zotero/items?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (res.ok) setRefResults(data.items.slice(0, 12));
      } catch {
        setRefResults([]);
      }
    }, 300);
  };

  const readImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setComposerImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const submitGeneral = () => {
    if (!generalQuestion.trim()) return;
    onAskGeneral(withQuotes(generalQuestion.trim(), quotes), composerImage || undefined, composerRef || undefined, true);
    setQuotes([]);
    setGeneralQuestion("");
    setComposerImage(null);
    setComposerRef(null);
    setRefPickerOpen(false);
  };
  const [followUpImage, setFollowUpImage] = useState<Record<string, string>>({});
  const [lightboxState, setLightboxState] = useState<{ src: string; annotationId: string } | null>(null);
  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  // Which question is being rewritten, and its working text
  const [editing, setEditing] = useState<{ id: string; index: number; quotes: QuotedPassage[] } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Passages lifted out of the conversations, waiting to be quoted into the
  // next question — wherever it is asked
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [pendingQuote, setPendingQuote] = useState<{ text: string; source?: string; top: number; left: number } | null>(null);
  // The box last typed in, so clicking a quote drops its label at the cursor
  // rather than making the reader remember which number was which
  const lastBox = useRef<{
    el: HTMLInputElement | HTMLTextAreaElement;
    setText: (update: (current: string) => string) => void;
  } | null>(null);
  const [fontIdx, setFontIdx] = useState(DEFAULT_FONT_IDX);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const toggleCollapsed = (id: string) =>
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Sending an edit closes the editor; the panel then shows the rewritten
  // question with a fresh answer streaming under it
  const resendEdit = (annotationId: string) => {
    if (!editing || !editDraft.trim()) return;
    // The editor shows the question alone; the passages it carried are put
    // back, so rewording a question never silently drops what it pointed at
    const restored = withQuotes(
      editDraft.trim(),
      editing.quotes.map((q, n) => ({ id: String(n), text: q.text, source: q.source }))
    );
    onEditMessage?.(annotationId, editing.index, restored);
    setEditing(null);
  };

  const allCollapsed = annotations.length > 0 && annotations.every((a) => collapsedIds.has(a.id));
  const toggleAll = () =>
    setCollapsedIds(allCollapsed ? new Set() : new Set(annotations.map((a) => a.id)));

  const fontSize = FONT_SIZES[fontIdx];
  const canIncrease = fontIdx < FONT_SIZES.length - 1;
  const canDecrease = fontIdx > 0;

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The scrolling list is behind two early returns — a closed panel and an
    // empty one — so on first mount this ref is null. The panel starts closed,
    // which meant these listeners were never attached at all.
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
  }, [isOpen, annotations.length]);

  // Land where the conversation was left. The list unmounts when the panel
  // collapses to its rail and when the reader crosses to the Workspace, and a
  // fresh mount starts at the top; the offset is remembered per paper instead.
  // Restored once per paper per mount of the list (the effect also re-runs as
  // conversations are added, which must not yank the reader back), and saved
  // while scrolling and at teardown so the last position wins.
  const restoredScrollFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const key = positionKey;
    if (!el || !key) return;
    if (restoredScrollFor.current !== key) {
      restoredScrollFor.current = key;
      const top = loadPanelScroll(key);
      // One frame later: the list has to lay out before it can be scrolled
      if (top !== null) requestAnimationFrame(() => { if (el.isConnected) el.scrollTop = top; });
    }
    let timer = 0;
    // The offset as last seen while the list was still in the document. By
    // the time the cleanup runs on collapse or unmount the element has been
    // detached, and a detached element reports a scrollTop of 0.
    let last = el.scrollTop;
    const onScroll = () => {
      last = el.scrollTop;
      clearTimeout(timer);
      timer = window.setTimeout(() => savePanelScroll(key, last), 300);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
      savePanelScroll(key, el.isConnected ? el.scrollTop : last);
      // Once the list is gone, the next one must restore again
      if (!el.isConnected) restoredScrollFor.current = null;
    };
  }, [isOpen, annotations.length, positionKey]);

  // Whatever becomes active is about to be answered or jumped to, so a folded
  // card opens itself rather than leaving the reply hidden behind a chevron.
  // Adjusted as the selection changes rather than in an effect: an effect would
  // paint the card folded first, then cascade a second render to unfold it.
  const [lastActive, setLastActive] = useState<string | null>(activeId);
  if (activeId !== lastActive) {
    setLastActive(activeId);
    if (activeId && collapsedIds.has(activeId)) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(activeId);
        return next;
      });
    }
  }

  // Selecting inside a conversation offers to quote it. Scoped to the list, so
  // selecting in the composer or the paper does not trigger it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMouseUp = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      const text = sel?.toString() ?? "";
      if (!sel || sel.isCollapsed || !text.trim()) {
        setPendingQuote(null);
        return;
      }
      const anchor = sel.anchorNode;
      const within = anchor && (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement)?.closest?.("[data-conversation]");
      if (!within || !el.contains(within)) {
        setPendingQuote(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPendingQuote({
        text,
        source: (within as HTMLElement).dataset.conversation || undefined,
        top: rect.bottom + 6,
        left: rect.left + rect.width / 2,
      });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [isOpen, annotations.length]);

  const addQuote = () => {
    if (!pendingQuote) return;
    setQuotes((prev) =>
      pushQuote(prev, {
        id: `${Date.now()}-${prev.length}`,
        text: pendingQuote.text.trim(),
        source: pendingQuote.source,
      })
    );
    setPendingQuote(null);
    window.getSelection()?.removeAllRanges();
  };

  // Put "[2]" where the cursor is, or at the end of whichever box the reader
  // would type in if they have not touched one yet — clicking a quote should
  // never be a dead click.
  const appendLabel = (label: string) => (current: string) =>
    current && !/\s$/.test(current) ? `${current} ${label} ` : `${current}${label} `;

  const insertQuoteLabel = (index: number) => {
    const label = quoteLabel(index);
    const box = lastBox.current;
    if (!box) {
      if (showFollowUpBar && barAnnotation) {
        setFollowUpText((prev) => ({ ...prev, [barAnnotation.id]: appendLabel(label)(prev[barAnnotation.id] || "") }));
      } else {
        setGeneralQuestion(appendLabel(label));
      }
      return;
    }
    const el = box.el;
    const at = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? at;
    box.setText((current) => {
      const before = current.slice(0, at);
      const after = current.slice(end);
      const spacer = before && !/\s$/.test(before) ? " " : "";
      return `${before}${spacer}${label} ${after}`;
    });
    requestAnimationFrame(() => {
      el.focus();
      const caret = at + label.length + 1 + (el.value.slice(0, at) && !/\s$/.test(el.value.slice(0, at)) ? 1 : 0);
      try { el.setSelectionRange(caret, caret); } catch { /* not all inputs support it */ }
    });
  };

  // ── Quote links, both ways ──────────────────────────────────────────
  // A question stores the passages it carried inside its own text, so the link
  // between a passage and the question that quoted it is recovered by reading
  // the thread back rather than kept beside it. Nothing extra is written to
  // disk, and conversations from before this existed became jumpable too.
  type QuoteLink = QuotedPassage & { id: string; targetId: string; targetIndex: number };
  const quoteLinks = useMemo<QuoteLink[]>(() => {
    const links: QuoteLink[] = [];
    for (const a of annotations) {
      a.messages.forEach((m, i) => {
        if (m.role !== "user") return;
        parseQuotes(m.content).quotes.forEach((q, n) => {
          if (!q.source || !q.text.trim()) return;
          links.push({ ...q, id: `${a.id}:${i}:${n}`, targetId: a.id, targetIndex: i });
        });
      });
    }
    return links;
  }, [annotations]);

  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Which conversation each link was actually painted in — two conversations
  // can carry the same label, and the reverse jump should not have to guess
  const paintedIn = useRef<Map<string, string>>(new Map());
  const lastPaint = useRef("");

  // Underline each quoted passage where it was written. These marks are drawn
  // into DOM React owns, so they are cleared and repainted as a whole rather
  // than left to drift — and a conversation that is streaming is left alone,
  // because its text is being rewritten underneath them.
  useLayoutEffect(() => {
    const containersOf = (id: string) =>
      Array.from(annotationRefs.current[id]?.querySelectorAll("[data-quotable]") ?? []) as HTMLElement[];

    // Streaming rewrites `annotations` on every chunk; without this the whole
    // layer would be torn down and rebuilt several times a second, taking any
    // selection the reader was making with it.
    const signature = [
      quoteLinks.map((l) => `${l.id}»${l.text}`).join("|"),
      [...collapsedIds].sort().join(","),
      [...streamingIds].sort().join(","),
    ].join("#");
    const stillPainted = [...paintedIn.current.keys()].every((id) =>
      scrollRef.current?.querySelector(`mark.pr-quoted[data-highlight-id="${id}"]`)
    );
    if (signature === lastPaint.current && stillPainted) return;
    lastPaint.current = signature;

    for (const a of annotations) for (const c of containersOf(a.id)) clearMarks(c, "pr-quoted");

    const placed = new Map<string, string>();
    for (const a of annotations) {
      if (collapsedIds.has(a.id) || streamingIds.has(a.id)) continue;
      const containers = containersOf(a.id);
      for (const link of quoteLinks) {
        if (link.source !== a.label || placed.has(link.id)) continue;
        for (const container of containers) {
          const done = markTextInContainer(container, link.text, "pr-quoted", "Quoted in a question — click to go to it", {
            id: link.id,
            // A chip echoes its passage; marking one would link it to itself
            skipSelector: "[data-quote-chip]",
          });
          if (done) {
            placed.set(link.id, a.id);
            break;
          }
        }
      }
    }
    paintedIn.current = placed;
  }, [annotations, quoteLinks, collapsedIds, streamingIds, annotationRefs]);

  const flash = (el: HTMLElement) => {
    el.classList.add("pr-quote-flash");
    const t = setTimeout(() => el.classList.remove("pr-quote-flash"), 1500);
    // Unref'd where the runtime has it (tests): a pending timer per jump
    // otherwise keeps the process alive long after the assertion is done
    (t as unknown as { unref?: () => void }).unref?.();
  };

  const expand = (id: string) =>
    setCollapsedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // Both ends of a link land the same way: unfold whatever is folded, let that
  // render happen — the marks are painted in it — then scroll and pulse.
  const jumpTo = (annotationId: string, find: () => HTMLElement | null | undefined) => {
    expand(annotationId);
    requestAnimationFrame(() => {
      const el = find() ?? annotationRefs.current[annotationId];
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      flash(el);
    });
  };

  // Passage → the question that quoted it
  const goToQuestion = (linkId: string) => {
    const link = quoteLinks.find((l) => l.id === linkId);
    if (!link) return;
    jumpTo(link.targetId, () => messageRefs.current[`${link.targetId}:${link.targetIndex}`]);
  };

  // …and back: question → the passage it was taken from
  const goToPassage = (linkId: string, source?: string) => {
    const id = paintedIn.current.get(linkId) ?? annotations.find((a) => a.label === source)?.id;
    if (!id) return;
    jumpTo(id, () =>
      annotationRefs.current[id]?.querySelector(`mark.pr-quoted[data-highlight-id="${linkId}"]`) as HTMLElement | null
    );
  };

  // A citation the model wrote: `turn:N` is the ask numbered N, wherever in
  // the panel it ended up. Numbering is per paper and the conversations are one
  // workspace, so this crosses cards exactly like a quote does.
  const goToTurn = (turn: number) => {
    for (const a of annotations) {
      const at = a.messages.findIndex((m) => m.turn === turn);
      if (at === -1) continue;
      jumpTo(a.id, () => messageRefs.current[`${a.id}:${at}`]);
      return true;
    }
    return false;
  };

  // Which turns there are to jump to. Keyed on the numbers themselves, so it
  // changes when an ask is numbered rather than once per streamed chunk — the
  // components map hangs off it, and rebuilding that map would remount every
  // citation in every answer on screen.
  const turnKey = useMemo(() => {
    const turns: number[] = [];
    for (const a of annotations) for (const m of a.messages) if (m.turn) turns.push(m.turn);
    return turns.sort((x, y) => x - y).join(",");
  }, [annotations]);

  useImperativeHandle(
    scrollHandle,
    () => ({
      get: () => scrollRef.current?.scrollTop ?? 0,
      set: (top: number) => scrollRef.current?.scrollTo({ top, behavior: "smooth" }),
    }),
    []
  );

  const citeRef = useRef<CiteHandlers>({});
  useEffect(() => {
    citeRef.current = { paper: onCitePaper, turn: goToTurn };
  });

  const canJumpToPaper = !!onCitePaper;
  const markdownComponents = useMemo<MarkdownComponents>(() => {
    const knownTurns = new Set(turnKey ? turnKey.split(",").map(Number) : []);
    return {
      a: (props: { href?: string; children?: React.ReactNode }) => (
        <CitationAnchor href={props.href} cite={citeRef} knownTurns={knownTurns} canJumpToPaper={canJumpToPaper}>
          {props.children}
        </CitationAnchor>
      ),
    };
  }, [turnKey, canJumpToPaper]);

  // The marks are not React's, so their clicks are caught by delegation. No
  // dependency list: re-binding each render is cheaper than reasoning about a
  // stale closure over the links.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const mark = (e.target as Element | null)?.closest?.("mark.pr-quoted") as HTMLElement | null;
      const id = mark?.dataset.highlightId;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      goToQuestion(id);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  });

  // Where to land in a conversation depends on why we are going there. Coming
  // to one for the first time, you want its beginning. Having just asked
  // something, you want the end — the question you typed and the answer forming
  // under it, not the top of a thread you have already read.
  const seenTurns = useRef<Map<string, number>>(new Map());
  const lastActiveId = useRef<string | null>(null);
  useEffect(() => {
    // Every conversation's length is tracked, not just the active one. The
    // follow-up box belongs to whichever conversation you are reading, which
    // is often not the one that was last clicked — and tracking only the
    // active one made asking in any other look like arriving there for the
    // first time, which lands at the top of a thread you just wrote into.
    const before = activeId ? seenTurns.current.get(activeId) : undefined;
    const counts = new Map<string, number>();
    for (const a of annotations) counts.set(a.id, a.messages.length);
    seenTurns.current = counts;

    if (!activeId) {
      lastActiveId.current = null;
      return;
    }
    const card = annotationRefs.current[activeId];
    const turns = counts.get(activeId) ?? 0;
    const switched = lastActiveId.current !== activeId;
    const grew = before !== undefined && turns > before;
    lastActiveId.current = activeId;
    // A streaming answer rewrites its message without adding one, so this does
    // not fight the reader for the scrollbar while text arrives
    if (!card || (!switched && !grew)) return;
    card.scrollIntoView({ behavior: "smooth", block: grew ? "end" : "start" });
  }, [activeId, annotations, annotationRefs]);

  // Which conversation the follow-up bar belongs to: the last one still on
  // screen, i.e. the one nearest the bar itself. Measured from scroll rather
  // than tracked per card, so it is right even when one conversation is longer
  // than the panel and no boundary is in view.
  //
  // Folded conversations are skipped rather than allowed to win. A folded card
  // takes barely any height, so scrolling to the bottom of the list often puts
  // one nearest the bar — and treating that as "the conversation you are in"
  // took the box away while an open conversation sat right above it.
  const openConversations = annotations.filter((a) => !collapsedIds.has(a.id));
  const [visibleId, setVisibleId] = useState<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const view = el.getBoundingClientRect();
      let found: string | null = null;
      for (const a of openConversations) {
        const card = annotationRefs.current[a.id];
        if (!card) continue;
        const r = card.getBoundingClientRect();
        if (r.bottom > view.top + 8 && r.top < view.bottom - 8) found = a.id;
      }
      setVisibleId(found);
    };
    // Deferred, never synchronous — setState during an effect cascades a render
    const schedule = () => { if (!frame) frame = requestAnimationFrame(pick); };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      el.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, collapsedIds, annotationRefs]);

  // Nothing open on screen still leaves the last open conversation to write to;
  // the bar only goes away when there is nothing writable at all.
  const barAnnotation =
    openConversations.find((a) => a.id === visibleId) ?? openConversations[openConversations.length - 1];
  const showFollowUpBar = !!barAnnotation;

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="flex flex-col items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(230,237,243,0.05)]"
        style={{ width: "2.25rem", borderLeft: "1px solid var(--border)", background: "var(--surface)" }}
        title="Show the conversation"
      >
        <span className="flex items-center justify-center h-9 w-full shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="rotate-90 text-xs" style={{ color: "var(--ink-faint)" }}>≡</span>
        </span>
        <span
          className="mt-3 text-[10px] uppercase tracking-widest select-none"
          style={{ color: "var(--ink-faint)", writingMode: "vertical-rl" }}
        >
          Ask
        </span>
        {annotations.length > 0 && (
          <span
            className="mt-2 text-[10px] font-medium rounded px-1 py-0.5 tabular-nums"
            style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
          >
            {annotations.length}
          </span>
        )}
      </button>
    );
  }

  // The follow-up bar sits outside the scrolling list, flush above the paper
  // composer, and is bound to whichever conversation you are reading. Kept in
  // the card it would either scroll away or — when sticky — detach at the
  // card's bottom edge and leave a gap, since a sticky element cannot travel
  // past its own containing block.
  // Quoted passages ride along with whichever question is asked next, in either
  // box — that is what makes them work across conversations.
  const submitFollowUp = (annotationId: string) => {
    const text = followUpText[annotationId]?.trim();
    if (!text) return;
    onFollowUp(annotationId, withQuotes(text, quotes), followUpImage[annotationId]);
    setFollowUpText((prev) => ({ ...prev, [annotationId]: "" }));
    setFollowUpImage((prev) => { const next = { ...prev }; delete next[annotationId]; return next; });
    setQuotes([]);
  };

  const followUpBar = (annotation: Annotation) => (
  <div
    className="shrink-0 px-3 pt-2 pb-2.5"
    style={{ background: "var(--surface)", borderTop: "1px solid var(--border)" }}
  >
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="text-[10px] uppercase tracking-widest shrink-0" style={{ color: "var(--ink-faint)" }}>Follow up on</span>
      <button
        onClick={() => { annotationRefs.current[annotation.id]?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        className="text-[11px] min-w-0 truncate transition-opacity hover:opacity-70"
        style={{ color: "var(--accent)" }}
        title="Scroll to this conversation"
      >
        {annotation.label}
      </button>
      <button
        onClick={() => toggleCollapsed(annotation.id)}
        className="btn-icon ml-auto shrink-0 px-1.5 py-0.5 text-[10px]"
        title="Collapse this conversation"
      >
        ▾ fold
      </button>
    </div>
    {followUpImage[annotation.id] && (
      <div className="flex items-center gap-2 mb-2">
        <img
          src={followUpImage[annotation.id]}
          alt="figure to attach"
          className="max-h-14 object-contain"
          style={{ border: "1px solid var(--accent)", borderRadius: "3px" }}
        />
        <span className="text-[10px]" style={{ color: "var(--ink-faint)" }}>figure attached</span>
        <button
          onClick={() => setFollowUpImage((prev) => { const next = { ...prev }; delete next[annotation.id]; return next; })}
          className="btn-icon w-5 h-5 text-[10px]"
          title="Remove figure"
        >
          ✕
        </button>
      </div>
    )}
    <div className="flex gap-2 items-end">
      <GrowingTextarea
        placeholder="Ask a follow-up… (paste a figure to attach it)"
        value={followUpText[annotation.id] || ""}
        onChange={(e) =>
          setFollowUpText((prev) => ({ ...prev, [annotation.id]: e.target.value }))
        }
        onPaste={(e) => {
          const file = Array.from(e.clipboardData.items)
            .find((item) => item.type.startsWith("image/"))
            ?.getAsFile();
          if (!file) return;
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () =>
            setFollowUpImage((prev) => ({ ...prev, [annotation.id]: reader.result as string }));
          reader.readAsDataURL(file);
        }}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            // Enter sends (Shift+Enter breaks a line). Without this the
            // keystroke also lands as a newline in the box just emptied,
            // leaving a blank line behind — or in an empty box, for nothing.
            e.preventDefault();
            if (followUpText[annotation.id]?.trim()) submitFollowUp(annotation.id);
          }
        }}
        className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-md focus:outline-none transition-colors resize-none"
        style={{
          border: "1px solid var(--border)",
          background: "var(--paper)",
          color: "var(--ink)",
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: "0.8em",
          lineHeight: 1.5,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent)";
          const el = e.currentTarget;
          lastBox.current = {
            el,
            setText: (update) =>
              setFollowUpText((prev) => ({ ...prev, [annotation.id]: update(prev[annotation.id] || "") })),
          };
        }}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
      />
      <label
        className="btn-icon w-8 self-stretch flex items-center justify-center cursor-pointer text-sm"
        title="Attach a figure image"
      >
        📎
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () =>
              setFollowUpImage((prev) => ({ ...prev, [annotation.id]: reader.result as string }));
            reader.readAsDataURL(file);
            e.target.value = "";
          }}
        />
      </label>
      {streamingIds.has(annotation.id) && onStop ? (
        // While an answer is arriving, the same slot stops it — the chat-box
        // gesture, and the only control that has to be reachable mid-answer
        <button
          onClick={() => onStop(annotation.id)}
          className="text-sm px-3 py-1.5 rounded-md transition-colors shrink-0"
          style={{ border: "1px solid #F87171", color: "#F87171" }}
          title="Stop this answer and keep what has arrived"
        >
          ■ Stop
        </button>
      ) : (
        <button
          onClick={() => {
            if (followUpText[annotation.id]?.trim()) {
              submitFollowUp(annotation.id);
            }
          }}
          className="btn-primary text-sm px-3 py-1.5"
        >
          Ask
        </button>
      )}
    </div>
  </div>
  );

  // Bottom composer — ask about the paper without selecting anything first;
  // supports a pasted/attached image and referencing another library paper
  const composer = (
    <div className="shrink-0 px-3 py-2.5 space-y-1.5" style={{ borderTop: "1px solid var(--border)", background: "var(--paper)" }}>
      {(composerImage || composerRef) && (
        <div className="flex items-center gap-2 flex-wrap">
          {composerImage && (
            <span className="inline-flex items-center gap-1.5">
              <img src={composerImage} alt="attached" className="max-h-12 object-contain" style={{ border: "1px solid var(--accent)", borderRadius: "3px" }} />
              <button onClick={() => setComposerImage(null)} className="btn-icon w-5 h-5 text-[10px]" title="Remove image">✕</button>
            </span>
          )}
          {composerRef && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded max-w-[260px]" style={{ background: "var(--badge-fig-bg)", color: "var(--badge-fig-fg)" }}>
              <span className="truncate">@ {composerRef.title}</span>
              <button onClick={() => setComposerRef(null)} className="shrink-0 hover:opacity-70" title="Remove reference">✕</button>
            </span>
          )}
        </div>
      )}

      {refPickerOpen && (
        <div className="rounded p-2 space-y-1.5" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
          <GrowingTextarea
            autoFocus
            value={refQuery}
            placeholder="Search your Zotero library…"
            onChange={(e) => searchLibrary(e.target.value)}
            onKeyDown={(e) => {
              // A query is one line; Enter must not put a newline in it
              if (e.key === "Enter") e.preventDefault();
              if (e.key === "Escape") setRefPickerOpen(false);
            }}
            className="w-full text-xs px-2 py-1.5 rounded focus:outline-none resize-none"
            style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
          />
          <div className="max-h-36 overflow-y-auto">
            {refResults.map((item) => (
              <button
                key={item.key}
                onClick={() => { setComposerRef(item); setRefPickerOpen(false); }}
                className="w-full text-left text-[11px] leading-snug px-1.5 py-1 rounded transition-colors"
                style={{ color: "var(--ink-muted)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(230,237,243,0.07)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                {item.title}
              </button>
            ))}
            {refResults.length === 0 && (
              <p className="text-[10px] px-1.5 py-1" style={{ color: "var(--ink-faint)" }}>Type to search your library</p>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-1.5 items-end">
        <button
          onClick={() => setRefPickerOpen((v) => !v)}
          className="btn-icon w-7 h-7 text-sm shrink-0"
          style={refPickerOpen || composerRef ? { color: "var(--badge-fig-fg)" } : {}}
          title="Reference another paper from your Zotero library"
        >
          @
        </button>
        <label className="btn-icon w-7 h-7 text-sm shrink-0 cursor-pointer flex items-center justify-center" title="Attach an image">
          📎
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) readImageFile(file);
              e.target.value = "";
            }}
          />
        </label>
        <GrowingTextarea
          value={generalQuestion}
          placeholder="Ask anything about the paper — web available…"
          onChange={(e) => setGeneralQuestion(e.target.value)}
          data-composer="general"
          onPaste={(e) => {
            const file = Array.from(e.clipboardData.items)
              .find((item) => item.type.startsWith("image/"))
              ?.getAsFile();
            if (file) {
              e.preventDefault();
              readImageFile(file);
            }
          }}
          onKeyDown={(e) => { if (isSubmitKey(e)) { e.preventDefault(); submitGeneral(); } }}
          className="flex-1 min-w-0 text-sm px-3 py-2 rounded-md focus:outline-none transition-all resize-none"
          style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink)", lineHeight: 1.5 }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent)";
            const el = e.currentTarget;
            lastBox.current = { el, setText: (update) => setGeneralQuestion((prev) => update(prev)) };
          }}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
        />
        <button
          onClick={submitGeneral}
          disabled={!generalQuestion.trim()}
          className="btn-primary text-sm px-3 py-1.5 disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </div>
  );

  const toolbar = (
    <div className="pr-explain-toolbar shrink-0 flex flex-wrap items-center gap-1 px-3 py-1.5" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
      <span className="inline-flex shrink-0 items-center gap-1">
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
      </span>
      {(onGoBack || onGoForward) && (
        // Undo a jump, and redo it. Kept beside the conversations because that
        // is where most jumps are taken from, and both panes move together.
        <span className="inline-flex items-center mr-1">
          <button
            onClick={onGoBack}
            disabled={!canGoBack}
            className="btn-icon w-6 h-6 text-[11px] disabled:opacity-30"
            title="Back to where you jumped from"
            aria-label="Back"
          >
            ↰
          </button>
          <button
            onClick={onGoForward}
            disabled={!canGoForward}
            className="btn-icon w-6 h-6 text-[11px] disabled:opacity-30"
            title="Forward again"
            aria-label="Forward"
          >
            ↱
          </button>
        </span>
      )}
      {annotations.length > 1 && (
        <button
          onClick={toggleAll}
          className="btn-icon px-2 py-0.5 text-[11px] ml-1 whitespace-nowrap"
          title={allCollapsed ? "Expand every conversation" : "Collapse every conversation"}
        >
          <span>⇕</span><span className="pr-collapse-all-label"> {allCollapsed ? "expand all" : "collapse all"}</span>
        </button>
      )}
      <span className="pr-explain-models ml-auto inline-flex shrink-0 max-w-full items-center justify-end gap-1">
        {modelControls}
      </span>
      <button onClick={onToggle} className="pr-explain-toggle btn-icon shrink-0 w-6 h-6 text-xs" title="Collapse panel">
        ›
      </button>
    </div>
  );

  if (annotations.length === 0) {
    return (
      <div className="pr-explain-panel flex flex-col overflow-hidden" style={{ background: "var(--paper)", width: `${width}px`, minWidth: 250 }}>
        {toolbar}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--ink-faint)" }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <p className="text-sm text-center" style={{ color: "var(--ink-muted)" }}>
            Select text in the PDF and click <span style={{ color: "var(--ink)" }}>Explain this ↗</span>
          </p>
          <p className="text-xs text-center" style={{ color: "var(--ink-faint)" }}>
            Use <span style={{ color: "var(--ink-muted)" }}>✂ Capture figure</span> in the PDF toolbar (or <kbd className="px-1 rounded text-[11px]" style={{ background: "var(--border)", color: "var(--ink-muted)" }}>⌥ Option</kbd> + drag) to grab a figure or graph
          </p>
          <p className="text-xs text-center" style={{ color: "var(--ink-faint)" }}>
            …or just type a question below
          </p>
        </div>
        {composer}
      </div>
    );
  }

  return (
    <div className="pr-explain-panel flex flex-col overflow-hidden" style={{ background: "var(--paper)", width: `${width}px`, minWidth: 250 }}>
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
          const collapsed = collapsedIds.has(annotation.id);
          const replies = annotation.messages.filter((m) => m.role === "assistant" && m.content).length;
          return (
            <div
              key={annotation.id}
              ref={(el) => { annotationRefs.current[annotation.id] = el; }}
              data-conversation={annotation.label}
              data-annotation-id={annotation.id}
              className="rounded-lg overflow-hidden transition-all pr-fade-up"
              style={{
                background: "var(--surface)",
                border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                boxShadow: isActive ? "0 0 0 1px var(--accent), 0 4px 20px rgba(232,120,76,0.15)" : "var(--shadow-card)",
              }}
            >
              {/* Card header — doubles as the collapse toggle */}
              <div
                onClick={() => toggleCollapsed(annotation.id)}
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed(annotation.id); }
                }}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none rounded-t-lg"
                style={{
                  background: "rgba(230,237,243,0.025)",
                  borderBottom: collapsed ? "none" : "1px solid var(--border-light)",
                  borderRadius: collapsed ? "0.5rem" : undefined,
                }}
                title={collapsed ? "Expand this conversation" : "Collapse this conversation"}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(annotation.id); }}
                  className="btn-icon shrink-0 w-6 h-6 text-[11px] leading-none"
                  title={collapsed ? "Expand this conversation" : "Collapse this conversation"}
                  aria-label={collapsed ? "Expand conversation" : "Collapse conversation"}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
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
                    onClick={(e) => { e.stopPropagation(); setLightboxState({ src: annotation.imageDataUrl!, annotationId: annotation.id }); }}
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

                {/* Collapsed cards say how much is folded away, so the panel
                    stays scannable when everything is shut */}
                {collapsed && replies > 0 && (
                  <span className="shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
                    {replies} {replies === 1 ? "reply" : "replies"}
                  </span>
                )}
                {collapsed && streamingIds.has(annotation.id) && (
                  onStop ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStop(annotation.id); }}
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                      style={{ border: "1px solid var(--border)", color: "#F87171" }}
                      title="Stop this answer"
                    >
                      ■ stop
                    </button>
                  ) : (
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--accent)" }}>answering…</span>
                  )
                )}

                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
                  className="btn-icon ml-auto shrink-0 w-6 h-6 text-xs"
                  title="Delete this annotation"
                >
                  ✕
                </button>
              </div>

              {!collapsed && (<>

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
                    <p data-quotable="" className="px-3 pb-2 text-xs leading-relaxed whitespace-pre-wrap" style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-mono), monospace" }}>
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

              {/* Messages */}
              <div data-quotable="" className="px-4 pt-3 pb-2 space-y-3">
                {annotation.messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const isFollowUp = isUser && i > 0;
                  // Every ask seeds an empty assistant message before streaming,
                  // so the newest one is where the reply is about to land
                  const isEditing = editing?.id === annotation.id && editing.index === i;
                  // A question that carried passages shows them as chips and
                  // asks only what was actually typed
                  const asked = isUser ? parseQuotes(msg.content) : null;
                  const waitingHere =
                    !isUser &&
                    !msg.content &&
                    i === annotation.messages.length - 1 &&
                    streamingIds.has(annotation.id);
                  return (
                    <div
                      key={i}
                      ref={(el) => { messageRefs.current[`${annotation.id}:${i}`] = el; }}
                      className={isFollowUp ? "pt-3" : ""}
                      style={isFollowUp ? { borderTop: "1px solid var(--border-light)" } : {}}
                    >
                      <p className="text-[10px] font-semibold mb-1 tracking-wide uppercase flex items-center gap-1.5" style={{ color: isUser ? "var(--ink-faint)" : "var(--accent)" }}>
                        <span
                          className="w-1.5 h-1.5 rounded-full inline-block"
                          style={{ background: isUser ? "var(--ink-faint)" : "linear-gradient(135deg, var(--accent-bright), var(--accent))" }}
                        />
                        {isUser ? "you" : "explainer"}
                      </p>

                      {isUser ? (
                        <>
                          {msg.imageDataUrl && (
                            <img
                              src={msg.imageDataUrl}
                              alt="attached figure"
                              className="max-h-28 object-contain mb-1.5 cursor-zoom-in"
                              style={{ border: "1px solid var(--border)", borderRadius: "3px" }}
                              onClick={() => setLightboxState({ src: msg.imageDataUrl!, annotationId: annotation.id })}
                            />
                          )}
                          {isEditing ? (
                            <div className="flex flex-col gap-1.5" data-editing="">
                              <GrowingTextarea
                                autoFocus
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (isSubmitKey(e)) { e.preventDefault(); resendEdit(annotation.id); }
                                  if (e.key === "Escape") setEditing(null);
                                }}
                                className="w-full text-sm px-2 py-1.5 rounded resize-none focus:outline-none"
                                style={{
                                  border: "1px solid var(--accent)",
                                  background: "var(--paper)",
                                  color: "var(--ink)",
                                  fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
                                }}
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => resendEdit(annotation.id)}
                                  disabled={!editDraft.trim()}
                                  className="btn-primary text-xs px-2.5 py-1 disabled:opacity-50"
                                >
                                  Send again
                                </button>
                                <button onClick={() => setEditing(null)} className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
                                  Cancel
                                </button>
                                <span className="text-[10px] ml-auto" style={{ color: "var(--ink-faint)" }}>
                                  replaces everything after it
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="group/msg flex items-start gap-1.5">
                              <div className="flex-1 min-w-0">
                                {asked!.quotes.length > 0 && (
                                  <div data-quote-chip="" className="flex flex-col items-start gap-1 mb-1.5">
                                    {asked!.quotes.map((q, n) => (
                                      <button
                                        key={n}
                                        onClick={() => goToPassage(`${annotation.id}:${i}:${n}`, q.source)}
                                        className="inline-flex items-center gap-1 max-w-full text-[11px] pl-1 pr-1.5 py-0.5 rounded transition-colors hover:opacity-80"
                                        style={{ background: "var(--quote-dim)", border: "1px solid var(--quote)", color: "var(--ink-muted)" }}
                                        title={`Go back to this passage${q.source ? ` in “${q.source}”` : ""}\n\n${q.text}`}
                                      >
                                        <span className="shrink-0 tabular-nums text-[10px] font-medium" style={{ color: "var(--quote)" }}>{q.label}</span>
                                        <span className="truncate min-w-0">{quotePreview(q.text)}</span>
                                        <span className="shrink-0 text-[10px]" style={{ color: "var(--quote)" }}>↩</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <p style={{ color: "var(--ink-muted)", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>{asked!.question}</p>
                              </div>
                              {onEditMessage && (
                                <button
                                  onClick={() => { setEditing({ id: annotation.id, index: i, quotes: asked!.quotes }); setEditDraft(asked!.question); }}
                                  className="btn-icon shrink-0 w-5 h-5 text-[10px] opacity-0 group-hover/msg:opacity-100 focus:opacity-100 transition-opacity"
                                  title="Edit this question and ask it again"
                                  aria-label="Edit question"
                                >
                                  ✎
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      ) : waitingHere ? (
                        // The answer hasn't started yet: wait in the bubble it
                        // will fill, directly under the question just asked.
                        // Anywhere else — above the thread, as this used to be —
                        // and a follow-up looks like it went unanswered.
                        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}>
                          <span className="inline-flex gap-0.5">
                            <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:0ms]" style={{ background: "var(--accent)" }} />
                            <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:150ms]" style={{ background: "var(--accent)" }} />
                            <span className="w-1 h-1 rounded-full animate-bounce [animation-delay:300ms]" style={{ background: "var(--accent)" }} />
                          </span>
                          Thinking…
                        </div>
                      ) : (
                        <Answer
                          content={msg.content || (streamingIds.has(annotation.id) ? "" : "▌")}
                          components={markdownComponents}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {streamingIds.has(annotation.id) && onStop && (
                <div className="px-4 pb-3 -mt-1">
                  <button
                    onClick={() => onStop(annotation.id)}
                    className="text-[11px] px-2 py-0.5 rounded transition-colors"
                    style={{ border: "1px solid var(--border)", color: "#F87171" }}
                    title="Stop this answer and keep what has arrived"
                  >
                    ■ Stop generating
                  </button>
                </div>
              )}

              </>)}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {pendingQuote && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={addQuote}
          className="btn-primary text-xs px-2.5 py-1 pr-fade-up"
          style={{ position: "fixed", top: pendingQuote.top, left: pendingQuote.left, transform: "translateX(-50%)", zIndex: 60 }}
          title="Carry this into your next question"
        >
          ❝ Quote
        </button>
      )}

      {quotes.length > 0 && (
        <div
          className="shrink-0 px-3 py-2 flex flex-wrap items-center gap-1.5"
          style={{ background: "var(--accent-faint)", borderTop: "1px solid var(--border)" }}
        >
          <span className="text-[10px] uppercase tracking-widest shrink-0" style={{ color: "var(--ink-faint)" }}>
            Quoting {quotes.length > 1 && <span className="tabular-nums">({quotes.length})</span>}
          </span>
          {quotes.map((q, i) => (
            <span
              key={q.id}
              className="inline-flex items-center gap-1 text-[11px] pl-1 pr-1.5 py-1 rounded max-w-[280px]"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--ink-muted)" }}
            >
              <button
                // Clicking the chip writes its label into the question, so a
                // reader never has to remember which passage was which number
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertQuoteLabel(i)}
                className="inline-flex items-center gap-1 min-w-0 hover:opacity-80"
                title={`Insert ${quoteLabel(i)} into your question\n\n${q.text}${q.source ? `\n\n— from ${q.source}` : ""}`}
              >
                <span
                  className="shrink-0 tabular-nums px-1 rounded text-[10px] font-medium"
                  style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
                >
                  {quoteLabel(i)}
                </span>
                <span className="truncate">{quotePreview(q.text)}</span>
                {q.source && (
                  <span className="shrink-0 text-[10px] truncate max-w-[90px]" style={{ color: "var(--ink-faint)" }}>
                    · {q.source}
                  </span>
                )}
              </button>
              <button
                onClick={() => setQuotes((prev) => prev.filter((x) => x.id !== q.id))}
                className="shrink-0 hover:opacity-70"
                title="Drop this quote"
                aria-label="Drop quote"
              >
                ✕
              </button>
            </span>
          ))}
          <button
            onClick={() => setQuotes([])}
            className="text-[10px] ml-auto shrink-0 hover:opacity-70"
            style={{ color: "var(--ink-faint)" }}
          >
            clear
          </button>
        </div>
      )}

      {showFollowUpBar && followUpBar(barAnnotation)}
      {composer}
    </div>
  );
}
