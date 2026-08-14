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
};

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
    const head = q.source ? `${quoteLabel(i)} from “${q.source}”` : quoteLabel(i);
    const body = q.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${head}\n${body}`;
  });

  const lead =
    usable.length === 1
      ? "A passage I selected from our conversation, labelled so I can refer to it:"
      : "Passages I selected from our conversation, labelled so I can refer to them:";
  return `${lead}\n\n${blocks.join("\n\n")}\n\n${question}`;
}
