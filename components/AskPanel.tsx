"use client";
import { Fragment, cloneElement, isValidElement, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback, useDeferredValue, memo, useImperativeHandle } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "@/lib/math-delimiters";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { Annotation, Message, Model } from "@/types/session";
import { isSubmitKey } from "@/lib/keys";
import { loadPanelScroll, savePanelScroll } from "@/lib/panel-scroll";
import { trace, traceEnabled, describeForTrace } from "@/lib/panel-trace";
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
  isOpen: boolean;
  onToggle: () => void;
  width?: number;
  modelControls?: React.ReactNode;
  // Identity to remember the list's scroll offset against — the open paper.
  // Absent means nothing is remembered.
  positionKey?: string;
  // Counts every ask the page makes. An ask is not always visible in the
  // conversation — a question edited and sent again as it was — so the panel
  // is told, rather than left to notice.
  askSeq?: number;
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
export type PanelScroll = {
  get: () => number;
  set: (top: number) => void;
  // Hold a passage of the paper for the next question, wherever it is asked
  quote: (text: string, page?: number) => void;
};

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

// The words of a link, for finding them on the page. A formula the model
// wrote in the link text arrives from KaTeX three times over — as MathML, as
// the LaTeX it was typeset from, and as the HTML it is drawn with — and only
// the MathML reads the way the page's own text does ("Ba,Bb∈Rm×c" for
// B^a, B^b ∈ R^{m×c}), so that is what a formula contributes.
type Elementish = { type?: unknown; props?: { children?: React.ReactNode; className?: unknown } };
const classOf = (el: Elementish) => (typeof el.props?.className === "string" ? el.props.className : "");
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as Elementish;
  if (el.type === "annotation" || /\bkatex-html\b/.test(classOf(el))) return "";
  return el.props?.children === undefined ? "" : textOf(el.props.children);
}

// A question tall enough that it and the head of its reply cannot both be in
// the window: if quoted passages are part of that height, they fold first —
// the typed words are the question, the passages are what it carries. With
// no window to measure against (a test), nothing folds.
export function shouldFoldQuotes(px: { question: number; chips: number; head: number; window: number }): boolean {
  return px.window > 0 && px.chips > 0 && px.question + px.head + 24 > px.window;
}

// How the view keeps up with an answer. "question" holds the question and
// lets it rise to the top as the answer grows — the state every send starts
// in. "answer" keeps the end of the conversation at the bottom edge, so the
// words come out in sight. "free" follows nothing: where the reader scrolled
// to is where the view stays. Scrolling switches to free; the control in the
// follow-up bar switches to any of them, and goes there at once.
export type FollowMode = "question" | "answer" | "free";
// The conversation and the question–answer pair (by the question's index)
// the mode applies to: whatever the view is on when the mode is chosen, or
// what was just asked
type Following = { id: string | null; index: number | null; mode: FollowMode };
// What a landing holds at the top of the block it shows: the card, when the
// whole card fits (the passage it started from, every turn, the question), or
// the question alone
type AskBlockTop = "card" | "question";
const NOT_FOLLOWING: Following = { id: null, index: null, mode: "free" };

// A conversation as question–answer pairs: each question with the answer
// that follows it. A conversation that starts with an answer (an explain)
// has that answer as its first pair, with the passage as its question.
// Each pair is a box the reader can see focused, and click to follow.
export function pairsOf(a: Pick<Annotation, "messages">): { start: number; end: number }[] {
  const starts = a.messages.map((m, i) => (i === 0 || m.role === "user" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, k) => ({ start, end: starts[k + 1] ?? a.messages.length }));
}
// Per paper, kept while the reader is away: coming back resumes the same mode
const followMemory = new Map<string, Following>();

// The link as shown: its words tidied the way a label is (a quote copied off a
// PDF has a space between every CJK glyph), its formulas left to KaTeX. Only
// the label's own ends are trimmed; a space between words and a formula is
// the space between them, not slack.
function tidied(node: React.ReactNode): React.ReactNode {
  const list = Array.isArray(node) ? node : [node];
  return list.map((child, i) => {
    const one = tidyOne(child);
    if (typeof one === "string") {
      let text = one;
      if (i === 0) text = text.trimStart();
      if (i === list.length - 1) text = text.trimEnd();
      return <Fragment key={i}>{text}</Fragment>;
    }
    return <Fragment key={i}>{one}</Fragment>;
  });
}
function tidyOne(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return citationLabel(node, false);
  if (Array.isArray(node)) return tidied(node);
  if (!isValidElement(node)) return node;
  const el = node as React.ReactElement<{ children?: React.ReactNode; className?: unknown }>;
  if (/\bkatex\b/.test(classOf(el as Elementish)) || el.props.children === undefined) return el;
  return cloneElement(el, undefined, tidied(el.props.children));
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
  const label = tidied(children);

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
// CommonMark decides whether a `**` opens or closes by what surrounds it,
// and knows only Western punctuation and spaces: a closing `**` between a
// full stop and a Chinese character — 。**更 — is no closer at all, and the
// asterisks stayed on screen. The plugin teaches the rule about CJK.
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCjkFriendly];
// KaTeX renders what it can and leaves the rest as source: an answer is never
// blanked over one formula it cannot parse
const REHYPE_PLUGINS = [[rehypeKatex, { throwOnError: false, strict: "ignore" as const }]] as const;

