// What a model behind a third-party API is told about the paper with each
// question, besides the paper's map: the conversations had about it so far
// and what each worked out, which one I am asking in, and that conversation's
// latest exchanges — the one just before this question above all, since a
// follow-up usually carries straight on from it. The rest it reads on demand
// (lib/endpoint-tools); it is no longer sent the recent part of every
// conversation, and the paper's text, with every question.

import type { Annotation, ConceptEntry } from "@/types/session";
import type { ThreadEntry } from "./session-store";

export type ConversationSummary = {
  id: string;
  // What the model calls it by: short, and never shown to me
  handle: string;
  about: string;
  exchanges: number;
  notes: string[];
  current: boolean;
};

const tidy = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const handleOf = (id: string) => id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8);

/** The conversations of a paper as its panel last saved them, with their notes. */
export function conversationsOf(state: Record<string, unknown> | null, current?: string): ConversationSummary[] {
  const annotations = (Array.isArray(state?.annotations) ? state.annotations : []) as Annotation[];
  const concepts = (Array.isArray(state?.concepts) ? state.concepts : []) as ConceptEntry[];
  return annotations.map((a) => {
    const page = a.pageNumber ? `page ${a.pageNumber}, ` : "";
    const about = a.type === "image"
      ? `${page}a figure I captured`
      : a.selectedText
        ? `${page}the passage "${tidy(a.selectedText, 90)}"`
        : "a question about the paper";
    const takeaways = concepts.find((c) => c.annotationId === a.id)?.takeaways ?? [];
    // Not summarised yet: what was asked first says what it is about
    const first = a.messages.find((m) => m.role === "user" && m.content.trim())?.content;
    const notes = takeaways.length
      ? takeaways.slice(0, 4).map((t) => tidy(t, 160))
      : first ? [`first asked: ${tidy(first, 140)}`] : [];
    return {
      id: a.id,
      handle: handleOf(a.id),
      about,
      exchanges: a.messages.filter((m) => m.role === "assistant" && m.content.trim()).length,
      notes,
      current: a.id === current,
    };
  });
}

const OVERVIEW_CHARS = 9000;

export function overviewSection(conversations: ConversationSummary[], opts: { tools: boolean }): string {
  if (!conversations.length) return "";
  const lines: string[] = [];
  let chars = 0;
  // The one asked in first, so a long list never cuts it off
  for (const c of [...conversations].sort((a, b) => Number(b.current) - Number(a.current))) {
    const block = [
      `${c.current ? "▶" : "-"} [${c.handle}] ${c.about} — ${c.exchanges} ${c.exchanges === 1 ? "exchange" : "exchanges"}${c.current ? " (the one I am asking in now)" : ""}`,
      ...c.notes.map((n) => `    · ${n}`),
    ].join("\n");
    if (chars + block.length > OVERVIEW_CHARS && lines.length) {
      lines.push(`- … and ${conversations.length - lines.length} more`);
      break;
    }
    lines.push(block);
    chars += block.length;
  }
  const how = opts.tools
    ? "Each is named by an id in brackets: read_conversation with it gives every question and answer of that one. The ids are only for you; never write one to me."
    : "The ids in brackets are only for you; never write one to me.";
  return `Our conversations about this paper so far, and what each worked out (▶ marks the one I am asking in):\n${lines.join("\n")}\n${how}`;
}

/**
 * The latest exchanges of the conversation asked in, newest-biased within a
 * budget — never fewer than the last one, however long, since this question
 * most likely follows on from it.
 */
export function recentExchanges(entries: ThreadEntry[], budget: number): ThreadEntry[] {
  // Exchanges begin at a question; a conversation that began with an answer
  // (a passage explained with no question of mine) begins with that
  const starts = entries.map((e, i) => (i === 0 || e.role === "user" ? i : -1)).filter((i) => i >= 0);
  let from = entries.length;
  let chars = 0;
  for (let k = starts.length - 1; k >= 0; k--) {
    const size = entries.slice(starts[k], from).reduce((n, e) => n + e.text.length, 0);
    if (from < entries.length && chars + size > budget) break;
    chars += size;
    from = starts[k];
  }
  return entries.slice(from);
}
