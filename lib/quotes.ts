// Quoting inside the Explain panel.
//
// Selecting text in one conversation and carrying it into a question asked in
// another is what keeps the panel a single workspace rather than a pile of
// independent chats. The quote travels as part of the question text, so every
// provider handles it without knowing anything about the feature.

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

// Blockquote the passages above the question. Markdown, because that is what
// every provider is already being handed and what the panel renders back.
export function withQuotes(question: string, quotes: Quote[]): string {
  const usable = quotes.filter((q) => q.text.trim());
  if (usable.length === 0) return question;

  const blocks = usable.map((q) => {
    const body = q.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return q.source ? `${body}\n>\n> — from “${q.source}”` : body;
  });

  const lead =
    usable.length === 1
      ? "Referring to this, which I selected from our conversation:"
      : "Referring to these, which I selected from our conversation:";
  return `${lead}\n\n${blocks.join("\n\n")}\n\n${question}`;
}
