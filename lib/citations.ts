// Citations the model writes into its own answers.
//
// An answer that says "as the paper puts it, …" is only half useful: the reader
// still has to go and find the place. So the model is asked to write its
// references as markdown links with two private schemes, and the panel turns
// those into something clickable that lands on the words themselves.
//
//   [verbatim excerpt](paper:12)   →  that passage, on page 12 of the paper
//   [what we settled earlier](turn:7)  →  my 7th message in this conversation
//
// Markdown links are the carrier because every provider already writes markdown
// and none of them has to know the feature exists — and because a link that
// arrives half-written during streaming renders as ordinary text rather than as
// broken markup.

export type Citation =
  | { kind: "paper"; page: number }
  | { kind: "turn"; turn: number };

// A page-less document (an HTML snapshot) has nothing to number, so a bare
// `paper:` is read as its one and only page
const PAPER = /^paper(?::(\d+))?$/;
const TURN = /^turn:(\d+)$/;

export function parseCitation(href: string | undefined): Citation | null {
  const raw = href?.trim();
  if (!raw) return null;

  const paper = PAPER.exec(raw);
  if (paper) {
    const page = paper[1] ? Number(paper[1]) : 1;
    return page >= 1 ? { kind: "paper", page } : null;
  }

  const turn = TURN.exec(raw);
  if (turn) {
    const n = Number(turn[1]);
    return n >= 1 ? { kind: "turn", turn: n } : null;
  }

  // Anything else is an ordinary link — a resource the model recommended
  return null;
}

// How each of my messages is numbered for the model, so it can point back at
// one. It rides on the message itself rather than in the bootstrap, because on
// a resumed session the bootstrap is thousands of tokens behind.
export function turnMarker(turn: number): string {
  return `[turn ${turn}]`;
}

// Text extracted from a PDF has a space between every CJK glyph — "T op K
// ke rn e l" — so a quote the model copies verbatim from it is unreadable as a
// label even though it matches the page perfectly. Matching ignores whitespace
// anyway, so the display copy can be tidied without breaking the jump.
const CJK = "\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF";
const BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g");

export function citationLabel(text: string): string {
  return text.replace(/\s+/g, " ").replace(BETWEEN_CJK, "$1").trim();
}
