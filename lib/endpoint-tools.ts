// The tools a model behind a third-party API reads the paper with.
//
// Such a model has no files of its own, and cannot reach anything on this
// machine. So it is told what these tools are, and when it calls one the
// server runs it here and sends back what it returned (lib/providers runs
// that loop). The model is sent an overview with each question instead of
// the paper's text and the recent conversation, and fetches the rest itself.
//
// The reading rule holds here too: pages past the one I have reached are not
// given out, unless I asked about the paper as a whole.

import { readFile } from "node:fs/promises";
import { paperPathFor, readPageImageDataUrl, conversationEntries } from "./session-store";
import { askedText } from "./session-recovery";
import type { ConversationSummary } from "./endpoint-context";

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
// What a tool gives back: words for the model, images when it looked at a
// page, and what the panel shows while it runs
export type ToolResult = { text: string; images?: string[]; activity: string };

export type ToolContext = {
  paperId: string;
  // The page I have reached; later ones stay out unless `wholePaper`
  readUpTo?: number;
  wholePaper: boolean;
  vision: boolean;
  conversations: ConversationSummary[];
};

const MAX_PAGES = 6;
const MAX_CHARS = 16000;

export function toolSpecs(ctx: Pick<ToolContext, "vision">): ToolSpec[] {
  const specs: ToolSpec[] = [
    {
      name: "read_paper",
      description: "Read pages of the paper's extracted text, each headed by its [page N] marker. Up to 6 pages at a time, and only up to the page I have reached, unless I asked about the paper as a whole.",
      parameters: {
        type: "object",
        properties: {
          from_page: { type: "integer", minimum: 1, description: "First page to read" },
          to_page: { type: "integer", minimum: 1, description: "Last page to read; the first page alone when left out" },
        },
        required: ["from_page"],
      },
    },
    {
      name: "search_paper",
      description: "Find where a word or phrase occurs in the paper, up to the page I have reached: short snippets with their pages.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A word or a short phrase, as it would appear in the paper" } },
        required: ["query"],
      },
    },
    {
      name: "read_conversation",
      description: "Read one of our conversations about this paper in full — every question of mine and every answer — by the id it has in the list of conversations.",
      parameters: {
        type: "object",
        properties: { conversation: { type: "string", description: "The id in brackets from the list of conversations" } },
        required: ["conversation"],
      },
    },
  ];
  if (ctx.vision) {
    specs.push({
      name: "view_page",
      description: "See a page of the paper as an image, when its layout, a figure, a table or an equation matters. Only up to the page I have reached, unless I asked about the paper as a whole.",
      parameters: {
        type: "object",
        properties: { page: { type: "integer", minimum: 1 } },
        required: ["page"],
      },
    });
  }
  return specs;
}

/** The paper's text, page by page, off its [page N] markers. */
export function paperPages(text: string): Map<number, string> {
  const pages = new Map<number, string>();
  const parts = text.split(/^\[page (\d+)\]\s*$/m);
  for (let i = 1; i < parts.length; i += 2) pages.set(Number(parts[i]), parts[i + 1].trim());
  // A document with no markers is one page
  if (!pages.size && text.trim()) pages.set(1, text.trim());
  return pages;
}

/**
 * The paper's text up to a page, for a model that cannot call tools: the
 * pages nearest that one when they do not all fit.
 */
export function paperTextUpTo(text: string, upTo: number | undefined, budget: number): string {
  const pages = [...paperPages(text)].filter(([n]) => !upTo || n <= upTo);
  const kept: string[] = [];
  let chars = 0;
  for (let i = pages.length - 1; i >= 0; i--) {
    const block = `[page ${pages[i][0]}]\n${pages[i][1]}`;
    if (chars + block.length > budget && kept.length) break;
    kept.unshift(block.slice(0, budget));
    chars += block.length;
  }
  return kept.join("\n\n");
}

const int = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : undefined;
};
const limitOf = (ctx: ToolContext) => (ctx.wholePaper || !ctx.readUpTo ? Infinity : ctx.readUpTo);
const later = (ctx: ToolContext, page: number) =>
  `I am at page ${ctx.readUpTo}; page ${page} comes later and stays out until I get there.`;

