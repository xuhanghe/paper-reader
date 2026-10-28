"use client";
import { Fragment, cloneElement, isValidElement, memo, useDeferredValue, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "@/lib/math-delimiters";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { citationLabel, parseCitation, unwrapCodedCitations } from "@/lib/citations";

// How a model's answer is rendered, wherever an answer is shown: the Reader's
// conversations and the Workspace agent's. One renderer, so the two surfaces
// show the same Markdown, the same formulas and the same citations, and both
// stream without re-parsing everything already said.

export type MarkdownComponents = {
  a: (props: { href?: string; children?: React.ReactNode }) => React.ReactElement;
};

// react-markdown drops link protocols it does not recognise — a safe default,
// and it silently emptied the href of every citation the model wrote. The two
// private schemes are allowed through by name; everything else still goes
// through the sanitiser.
export const citationUrlTransform = (url: string): string =>
  parseCitation(url) ? url : defaultUrlTransform(url);

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

export const MarkdownAnswer = memo(function MarkdownAnswer({
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
  const blocks = useMemo(() => splitMarkdownBlocks(normalizeMathDelimiters(unwrapCodedCitations(shown))), [shown]);
  return (
    <div className="prose-paper">
      {blocks.map((text, i) => (
        <Block key={i} text={text} components={components} />
      ))}
    </div>
  );
});

// ── Citations the model writes ──────────────────────────────────────
// The model links what it is drawing on: `paper:12` for a passage, `turn:7`
// for something already settled in this conversation. Both become jumps;
// anything else it links to stays an ordinary link. The Reader and the
// Workspace agent show them the same way.
//
// The handlers arrive through a ref rather than as props so the components a
// panel hands to MarkdownAnswer keep their identity across renders —
// recreating them on every streaming chunk would remount every citation in
// the answer, taking the reader's selection with it.

// Click-time behaviour, read from a ref when a citation is actually clicked.
// What has to be decided while rendering — whether the target exists at all —
// arrives as a plain prop, so nothing reads a ref during render.
export type CiteHandlers = {
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

export function CitationAnchor({
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
        // The reader never sees turn numbers, so the tag carries none
        title="Go back to that question"
      >
        {label}
        <span className="pr-cite-tag">↩</span>
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