// One block of an answer, parsed on its own. Memoised on its text: while an
// answer streams, only the block being written changes, so only it is
// parsed again — the rest keep their rendered trees.
const Block = memo(function Block({ text, components }: { text: string; components: MarkdownComponents }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS as unknown as import("react-markdown").Options["rehypePlugins"]}
      components={components}
      urlTransform={citationUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

const Answer = memo(function Answer({
  content,
  components,
  streaming = false,
}: {
  content: string;
  components: MarkdownComponents;
  streaming?: boolean;
}) {
  // While streaming, the text shown may trail the text received: React
  // renders the latest value when it gets to it, and chunks that arrive
  // faster than a render takes are skipped rather than each parsed in turn
  const deferred = useDeferredValue(content);
  const shown = streaming ? deferred : content;
  const blocks = useMemo(() => splitMarkdownBlocks(normalizeMathDelimiters(shown)), [shown]);
  return (
    <div className="prose-paper">
      {blocks.map((text, i) => (
        <Block key={i} text={text} components={components} />
      ))}
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

export function ExplainPanel({ annotations, activeId, model, streamingIds, onFollowUp, onStop, onEditMessage, onAskGeneral, onDelete, onReExplainImage, onViewInPdf, onCitePaper, annotationRefs, scrollHandle, isOpen, onToggle, width = 460, modelControls, positionKey, askSeq }: Props) {
  // One composer for both kinds of question. What is typed is kept across
  // the switch, so flipping it never loses a draft.
  const [draft, setDraft] = useState("");
  const [composerImage, setComposerImage] = useState<string | null>(null);
  // Where the next question goes: into the conversation you are on, or a
  // new one about the paper. Follow up is the default whenever there is a
  // conversation to follow up on; with none, the box can only ask anew.
  const [composeMode, setComposeMode] = useState<"followup" | "new">("followup");
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

  // An image dragged onto the panel — a screenshot from the desktop, a
  // figure from a page — is attached to the next question, as a pasted or
  // chosen one is. Counted in and out so the hint survives the drag passing
  // over the panel's children.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const dragHasImage = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (Array.from(dt.types || []).includes("Files")) return true;
    if (Array.from(dt.files || []).some((f) => f.type.startsWith("image/"))) return true;
    return Array.from(dt.items || []).some((item) => item.kind === "file" && item.type.startsWith("image/"));
  };
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragHasImage(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDropping(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragHasImage(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragHasImage(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    },
    onDrop: (e: React.DragEvent) => {
      dragDepth.current = 0;
      setDropping(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const file = Array.from(dt.files || []).find((f) => f.type.startsWith("image/"))
        ?? Array.from(dt.items || []).find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile()
        ?? null;
      if (!file) return;
      e.preventDefault();
      readImageFile(file);
    },
  };
  const dropHint = dropping && (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
      style={{ background: "rgba(12,15,18,0.72)", border: "2px dashed var(--accent)", borderRadius: 8, color: "var(--accent)" }}
      data-drop-hint=""
    >
      <span className="text-sm font-medium">Drop the image to attach it to your next question</span>
    </div>
  );

  const [lightboxState, setLightboxState] = useState<{ src: string; annotationId: string } | null>(null);
  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  // Which question is being rewritten, and its working text
  const [editing, setEditing] = useState<{ id: string; index: number; quotes: QuotedPassage[] } | null>(null);
  // Questions whose quoted passages are folded away, by "conversation:index"
  const [foldedQuotes, setFoldedQuotes] = useState<Set<string>>(() => new Set());
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
    // back, so rewording a question never silently drops what it pointed at —
    // and anything quoted since (from the paper or an answer) joins them,
    // numbered after them, exactly as it would join a new question
    const carried: Quote[] = editing.quotes.map((q, n) => ({ id: `carried-${n}`, text: q.text, source: q.source, origin: q.origin, page: q.page }));
    const all = quotes.reduce((acc, q) => pushQuote(acc, q), carried);
    onEditMessage?.(annotationId, editing.index, withQuotes(editDraft.trim(), all));
    setQuotes([]);
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
  // The key just restored for, so the landing knows an arrival from a return
  const justRestored = useRef<string | null>(null);
  // The reader's place, kept two ways as of the last scroll event or the last
  // scroll of ours: the offset itself, and the element at the top edge of the
  // list with its distance from that edge. Scroll events are delivered a
  // frame late, so inside a commit these still describe the view from before
  // it — what the reader was looking at, before the browser had its say.
  const settledScrollTop = useRef<number | null>(null);
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  // When the reader last scrolled the list, and until when a smooth scroll of
  // ours is still gliding: at those moments the record above is a frame stale
  const lastInputAt = useRef(0);
  const smoothUntil = useRef(0);
  const captureAnchor = useCallback(() => {
    const list = scrollRef.current;
    if (!list) return;
    settledScrollTop.current = list.scrollTop;
    anchor.current = null;
    if (typeof document.elementFromPoint !== "function") return;
    const box = list.getBoundingClientRect();
    for (const dy of [20, 60, 140]) {
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + dy)?.closest('[style*="scroll-margin"], [data-annotation-id]');
      if (hit && list.contains(hit)) {
        anchor.current = { el: hit, top: hit.getBoundingClientRect().top - box.top };
        return;
      }
    }
  }, []);
  // What is being followed, and how. Reset from the paper's memory when the
  // paper changes — adjusted during render, so the first paint is right.
  const [follow, setFollow] = useState<Following>(() => (positionKey && followMemory.get(positionKey)) || NOT_FOLLOWING);
  const [followFor, setFollowFor] = useState(positionKey);
  if (followFor !== positionKey) {
    setFollowFor(positionKey);
    setFollow((positionKey && followMemory.get(positionKey)) || NOT_FOLLOWING);
  }
  const followRef = useRef(follow);
  useEffect(() => { followRef.current = follow; }, [follow]);
  // When the current following began — an ask, a click on the control — so
  // the tail of a trackpad flick from just before does not count as taking over
  const followSince = useRef(0);
  const setFollowing = useCallback((next: Following, via: string) => {
    followRef.current = next;
    // The focus moving under the reader's own scrolling is not a new following
    if (via !== "scrolled") followSince.current = Date.now();
    if (positionKey) followMemory.set(positionKey, next);
    setFollow(next);
    trace("follow", { mode: next.mode, conversation: next.id?.slice(0, 8) ?? null, index: next.index, via });
  }, [positionKey]);
  // Going where a mode looks (see goTo below), reachable from the restore
  const goToRef = useRef<((mode: FollowMode, id: string, index: number | null) => void) | null>(null);
  // A conversation's card, found in the list rather than read off the refs
  // map: the callbacks below stay stable, and the list is a ref of our own
  const cardOf = useCallback((id: string): HTMLElement | null => {
    const list = scrollRef.current;
    return list ? list.querySelector(`[data-annotation-id="${id.replace(/["\\]/g, "\\$&")}"]`) : null;
  }, []);
  const pairRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // The pair under the middle of the window, or the nearest to it: what the
  // reader is on when nothing has been followed yet, shown focused (picked on
  // scroll, below, with the conversation the bar is bound to). Once something
  // is followed, the reader's own scrolling moves the focus there instead.
  const [viewPair, setViewPair] = useState<{ id: string; index: number } | null>(null);
  // The mouse is down on the list's own box — a scrollbar drag — so every
  // scroll until it is let go is the reader's
  const scrollbarDown = useRef(false);
  const viewPairRef = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => { viewPairRef.current = viewPair; }, [viewPair]);
  useEffect(() => {
    const el = scrollRef.current;
    const key = positionKey;
    if (!el || !key) return;
    if (restoredScrollFor.current !== key) {
      restoredScrollFor.current = key;
      justRestored.current = key;
      const top = loadPanelScroll(key);
      const remembered = followMemory.get(key);
      trace("list-mounted", { key, restoreTo: top, scrollTop: el.scrollTop, height: el.scrollHeight, conversations: annotations.length, follow: remembered?.mode ?? null });
      // One frame later: the list has to lay out before it can be scrolled.
      // Then the mode the paper was left in: following the question or the
      // answer means going back to it, free means where the list was.
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        if (top !== null) { trace("restore", { from: el.scrollTop, to: top }); el.scrollTop = top; }
        if (remembered?.id && remembered.mode !== "free") goToRef.current?.(remembered.mode, remembered.id, remembered.index);
      });
    }
    let timer = 0;
    // The offset as last seen while the list was still in the document. By
    // the time the cleanup runs on collapse or unmount the element has been
    // detached, and a detached element reports a scrollTop of 0.
    let last = el.scrollTop;
    captureAnchor();
    let pending = false;
    let lastCapture = 0;
    const onScroll = () => {
      last = el.scrollTop;
      settledScrollTop.current = last;
      clearTimeout(timer);
      timer = window.setTimeout(() => savePanelScroll(key, last), 300);
      // A few times a second: where the reader is now, and a line of trace.
      // The anchor is read back only when content changes under the view, so
      // a record a few frames old is as good as this frame's — and the hit
      // tests it takes were a measurable share of a scroll's cost.
      if (!pending && performance.now() - lastCapture > 120) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          lastCapture = performance.now();
          if (!el.isConnected) return;
          captureAnchor();
          if (traceEnabled()) trace("scroll", { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), atTop: describeForTrace(anchor.current?.el) });
        });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
      savePanelScroll(key, el.isConnected ? el.scrollTop : last);
      // Once the list is gone, the next one must restore again
      if (!el.isConnected) { trace("list-unmounted", { key, last }); restoredScrollFor.current = null; }
    };
  }, [isOpen, annotations.length, positionKey, captureAnchor]);

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
      setDraft(appendLabel(label));
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
      trace("scrollIntoView", { reason: "jump to a linked passage", target: describeForTrace(el), block: "center" });
      smoothUntil.current = Date.now() + 700;
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
      quote: (text: string, page?: number) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        setQuotes((prev) => pushQuote(prev, { id: `${Date.now()}-${prev.length}`, text: trimmed, origin: "paper", page }));
        // Quoting is asking: the cursor goes to the box the question will be
        // typed in — the one last used, else the follow-up box, else the
        // general one — once the panel has had a frame to open
        requestAnimationFrame(() => {
          const last = lastBox.current?.el;
          const box = last?.isConnected ? last : (document.querySelector('.pr-explain-panel textarea[placeholder^="Ask a follow-up"], .pr-explain-panel textarea') as HTMLTextAreaElement | null);
          box?.focus();
        });
      },
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
  // What a conversation looked like when last seen: how long it is, and its
  // last question. Asking changes that — a new question, a rewritten one, a
  // conversation opened with one — and a streaming answer does not.
  const seenShape = useRef<Map<string, string>>(new Map());
  const lastActiveId = useRef<string | null>(null);
  const seenAsk = useRef(askSeq);
  // Where the question sat in the window, and how tall the answer was, when
  // it was asked: it is held at that place, rising by what the answer grows.
  const pinned = useRef<{ id: string; index: number; top: AskBlockTop; since: number; questionTop: number; answerHeight: number | null } | null>(null);
  // A landing put off until the question's quoted passages have folded
  const landAfterFold = useRef<string | null>(null);
  // Bring the whole of a question just asked into the window — with what it
  // was asked about, at best effort: the passage the conversation started
  // from and the quoted passages when they fit; the question; the explainer's
  // label and thinking dots, Stop, and the card's bottom edge — so the answer
  // forms in sight with its context. Moved no further than that takes. The
  // block's top is the card when the whole card fits, else the question (the
  // landing decides, folding what it can first). When even that is taller
  // than the window, its end is what shows: the end of the question and the
  // reply head. Then the block is held, to rise with the answer: follow
  // question.
  const landOn = useCallback((id: string, index: number, top: AskBlockTop) => {
    const list = scrollRef.current;
    const question = messageRefs.current[`${id}:${index}`];
    const card = cardOf(id);
    const target = (top === "card" ? card : question) || question || card;
    if (!target) return;
    target.scrollIntoView({ behavior: "auto", block: "nearest" });
    const head = messageRefs.current[`${id}:${index + 1}`];
    if (list && card) {
      const below = card.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 12);
      if (below > 0) list.scrollTop = Math.min(list.scrollTop + below, list.scrollHeight - list.clientHeight);
    }
    captureAnchor();
    const questionTop = list ? target.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
    pinned.current = {
      id,
      index,
      top,
      since: Date.now(),
      questionTop,
      answerHeight: head ? head.getBoundingClientRect().height : null,
    };
    setFollowing({ id, index, mode: "question" }, "asked");
    trace("scrollIntoView", { reason: "asked", target: describeForTrace(target), top, block: "nearest, with the whole block to the card's end", scrollTopAfter: list ? Math.round(list.scrollTop) : null, questionTop: Math.round(questionTop), answerHeight: pinned.current.answerHeight });
  }, [cardOf, captureAnchor, setFollowing]);
  useEffect(() => {
    const lastQuestion = (a: Annotation) => a.messages.map((m) => m.role).lastIndexOf("user");
    const shape = (a: Annotation) => {
      const asked = lastQuestion(a);
      return `${a.messages.length}:${asked}:${asked >= 0 ? a.messages[asked].content : ""}`;
    };
    // Every conversation is tracked, not just the active one: the follow-up
    // box belongs to whichever conversation is nearest it, often not the one
    // last clicked, and asking there must read as asking, not as arriving.
    const before = activeId ? seenShape.current.get(activeId) : undefined;
    const shapes = new Map<string, string>();
    for (const a of annotations) shapes.set(a.id, shape(a));
    seenShape.current = shapes;
    const askChanged = askSeq !== seenAsk.current;
    seenAsk.current = askSeq;

    // First, on every change, the reader's place is put back. WebKit moves a
    // scroller of its own accord when its content changes under it — the old
    // answer an edit removes, the new one arriving — by thousands of pixels,
    // in either direction, following no rule of ours; and a browser without
    // scroll anchoring lets what grows above the window push the view along.
    // The element that was at the top edge goes back to where it was, or the
    // offset itself if that element is gone. Not while the reader is
    // scrolling (a key's glide lasts a few hundred ms) or a smooth scroll of
    // ours is gliding: then the record is a frame stale, and the hand wins.
    const list = scrollRef.current;
    if (list) {
      const now = Date.now();
      const a = anchor.current;
      if (now - lastInputAt.current > 400 && now > smoothUntil.current) {
        if (a && a.el.isConnected && list.contains(a.el)) {
          const delta = a.el.getBoundingClientRect().top - list.getBoundingClientRect().top - a.top;
          if (Math.abs(delta) > 1) {
            const from = list.scrollTop;
            list.scrollTop = from + delta;
            trace("re-anchor", { from: Math.round(from), to: Math.round(list.scrollTop), by: Math.round(delta), element: describeForTrace(a.el) });
            captureAnchor();
          }
        } else if (settledScrollTop.current !== null && Math.abs(list.scrollTop - settledScrollTop.current) > 1) {
          const from = list.scrollTop;
          list.scrollTop = settledScrollTop.current;
          trace("undo-shift", { from: Math.round(from), to: Math.round(list.scrollTop) });
          captureAnchor();
        }
      }
    }

    if (!activeId) {
      lastActiveId.current = null;
      return;
    }
    const card = annotationRefs.current[activeId];
    const active = annotations.find((a) => a.id === activeId);
    const switched = lastActiveId.current !== activeId;
    lastActiveId.current = activeId;
    if (!card || !active) return;

    const asked = lastQuestion(active);
    // An ask is an ask even when it changes nothing visible — a question
    // edited and sent again as it was — so the page's count decides, and the
    // shape stands in where there is no count
    const askedNow = asked >= 0 && (askSeq === undefined ? shape(active) !== before : askChanged);
    trace("landing", { conversation: activeId.slice(0, 8), switched, askedNow, askChanged, asked, before: before?.slice(0, 48) ?? null, now: shape(active).slice(0, 48), scrollTop: list ? Math.round(list.scrollTop) : null });
    // Just asked, wherever it was asked — or a landing put off a render ago
    // for something to fold first. The block is brought into the window and
    // no further; nothing is forced to the top. The answer, as it arrives, is
    // what pushes it up (see below). Instant: Safari abandons a smooth scroll
    // whose target moves, and the panel's end moves while an answer streams.
    const key = `${activeId}:${asked}`;
    if (askedNow || landAfterFold.current === key) {
      landAfterFold.current = null;
      const target = messageRefs.current[`${activeId}:${asked}`];
      const head = messageRefs.current[`${activeId}:${asked + 1}`];
      const win = list ? list.clientHeight : 0;
      // The whole card fits: the passage it started from, every turn, the
      // question, the reply head, Stop — all of it in view
      if (list && target && win > 0 && card.getBoundingClientRect().height + 24 <= win) {
        landOn(activeId, asked, "card");
        return;
      }
      // The passage shown in full is what keeps the card from fitting:
      // back to its preview, and land again once it has
      if (list && target && win > 0 && expandedText.has(activeId)) {
        const passage = card.getBoundingClientRect().height - (card.getBoundingClientRect().bottom - target.getBoundingClientRect().top);
        if (card.getBoundingClientRect().height + 24 - passage <= win) {
          trace("fold-passage", { conversation: activeId.slice(0, 8) });
          landAfterFold.current = key;
          setExpandedText((prev) => { const next = new Set(prev); next.delete(activeId); return next; });
          return;
        }
      }
      // The question with its quoted passages, and the reply to the card's
      // end: the passages fold when that is what makes it fit
      const chips = target?.querySelector("[data-quote-chip]") as HTMLElement | null;
      const tail = head && card ? Math.max(0, card.getBoundingClientRect().bottom - head.getBoundingClientRect().top) : 0;
      if (list && target && head && chips && !foldedQuotes.has(key) && shouldFoldQuotes({ question: target.getBoundingClientRect().height, chips: chips.getBoundingClientRect().height, head: tail, window: win })) {
        trace("fold-quotes", { question: key });
        landAfterFold.current = key;
        setFoldedQuotes((prev) => new Set(prev).add(key));
        return;
      }
      landOn(activeId, asked, "question");
      return;
    }
    // Merely arrived — clicked, or a passage explained with no question of
    // the reader's own — so its beginning is the place
    if (switched) {
      // Coming back to a paper restores the list to where it was (and the
      // mode it was in); the conversation that happens to be active was not
      // clicked, and is not scrolled to
      if (justRestored.current === positionKey) { justRestored.current = null; return; }
      trace("scrollIntoView", { reason: "switched to a conversation", target: describeForTrace(card), block: "start" });
      smoothUntil.current = Date.now() + 700;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      // Arriving at a conversation — opened, or just made by an explain — is
      // leaving the followed one for it: its first pair is now the focus,
      // followed by nothing, and where a follow-up goes
      const f = followRef.current;
      if (f.id !== activeId) {
        pinned.current = null;
        setFollowing({ id: activeId, index: pairsOf(active)[0]?.start ?? 0, mode: "free" }, "switched");
      }
    }
  }, [activeId, annotations, annotationRefs, askSeq, captureAnchor, foldedQuotes, expandedText, landOn, setFollowing, positionKey]);

  // While the answer streams, the question rises with it: the list scrolls
  // down exactly as much as the answer has grown, until the question reaches
  // the top, and then no further — the rest of the answer arrives below the
  // fold, for the reader to scroll to. Growth, not room: with another
  // conversation below, there is room to put the question at the top at once,
  // and that is a jump, not a rise. The reader scrolling on their own ends it.
  useEffect(() => {
    const pin = pinned.current;
    const list = scrollRef.current;
    if (!pin || !list) return;
    if (followRef.current.mode !== "question" || followRef.current.id !== pin.id) { pinned.current = null; return; }
    const el = (pin.top === "card" ? annotationRefs.current[pin.id] : null) ?? messageRefs.current[`${pin.id}:${pin.index}`];
    if (!el) return;
    const settle = () => {
      const answer = messageRefs.current[`${pin.id}:${pin.index + 1}`];
      const answerHeight = answer ? answer.getBoundingClientRect().height : 0;
      // First sight of the answer's bubble is the baseline it grows from
      if (pin.answerHeight === null) pin.answerHeight = answerHeight;
      const grown = Math.max(0, answerHeight - pin.answerHeight);
      // Where the question belongs now: where it was, less what the answer
      // has grown, and never above the top. Held there in both directions —
      // the browser's own shifts (see above) are undone, not followed.
      const wanted = Math.max(12, pin.questionTop - grown);
      const actual = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const from = list.scrollTop;
      if (Math.abs(actual - wanted) > 1) {
        list.scrollTop = Math.max(0, Math.min(from + (actual - wanted), list.scrollHeight - list.clientHeight));
        captureAnchor();
      }
      // At the top: the rest of the answer forms below the fold, unfollowed
      const done = wanted <= 12;
      if (traceEnabled() && (Math.round(list.scrollTop) !== Math.round(from) || done)) trace("settle", { from: Math.round(from), to: Math.round(list.scrollTop), grown: Math.round(grown), top: pin.top, questionWas: Math.round(actual), questionNow: Math.round(el.getBoundingClientRect().top - list.getBoundingClientRect().top), wanted: Math.round(wanted), max: Math.round(list.scrollHeight - list.clientHeight), done });
      return done;
    };
    if (settle()) pinned.current = null;
    // The answer is complete. WebKit re-anchors the scroll a frame after
    // content changes under it, so the last word is had one frame later.
    if (!streamingIds.has(pin.id)) {
      requestAnimationFrame(() => {
        if (pinned.current?.id === pin.id) settle();
        pinned.current = null;
      });
    }
  }, [annotations, streamingIds, captureAnchor, annotationRefs]);
  // Going where a mode looks: the question at the top of the window, or the
  // end of the conversation — the last line, Stop, the card's bottom edge —
  // at its bottom edge. Instant while the answer streams (Safari drops a
  // smooth scroll whose target moves), a glide otherwise.
  // A glide of our own: the list eased to a target over a few hundred ms,
  // the target re-read every frame. A native smooth scroll is dropped by
  // Safari when its target moves, and the end of an answer moves while it
  // streams; this one arrives wherever the target is by the last frame.
  // The reader's own scrolling cuts it short (see the release handlers).
  const glideFrame = useRef(0);
  const glide = useCallback((target: () => number, duration = 420) => {
    const list = scrollRef.current;
    if (!list) return;
    cancelAnimationFrame(glideFrame.current);
    const from = list.scrollTop;
    const started = performance.now();
    smoothUntil.current = Date.now() + duration + 120;
    // The clock read here, not the frame's timestamp: a test's frames carry none
    const step = () => {
      const k = Math.min(1, (performance.now() - started) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      const to = Math.max(0, Math.min(target(), list.scrollHeight - list.clientHeight));
      list.scrollTop = from + (to - from) * eased;
      if (k < 1) {
        glideFrame.current = requestAnimationFrame(step);
      } else {
        glideFrame.current = 0;
        smoothUntil.current = 0;
        captureAnchor();
      }
    };
    glideFrame.current = requestAnimationFrame(step);
  }, [captureAnchor]);

  // Where a pair ends: the card's bottom edge (Stop, the border) for the
  // last pair, the pair's own last message for an earlier one
  const endOfPair = useCallback((id: string, index: number): HTMLElement | null => {
    const conversation = annotations.find((a) => a.id === id);
    if (!conversation) return null;
    const pairs = pairsOf(conversation);
    const pair = pairs.find((p) => p.start === index) ?? pairs[pairs.length - 1];
    if (!pair || pair === pairs[pairs.length - 1]) return cardOf(id);
    return messageRefs.current[`${id}:${pair.end - 1}`] ?? messageRefs.current[`${id}:${pair.start}`] ?? null;
  }, [annotations, cardOf]);
  const goTo = useCallback((mode: FollowMode, id: string, index: number | null) => {
    const list = scrollRef.current;
    const conversation = annotations.find((a) => a.id === id);
    if (!list || !conversation) return;
    pinned.current = null;
    const starts = pairsOf(conversation).map((p) => p.start);
    const at = index !== null && starts.includes(index) ? index : (starts[starts.length - 1] ?? -1);
    if (mode === "question") {
      const question = messageRefs.current[`${id}:${at}`];
      const card = cardOf(id);
      // For the first pair: the card's top, when the passage the
      // conversation started from and the question fit together with room
      // for the answer's first lines; otherwise the question itself
      const win = list.clientHeight;
      const first = starts.length === 0 || at === starts[0];
      const withContext = first && !!question && !!card && win > 0 && question.getBoundingClientRect().bottom - card.getBoundingClientRect().top + 24 <= win;
      const el = (withContext ? card : question) ?? card;
      if (!el) return;
      trace("glide", { reason: "follow the question", conversation: id.slice(0, 8), index: at, top: withContext ? "card" : "question", from: Math.round(list.scrollTop) });
      glide(() => list.scrollTop + (el.getBoundingClientRect().top - list.getBoundingClientRect().top) - 12);
    } else if (mode === "answer") {
      const end = endOfPair(id, at);
      if (!end) return;
      trace("glide", { reason: "follow the answer", conversation: id.slice(0, 8), index: at, from: Math.round(list.scrollTop) });
      glide(() => list.scrollTop + (end.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 12)));
    }
  }, [annotations, cardOf, endOfPair, glide]);
  useEffect(() => { goToRef.current = goTo; }, [goTo]);

  // The pair the reader is on — the one shown focused. While following, the
  // followed pair; otherwise the pair under the middle of the window (see the
  // pick below), and failing that the last pair of the conversation the bar
  // is bound to.
  const focusedPair = useCallback((fallback: Annotation): { id: string; index: number } | null => {
    const f = followRef.current;
    if (f.id && f.index !== null) return { id: f.id, index: f.index };
    if (viewPairRef.current) return viewPairRef.current;
    const pairs = pairsOf(fallback);
    return pairs.length ? { id: fallback.id, index: pairs[pairs.length - 1].start } : null;
  }, []);
  // The pair shown focused: the one being followed, in any mode — changing
  // mode keeps it; only the reader's own scrolling moves it (see the pick) —
  // or, before anything has been followed, the pair under the window's middle
  const focusedOn: { id: string; index: number } | null =
    follow.id && follow.index !== null ? { id: follow.id, index: follow.index } : viewPair;
  // The reader's choice from the control applies to the focused pair
  const chooseFollow = useCallback((mode: FollowMode, inView: Annotation) => {
    const target = focusedPair(inView);
    if (!target) return;
    setFollowing({ id: target.id, index: target.index, mode }, "control");
    goTo(mode, target.id, target.index);
  }, [focusedPair, setFollowing, goTo]);
  // A click anywhere in a pair's box: follow its question. The pair already
  // focused is left as it is, in whatever mode it is in.
  const focusPair = useCallback((id: string, index: number) => {
    const f = followRef.current;
    if (f.id === id && f.index === index) return;
    setFollowing({ id, index, mode: "question" }, "pair clicked");
    goTo("question", id, index);
  }, [setFollowing, goTo]);

  // Follow answer: the end of the pair is kept at the bottom edge as the
  // answer grows — in both directions, so the browser's own shifts are
  // undone too. Not while the reader's hand is on the list or a glide of ours
  // is under way: then the geometry is a frame stale, and the hand wins.
  useEffect(() => {
    const list = scrollRef.current;
    if (follow.mode !== "answer" || !follow.id || !list) return;
    const id = follow.id;
    const end = endOfPair(id, follow.index ?? Number.MAX_SAFE_INTEGER);
    if (!end) return;
    const align = () => {
      const now = Date.now();
      if (now < smoothUntil.current || now - lastInputAt.current < 400) return;
      const delta = end.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 12);
      if (Math.abs(delta) <= 1) return;
      const from = list.scrollTop;
      list.scrollTop = Math.max(0, Math.min(from + delta, list.scrollHeight - list.clientHeight));
      captureAnchor();
      trace("follow-answer", { conversation: id.slice(0, 8), from: Math.round(from), to: Math.round(list.scrollTop), by: Math.round(delta) });
    };
    align();
    // The answer is complete: WebKit re-anchors a frame after content
    // changes under it, so the last word is had one frame later
    if (!streamingIds.has(id)) {
      requestAnimationFrame(() => {
        const f = followRef.current;
        if (f.mode === "answer" && f.id === id && list.isConnected) align();
      });
    }
  }, [annotations, streamingIds, follow, captureAnchor, endOfPair]);

  // Stepping pair by pair, in the mode the reader is in: from the focused
  // pair to the one before or after it, across conversations (folded ones
  // skipped). In question mode the next question goes to the top and is
  // followed; in answer mode the next pair's end to the bottom, followed;
  // from free mode, stepping is following the question. Reading in between
  // is scrolling, which switches to free as ever.
  const pairSequence = useCallback(() => {
    const out: { id: string; index: number }[] = [];
    for (const a of annotations) {
      if (collapsedIds.has(a.id)) continue;
      for (const pair of pairsOf(a)) out.push({ id: a.id, index: pair.start });
    }
    return out;
  }, [annotations, collapsedIds]);
  // From a given pair (the focused one: read off state while rendering, off
  // the refs when a key or a button is handled)
  const pairAfter = useCallback((direction: 1 | -1, here: { id: string; index: number } | null): { id: string; index: number } | null => {
    const sequence = pairSequence();
    const at = here ? sequence.findIndex((p) => p.id === here.id && p.index === here.index) : -1;
    return (at < 0 ? (direction > 0 ? sequence[0] : sequence[sequence.length - 1]) : sequence[at + direction]) ?? null;
  }, [pairSequence]);
  const stepPair = useCallback((direction: 1 | -1, fallback: Annotation) => {
    const next = pairAfter(direction, focusedPair(fallback));
    if (!next) return;
    // Stepping is following: from free mode, the question
    const mode: FollowMode = followRef.current.mode === "answer" ? "answer" : "question";
    trace("step", { direction, conversation: next.id.slice(0, 8), index: next.index, mode });
    setFollowing({ id: next.id, index: next.index, mode }, "step");
    goTo(mode, next.id, next.index);
  }, [pairAfter, focusedPair, setFollowing, goTo]);
  // ] and [ step too, from anywhere but a box being typed in
  const barAnnotationRef = useRef<Annotation | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("textarea, input, select, [contenteditable]")) return;
      if (e.key !== "]" && e.key !== "[") return;
      const from = barAnnotationRef.current;
      if (!from) return;
      e.preventDefault();
      stepPair(e.key === "]" ? 1 : -1, from);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepPair]);

  useEffect(() => {
    const list = scrollRef.current;
    if (!list) return;
    // A trackpad keeps sending the tail of an earlier flick for a moment;
    // that is not the reader taking over
    const release = (via: string) => {
      if (Date.now() - followSince.current <= 800) return;
      if (pinned.current) { trace("release", { via }); pinned.current = null; }
      const f = followRef.current;
      if (f.mode !== "free") setFollowing({ ...f, mode: "free" }, via);
    };
    const scrolling = () => { lastInputAt.current = Date.now(); cancelAnimationFrame(glideFrame.current); glideFrame.current = 0; smoothUntil.current = 0; };
    const onWheel = () => { scrolling(); release("wheel"); };
    const onTouch = () => { scrolling(); release("touch"); };
    // A click is a click; only the scrollbar, which is the list's own box
    // rather than anything in it, is the reader scrolling
    const onMouse = (e: MouseEvent) => { if (e.target === list) { scrollbarDown.current = true; scrolling(); release("scrollbar"); } };
    const onUp = () => { scrollbarDown.current = false; };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("textarea, input")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) { scrolling(); release(`key ${e.key}`); }
    };
    list.addEventListener("wheel", onWheel, { passive: true });
    list.addEventListener("touchstart", onTouch, { passive: true });
    list.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onUp);
    list.addEventListener("keydown", onKey);
    return () => {
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchstart", onTouch);
      list.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onUp);
      list.removeEventListener("keydown", onKey);
    };
  }, [isOpen, annotations.length, setFollowing]);

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
      const middle = view.top + view.height / 2;
      let nearest: { id: string; index: number; distance: number } | null = null;
      for (const a of openConversations) {
        for (const pair of pairsOf(a)) {
          const box = pairRefs.current[`${a.id}:${pair.start}`];
          if (!box) continue;
          const r = box.getBoundingClientRect();
          if (r.height === 0) continue;
          const distance = r.top <= middle && middle <= r.bottom ? 0 : Math.min(Math.abs(r.top - middle), Math.abs(r.bottom - middle));
          if (!nearest || distance < nearest.distance) nearest = { id: a.id, index: pair.start, distance };
        }
      }
      setViewPair((prev) => (prev?.id === nearest?.id && prev?.index === nearest?.index ? prev : nearest ? { id: nearest.id, index: nearest.index } : null));
      // Scrolling of the reader's own, while nothing is followed, moves the
      // focus to the pair they scrolled to. A scroll of ours (a landing, a
      // re-anchor, a mode's glide) leaves it where it was.
      const f = followRef.current;
      const byHand = scrollbarDown.current || Date.now() - lastInputAt.current < 600;
      if (nearest && f.mode === "free" && f.id && byHand && (f.id !== nearest.id || f.index !== nearest.index)) {
        setFollowing({ id: nearest.id, index: nearest.index, mode: "free" }, "scrolled");
      }
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
  }, [annotations, collapsedIds, annotationRefs, setFollowing]);

  // Nothing open on screen still leaves the last open conversation to write to;
  // the bar only goes away when there is nothing writable at all.
  const barAnnotation =
    openConversations.find((a) => a.id === visibleId) ?? openConversations[openConversations.length - 1];
  useEffect(() => { barAnnotationRef.current = barAnnotation ?? null; }, [barAnnotation]);
  // The conversation a follow-up goes to: the one the focused pair is in,
  // else the one nearest the box
  const target: Annotation | null = openConversations.find((a) => a.id === focusedOn?.id) ?? barAnnotation ?? null;
  const mode: "followup" | "new" = target ? composeMode : "new";

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
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    if (mode === "followup" && target) {
      onFollowUp(target.id, withQuotes(text, quotes), composerImage || undefined);
    } else {
      onAskGeneral(withQuotes(text, quotes), composerImage || undefined, composerRef || undefined, true);
      setComposerRef(null);
      setRefPickerOpen(false);
    }
    setQuotes([]);
    setDraft("");
    setComposerImage(null);
  };
  const stoppable = !!target && mode === "followup" && streamingIds.has(target.id) && !!onStop;
  // Quoted passages ride along with whichever question is asked next, in
  // either mode — that is what makes them work across conversations.
  const composer = (
    <div
      className="shrink-0 px-3 pt-2 pb-2.5 space-y-1.5"
      style={{ background: "var(--surface)", borderTop: "1px solid var(--border)" }}
    >
      {target && (
        <div className="flex items-center gap-1.5 min-w-0">
          <span role="group" aria-label="Send as" className="inline-flex shrink-0 rounded overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {([
              ["followup", "Follow up", "Follow up on the conversation you are on  (Tab)"],
              ["new", "New", "Start a new conversation about the paper  (Tab)"],
            ] as ["followup" | "new", string, string][]).map(([m, label, hint]) => {
              const on = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => setComposeMode(m)}
                  aria-pressed={on}
                  className="text-[10.5px] px-2 py-0.5 transition-colors"
                  style={{ color: on ? "var(--accent)" : "var(--ink-muted)", background: on ? "rgba(225,195,105,0.14)" : "transparent" }}
                  title={hint}
                >
                  {label}
                </button>
              );
            })}
          </span>
          {mode === "followup" ? (
            <>
              <span className="text-[10px] shrink-0" style={{ color: "var(--ink-faint)" }}>on</span>
              <button
                onClick={() => { trace("scrollIntoView", { reason: "composer label clicked", conversation: target.id.slice(0, 8), block: "start" }); smoothUntil.current = Date.now() + 700; annotationRefs.current[target.id]?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                className="text-[11px] min-w-0 truncate transition-opacity hover:opacity-70"
                style={{ color: "var(--accent)" }}
                title="Scroll to this conversation"
              >
                {target.label}
              </button>
            </>
          ) : (
            <span className="text-[10px] min-w-0 truncate" style={{ color: "var(--ink-faint)" }}>about the paper, web available</span>
          )}
          <button
            onClick={() => stepPair(-1, target)}
            disabled={!pairAfter(-1, focusedOn)}
            className="btn-icon ml-auto shrink-0 px-1.5 py-0.5 text-[10px] disabled:opacity-40"
            title="Previous question–answer pair, in the current mode  ([)"
          >
            ↑ pair
          </button>
          <button
            onClick={() => stepPair(1, target)}
            disabled={!pairAfter(1, focusedOn)}
            className="btn-icon shrink-0 px-1.5 py-0.5 text-[10px] disabled:opacity-40"
            title="Next question–answer pair, in the current mode  (])"
          >
            ↓ pair
          </button>
          <button
            onClick={() => toggleCollapsed(target.id)}
            className="btn-icon shrink-0 px-1.5 py-0.5 text-[10px]"
            title="Collapse this conversation"
          >
            ▾ fold
          </button>
        </div>
      )}

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
          disabled={mode === "followup"}
          className="btn-icon w-7 h-7 text-sm shrink-0 disabled:opacity-30"
          style={refPickerOpen || composerRef ? { color: "var(--badge-fig-fg)" } : {}}
          title={mode === "followup" ? "References go with a new question" : "Reference another paper from your Zotero library"}
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
          value={draft}
          placeholder={mode === "followup" ? "Ask a follow-up… (paste a figure to attach it)" : "Ask anything about the paper — web available…"}
          onChange={(e) => setDraft(e.target.value)}
          data-composer={mode === "followup" ? "followup" : "general"}
          onPaste={(e) => {
            const file = Array.from(e.clipboardData.items)
              .find((item) => item.type.startsWith("image/"))
              ?.getAsFile();
            if (file) {
              e.preventDefault();
              readImageFile(file);
            }
          }}
          onKeyDown={(e) => {
            // Tab flips the switch, while there is something to follow up on
            if (e.key === "Tab" && target && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              setComposeMode((m) => (m === "followup" ? "new" : "followup"));
              return;
            }
            // Enter sends (Shift+Enter breaks a line). Without this the
            // keystroke also lands as a newline in the box just emptied.
            if (isSubmitKey(e)) { e.preventDefault(); send(); }
          }}
          className="flex-1 min-w-0 text-sm px-3 py-2 rounded-md focus:outline-none transition-all resize-none"
          style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)", lineHeight: 1.5 }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent)";
            const el = e.currentTarget;
            lastBox.current = { el, setText: (update) => setDraft((prev) => update(prev)) };
          }}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
        />
        {stoppable ? (
          // While an answer is arriving, the same slot stops it — the chat-box
          // gesture, and the only control that has to be reachable mid-answer
          <button
            onClick={() => onStop?.(target!.id)}
            className="text-sm px-3 py-1.5 rounded-md transition-colors shrink-0"
            style={{ border: "1px solid #F87171", color: "#F87171" }}
            title="Stop this answer and keep what has arrived"
          >
            ■ Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!draft.trim()}
            className="btn-primary text-sm px-3 py-1.5 disabled:opacity-40"
          >
            Ask
          </button>
        )}
      </div>
    </div>
  );

  // Two rows, by what they are for. The top row is touched while reading:
  // how the view follows an answer, folding every conversation, hiding the
  // panel. The row under it is set once and left: the text size, the model
  // and its effort.
  const followControl = annotations.length > 0 && (
    <span className="inline-flex shrink-0 items-center gap-1" role="group" aria-label="Follow">
      <span className="text-[10px] uppercase tracking-widest mr-0.5" style={{ color: "var(--ink-faint)" }}>Follow</span>
      {([
        ["question", "Hold the question in view; it rises to the top as the answer arrives"],
        ["answer", "Keep the end of the answer in view as it arrives"],
        ["free", "Follow nothing — stay where you scrolled"],
      ] as [FollowMode, string][]).map(([m, hint]) => {
        const on = follow.mode === m;
        return (
          <button
            key={m}
            onClick={() => { const from = target ?? barAnnotation ?? annotations[0]; if (from) chooseFollow(m, from); }}
            aria-pressed={on}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
            style={{ border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`, color: on ? "var(--accent)" : "var(--ink-muted)", background: on ? "rgba(225,195,105,0.12)" : "transparent" }}
            title={hint}
          >
            {m}
          </button>
        );
      })}
    </span>
  );
  const toolbar = (
    <div className="pr-explain-toolbar shrink-0 px-3 py-1.5 space-y-1" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center gap-1">
        {followControl || <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>Ask</span>}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          {annotations.length > 1 && (
            <button
              onClick={toggleAll}
              className="btn-icon px-2 py-0.5 text-[11px] whitespace-nowrap"
              title={allCollapsed ? "Expand every conversation" : "Collapse every conversation"}
            >
              <span>⇕</span><span className="pr-collapse-all-label"> {allCollapsed ? "expand all" : "collapse all"}</span>
            </button>
          )}
          <button onClick={onToggle} className="pr-explain-toggle btn-icon shrink-0 w-6 h-6 text-xs" title="Collapse panel">
            ›
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <span className="text-[10px] uppercase tracking-widest mr-1" style={{ color: "var(--ink-faint)" }}>Text</span>
          <button
            onClick={() => setFontIdx((i) => Math.max(0, i - 1))}
            disabled={!canDecrease}
            className="btn-icon w-6 h-6 text-base leading-none"
            title="Smaller text (Ctrl+scroll)"
          >−</button>
          <button
            onClick={() => setFontIdx(DEFAULT_FONT_IDX)}
            className="btn-icon px-1.5 py-0.5 text-xs min-w-[40px] text-center tabular-nums"
            title="Reset text size"
          >
            {fontSize}px
          </button>
          <button
            onClick={() => setFontIdx((i) => Math.min(FONT_SIZES.length - 1, i + 1))}
            disabled={!canIncrease}
            className="btn-icon w-6 h-6 text-base leading-none"
            title="Larger text (Ctrl+scroll)"
          >+</button>
        </span>
        <span className="pr-explain-models ml-auto inline-flex shrink-0 max-w-full items-center justify-end gap-1">
          {modelControls}
        </span>
      </div>
    </div>
  );

  // Passages held for the next question, shown wherever that question can be
  // typed — the empty panel's composer as much as the list's follow-up bar
  const quoteStrip = quotes.length > 0 && (
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
                title={`Insert ${quoteLabel(i)} into your question\n\n${q.text}${q.origin === "paper" ? `\n\n— from the paper${q.page ? `, page ${q.page}` : ""}` : q.source ? `\n\n— from ${q.source}` : ""}`}
              >
                <span
                  className="shrink-0 tabular-nums px-1 rounded text-[10px] font-medium"
                  style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
                >
                  {quoteLabel(i)}
                </span>
                <span className="truncate">{quotePreview(q.text)}</span>
                {(q.origin === "paper" || q.source) && (
                  <span className="shrink-0 text-[10px] truncate max-w-[90px]" style={{ color: "var(--ink-faint)" }}>
                    · {q.origin === "paper" ? `paper${q.page ? ` p.${q.page}` : ""}` : q.source}
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
      );

  if (annotations.length === 0) {
    return (
      <div className="pr-explain-panel relative flex flex-col overflow-hidden" style={{ background: "var(--paper)", width: `${width}px`, minWidth: 250 }} {...dropHandlers}>
        {dropHint}
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
        {quoteStrip}
        {composer}
      </div>
    );
  }

  return (
    <div className="pr-explain-panel relative flex flex-col overflow-hidden" style={{ background: "var(--paper)", width: `${width}px`, minWidth: 250 }} {...dropHandlers}>
      {dropHint}
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
          // The card lit is the one holding the focused pair — the thread you
          // are in — or, before anything is focused, the active one
          const lit = focusedOn ? focusedOn.id === annotation.id : isActive;
          const collapsed = collapsedIds.has(annotation.id);
          const replies = annotation.messages.filter((m) => m.role === "assistant" && m.content).length;
          return (
            <div
              key={annotation.id}
              ref={(el) => { annotationRefs.current[annotation.id] = el; }}
              data-conversation={annotation.label}
              data-annotation-id={annotation.id}
              data-lit={lit ? "" : undefined}
              className="rounded-lg overflow-hidden transition-all pr-fade-up"
              // Every card is laid out in full, always. Skipping the layout of
              // cards off screen (content-visibility: auto, with a placeholder
              // height) saved a little paint and cost the whole list: WebKit
              // sized a skipped card at its placeholder, so each time the lit
              // card changed under a scroll the list's height jumped by
              // thousands of pixels and the scroll offset was clamped back —
              // the reader could not scroll past a long thread at all.
              style={{
                background: "var(--surface)",
                border: lit ? "1px solid var(--accent)" : "1px solid var(--border)",
                boxShadow: lit ? "0 0 0 1px var(--accent), 0 4px 20px rgba(232,120,76,0.15)" : "var(--shadow-card)",
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

              {/* Messages, as question–answer pairs: each a box the reader
                  can see focused and click to follow */}
              <div data-quotable="" className="px-4 pt-2 pb-2 space-y-1">
                {pairsOf(annotation).map((pair) => {
                  const focused = focusedOn?.id === annotation.id && focusedOn.index === pair.start;
                  return (
                    <div
                      key={pair.start}
                      ref={(el) => { pairRefs.current[`${annotation.id}:${pair.start}`] = el; }}
                      data-pair={pair.start}
                      data-focused={focused ? "" : undefined}
                      // The focused pair sits on a lighter panel with a rail
                      // down its left edge and a soft ring, plain to see at a
                      // glance. Every pair has the same padding and margins
                      // whether focused or not, so focus moving never shifts
                      // the text, and the view with it.
                      className="space-y-3 rounded-md"
                      style={{
                        margin: "0 -10px",
                        padding: "8px 10px 8px 9px",
                        borderLeft: `3px solid ${focused ? "var(--accent)" : "transparent"}`,
                        background: focused ? "rgba(230,237,243,0.07)" : "transparent",
                        boxShadow: focused ? "0 0 0 1px rgba(225,195,105,0.45)" : "none",
                        transition: "background-color 0.2s, border-color 0.2s, box-shadow 0.2s",
                      }}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        // Buttons, links and boxes in the pair are their own
                        // thing; and a drag that selected text is not a click
                        if (target.closest("button, a, textarea, input, select, [data-editing], [data-quote-chip]")) return;
                        if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return;
                        focusPair(annotation.id, pair.start);
                      }}
                    >
                      {annotation.messages.slice(pair.start, pair.end).map((m, k) => renderMessage(m, pair.start + k))}
                      {/* Stop belongs to the pair being answered, inside its box */}
                      {pair.end === annotation.messages.length && streamingIds.has(annotation.id) && onStop && (
                        <div className="pt-0.5">
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
                    </div>
                  );
                })}
              </div>

              </>)}
            </div>
          );
          function renderMessage(msg: Message, i: number) {
                  const isUser = msg.role === "user";
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
                      data-question={isUser ? "" : undefined}
                      className={isUser ? "rounded-md" : ""}
                      // Room above when scrolled to, so a landed-on question is
                      // not flush against the panel's edge. A question sits in
                      // a solid grey box with its label, apart from the answer.
                      // A question sits on a soft blue, its label blue too:
                      // the reader's hue, against the explainer's gold. Its
                      // side margins undo its side padding, so its label's
                      // bullet lines up with the answer's.
                      style={{ scrollMarginTop: 12, ...(isUser ? { background: "var(--you-dim, rgba(96,150,230,0.13))", padding: "8px 9px", margin: "0 -9px" } : {}) }}
                    >
                      <p className="text-[10px] font-semibold mb-1 tracking-wide uppercase flex items-center gap-1.5" style={{ color: isUser ? "var(--you-bright, #8DB8F5)" : "var(--accent)" }}>
                        <span
                          className="w-1.5 h-1.5 rounded-full inline-block"
                          style={{ background: isUser ? "var(--you, #6FA3EF)" : "linear-gradient(135deg, var(--accent-bright), var(--accent))" }}
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
                                // The box being typed in, so clicking a held quote drops its
                                // label here like in any other box
                                onFocus={(e) => {
                                  const el = e.currentTarget;
                                  lastBox.current = { el, setText: (update) => setEditDraft((prev) => update(prev)) };
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
                                {asked!.quotes.length > 0 && foldedQuotes.has(`${annotation.id}:${i}`) && (
                                  <button
                                    type="button"
                                    data-quote-fold=""
                                    onClick={() => setFoldedQuotes((prev) => { const next = new Set(prev); next.delete(`${annotation.id}:${i}`); return next; })}
                                    className="inline-flex items-center gap-1 text-[11px] mb-1.5 px-1.5 py-0.5 rounded hover:opacity-80"
                                    style={{ background: "var(--quote-dim)", border: "1px solid var(--quote)", color: "var(--ink-muted)" }}
                                    title="Show the quoted passages"
                                  >
                                    <span style={{ color: "var(--quote)" }}>❝</span>
                                    {asked!.quotes.length} quoted passage{asked!.quotes.length === 1 ? "" : "s"}
                                    <span style={{ color: "var(--quote)" }}>▸</span>
                                  </button>
                                )}
                                {asked!.quotes.length > 0 && !foldedQuotes.has(`${annotation.id}:${i}`) && (
                                  <div data-quote-chip="" className="flex flex-col items-start gap-1 mb-1.5">
                                    {asked!.quotes.map((q, n) => (
                                      <button
                                        key={n}
                                        onClick={() =>
                                          q.origin === "paper" && onCitePaper
                                            ? onCitePaper(q.page ?? 1, q.text, annotation.id)
                                            : goToPassage(`${annotation.id}:${i}:${n}`, q.source)
                                        }
                                        className="inline-flex items-center gap-1 max-w-full text-[11px] pl-1 pr-1.5 py-0.5 rounded transition-colors hover:opacity-80"
                                        style={{ background: "var(--quote-dim)", border: "1px solid var(--quote)", color: "var(--ink-muted)" }}
                                        title={`Go back to this passage${q.origin === "paper" ? ` in the paper${q.page ? ` (page ${q.page})` : ""}` : q.source ? ` in “${q.source}”` : ""}\n\n${q.text}`}
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
                          streaming={streamingIds.has(annotation.id) && i === annotation.messages.length - 1}
                        />
                      )}
                    </div>
                  );
          }
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

      {quoteStrip}

      {composer}
    </div>
  );
}
