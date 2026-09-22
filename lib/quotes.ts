// Quoting inside the Explain panel.
//
// Selecting text in one conversation and carrying it into a question asked in
// another is what keeps the panel a single workspace rather than a pile of
// independent chats. The quote travels as part of the question text, so every
// provider handles it without knowing anything about the feature.
//
// Several passages can be held at once, and they are numbered. The number is
// the whole point of holding more than one: it turns "the thing I pasted" into
// something both sides can name, so a question can say "why does [1] contradict
// [2]?" and be answered precisely. The label shown on a chip and the label sent
// to the model are the same string, produced here, so they cannot drift.

export type Quote = {
  id: string;
  text: string;
  // The conversation it came from, so the model knows whose words these are
  source?: string;
  // Taken from the paper itself rather than from a conversation — the page
  // it was on, so the chip can lead back to it
  origin?: "paper";
  page?: number;
};

// How a quote is credited in the prompt: the conversation it came from, or the
// paper and the page
function quoteHead(q: Quote | QuotedPassage, index: number): string {
  if (q.origin === "paper") return `${quoteLabel(index)} from the paper${q.page ? `, page ${q.page}` : ""}`;
  return q.source ? `${quoteLabel(index)} from “${q.source}”` : quoteLabel(index);
}

// The sentence introducing the quotes says where they were taken from, so the
// model reads a passage of the paper as the paper's words and a passage of an
// answer as its own
function quoteLead(quotes: { origin?: "paper" }[]): string {
  const paper = quotes.some((q) => q.origin === "paper");
  const conversation = quotes.some((q) => q.origin !== "paper");
  const from = paper && conversation ? "from the paper and from our conversation" : paper ? "from the paper" : "from our conversation";
  return quotes.length === 1
    ? `A passage I selected ${from}, labelled so I can refer to it:`
    : `Passages I selected ${from}, labelled so I can refer to them:`;
}

// Long selections are trimmed for the chip only; the question carries the
// whole thing.
export const QUOTE_PREVIEW_CHARS = 60;

export function quotePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_PREVIEW_CHARS ? `${flat.slice(0, QUOTE_PREVIEW_CHARS)}…` : flat;
}

// How a quote is named, in the chip and in the prompt alike
export function quoteLabel(index: number): string {
  return `[${index + 1}]`;
}

// The same passage picked twice is one quote, not two — otherwise the numbering
// drifts away from what the reader thinks it selected.
export function addQuote(quotes: Quote[], next: Quote): Quote[] {
  const same = (a: Quote, b: Quote) => a.text.trim() === b.text.trim() && a.source === b.source;
  return quotes.some((q) => same(q, next)) ? quotes : [...quotes, next];
}

export function withQuotes(question: string, quotes: Quote[]): string {
  const usable = quotes.filter((q) => q.text.trim());
  if (usable.length === 0) return question;

  const blocks = usable.map((q, i) => {
    const head = quoteHead(q, i);
    const body = q.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${head}\n${body}`;
  });

  return `${quoteLead(usable)}\n\n${blocks.join("\n\n")}\n\n${question}`;
}

// ── Reading a question back ───────────────────────────────────────────
// A question that carried passages stores them inside its own text, so the
// link between a passage and the question that quoted it needs nothing new on
// disk: it is recovered by parsing the question back into its parts. That also
// makes every conversation already saved jumpable, not just the ones asked
// from here on.

export type QuotedPassage = {
  label: string;
  text: string;
  source?: string;
  origin?: "paper";
  page?: number;
};

// Matches exactly what withQuotes writes, both singular and plural, and every
// combination of where the passages came from
const LEAD =
  /^(?:A passage|Passages) I selected from (?:our conversation|the paper|the paper and from our conversation), labelled so I can refer to (?:it|them):\n\n/;
const BLOCK = /^\[(\d+)\](?: from “([^”]*)”| from the paper(?:, page (\d+))?)?\n((?:>.*(?:\n|$))+)/;

export function parseQuotes(content: string): { quotes: QuotedPassage[]; question: string } {
  const lead = LEAD.exec(content);
  if (!lead) return { quotes: [], question: content };

  let rest = content.slice(lead[0].length);
  const quotes: QuotedPassage[] = [];
  for (;;) {
    const block = BLOCK.exec(rest);
    if (!block) break;
    const text = block[4]
      .split("\n")
      .filter((line) => line.startsWith(">"))
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim();
    const fromPaper = block[0].startsWith(`[${block[1]}] from the paper`);
    quotes.push({
      label: `[${block[1]}]`,
      text,
      source: block[2] || undefined,
      ...(fromPaper ? { origin: "paper" as const, page: block[3] ? Number(block[3]) : undefined } : {}),
    });
    rest = rest.slice(block[0].length).replace(/^\n+/, "");
  }

  // A lead with nothing under it is not a quoted question — leave it whole
  // rather than swallow the reader's own words
  return quotes.length > 0 ? { quotes, question: rest.trim() } : { quotes: [], question: content };
}