async function readPaperText(ctx: ToolContext): Promise<Map<number, string>> {
  try {
    return paperPages(await readFile(paperPathFor(ctx.paperId), "utf8"));
  } catch {
    return new Map();
  }
}

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const limit = limitOf(ctx);

  if (name === "read_paper") {
    const from = Math.max(1, int(a.from_page) ?? 1);
    let to = Math.max(from, int(a.to_page) ?? from);
    const notes: string[] = [];
    if (to - from + 1 > MAX_PAGES) {
      to = from + MAX_PAGES - 1;
      notes.push(`(Only pages ${from}–${to}: ${MAX_PAGES} at a time.)`);
    }
    const activity = from === to ? `Reading page ${from}` : `Reading pages ${from}–${to}`;
    if (from > limit) return { text: later(ctx, from), activity };
    if (to > limit) {
      to = limit;
      notes.push(`(Up to page ${limit}, where I am; the rest comes later.)`);
    }
    const pages = await readPaperText(ctx);
    if (!pages.size) return { text: "The paper's text is not available.", activity };
    let text = "";
    for (let n = from; n <= to; n++) {
      const page = pages.get(n);
      if (page !== undefined) text += `[page ${n}]\n${page}\n\n`;
    }
    if (!text) return { text: `There is no page ${from}${from === to ? "" : `–${to}`}; the paper has ${pages.size}.`, activity };
    if (text.length > MAX_CHARS) notes.push("(Cut short here; read fewer pages to see the rest.)");
    return { text: [text.slice(0, MAX_CHARS).trim(), ...notes].join("\n\n"), activity };
  }

  if (name === "search_paper") {
    const query = typeof a.query === "string" ? a.query.replace(/\s+/g, " ").trim() : "";
    const activity = `Searching the paper for "${query.slice(0, 40)}"`;
    if (!query) return { text: "Nothing to search for.", activity };
    const pages = await readPaperText(ctx);
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (const [n, page] of pages) {
      if (n > limit) continue;
      const flat = page.replace(/\s+/g, " ");
      const lower = flat.toLowerCase();
      for (let at = lower.indexOf(needle); at >= 0 && hits.length < 8; at = lower.indexOf(needle, at + needle.length)) {
        const start = Math.max(0, at - 160);
        hits.push(`[page ${n}] ${start > 0 ? "…" : ""}${flat.slice(start, at + needle.length + 160)}…`);
      }
      if (hits.length >= 8) break;
    }
    const scope = limit === Infinity ? "in the paper" : `up to page ${limit}`;
    return { text: hits.length ? hits.join("\n\n") : `No "${query}" ${scope}. Try other words, or read the pages around it.`, activity };
  }

  if (name === "read_conversation") {
    const wanted = typeof a.conversation === "string" ? a.conversation.replace(/[[\]\s]/g, "") : "";
    const found = ctx.conversations.find((c) => c.handle === wanted || c.id === wanted);
    if (!found) return { text: `There is no conversation "${wanted}". The ids are the ones in brackets in the list of conversations.`, activity: "Looking for a conversation" };
    const activity = `Reading the conversation on ${found.about}`;
    const entries = await conversationEntries(ctx.paperId, found.id);
    if (!entries.length) return { text: "That conversation has nothing in it yet.", activity };
    let text = entries
      .map((e) => (e.role === "user" ? `Me: ${askedText(e.text)}${e.imageFile || e.hasImage ? " (with a figure attached)" : ""}` : `You: ${e.text.trim()}`))
      .join("\n\n");
    // The newest part matters most when it does not all fit
    if (text.length > MAX_CHARS) text = `(Its beginning is left out.)\n\n…${text.slice(-MAX_CHARS)}`;
    return { text, activity };
  }

  if (name === "view_page" && ctx.vision) {
    const page = Math.max(1, int(a.page) ?? 1);
    const activity = `Looking at page ${page}`;
    if (page > limit) return { text: later(ctx, page), activity };
    const image = await readPageImageDataUrl(ctx.paperId, page);
    return image ? { text: `Page ${page} is attached as an image.`, images: [image], activity } : { text: `There is no image of page ${page}.`, activity };
  }

  return { text: `There is no tool called ${name}.`, activity: "Working" };
}
