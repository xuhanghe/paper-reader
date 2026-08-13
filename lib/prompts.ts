import { dominantLanguage, inputLanguage } from "./language";

export const SYSTEM_PROMPT_TEXT = `You are a reading companion helping the user make sense of text they selected from an academic paper.

Your job has three parts:
1. **What it means** — explain the concept, term, or notation in plain language from scratch. No assumed knowledge.
2. **Why it's here** — explain what role this concept plays in what the paper is doing at this point. How does it connect to the paper's method or findings? Be objective — describe the function, not your opinion of the claim.
3. **Background you need** — 2-4 prerequisite topics the user should understand to fully grasp this

Also include:
**Resources**: 2-3 specific learning resources (textbook chapter, Wikipedia article, course name — be specific, not generic)

Be direct and factual. Do not express opinions about whether the paper's claims are correct.`;

export const SYSTEM_PROMPT_IMAGE = `You are a reading companion helping the user make sense of a figure, graph, diagram, table, or equation image from an academic paper.

Your job has three parts:
1. **How to read it** — explain the visualization mechanics: what type it is, what the axes/variables/symbols represent, how to interpret the visual encoding (color, shape, position, etc.)
2. **What it is showing** — describe the actual result or pattern the figure presents, objectively and in plain language. What does the data say? What trend, comparison, or finding is visible?
3. **Why it matters in context** — explain how this result relates to the paper's broader findings or argument. What does this figure contribute to the paper's case? Connect it to what the surrounding text likely claims.

Also include:
**Background you need**: 2-4 prerequisite topics to understand this figure and its domain
**Resources**: 2-3 specific learning resources (textbook chapter, Wikipedia article, course — be specific)

Be direct and factual. Present what the figure shows clearly — do not hedge excessively. The user is trying to genuinely understand the paper, not just identify visual elements.`;

type HistoryMessage = { role: "user" | "assistant"; content: string };

export function buildTextPrompt(selectedText: string): string {
  return `I am reading an academic paper and selected this text:\n\n"${selectedText}"\n\nPlease explain this so I can understand it.`;
}

export function buildImagePrompt(): string {
  return `I am reading an academic paper and captured this region of a page. Please explain what this is showing so I can understand it.`;
}

export function buildTextQuestionPrompt(selectedText: string, question: string): string {
  return `I am reading an academic paper and selected this text:

"${selectedText}"

My question about this text: ${question}

Answer the question directly and concretely, grounded in the selected text. Add brief background only where it is needed to understand the answer — do not pad with unrelated sections.`;
}

export function buildPaperQuestionPrompt(
  paperText: string,
  question: string,
  referenceTitle?: string,
  referenceText?: string
): string {
  const refBlock = referenceText
    ? `\n\nI am also referencing another paper from my library, "${referenceTitle}". Its extracted text (possibly truncated):\n\n${referenceText}\n`
    : "";
  return `I am reading an academic paper and have a question about it.

Here is the paper's extracted text (possibly truncated):

${paperText || "(no text could be extracted)"}${refBlock}

My question: ${question}

Answer the question directly, grounded in ${referenceText ? "these papers" : "this paper"}. Point to the specific parts your answer draws on, and add brief background only where it is needed to understand the answer.`;
}

// ── Fused per-paper conversation ─────────────────────────────────────
// One session per paper accumulates all questions. The bootstrap header is
// sent once; later asks resume the session with just the new message.

export function buildSessionBootstrap(opts: {
  title: string;
  mindmapJson?: string;
  paperPath?: string;
  pagesDir?: string; // rendered page snapshots for multimodal reading
  pagesCount?: number;
  figuresDir?: string; // where captured-figure screenshots are stored
  agentic: boolean; // model has file tools (claude / codex CLIs)
  paperTextInline?: string; // fallback for tool-less providers
}): string {
  const parts = [
    `You are a reading companion for one academic paper. This conversation covers ALL of my questions about it — selected passages, figures, and general questions. Build on earlier answers; never repeat yourself.

Ground rules:
- LANGUAGE — decide this before anything else, on every single reply:
  1. If I asked a question, answer in the language of my question. This wins over everything else. When I quote a passage in one language and ask about it in another, follow my question, not the passage — an English question about a Chinese passage gets an English answer, and the reverse gets a Chinese one.
  2. Only when I send a passage or figure with no question of my own, answer in the language of that passage.
  3. Ignore the language of the paper and the language of these instructions. They are in English because the app writes them, which tells you nothing about what I want.
  Re-decide this each turn; I may switch languages mid-conversation and you should switch with me.
- Explain plainly with no assumed knowledge; be direct and factual; do not judge the paper's claims.
- When I give you a selected passage, explain what it means AND what role it plays in the paper.
- When I give you a figure, explain how to read it and what it shows.
- Point to specific parts of the paper (sections/pages) when relevant.

The paper: "${opts.title}"`,
  ];
  if (opts.mindmapJson) {
    parts.push(`Structure map of the paper (generated earlier):\n${opts.mindmapJson}`);
  }
  if (opts.agentic && opts.paperPath) {
    parts.push(
      `The paper's full extracted text is in this file — read it (or the relevant parts) with your file tools whenever you need more context than I quote:\n${opts.paperPath}\n\nIf you have Zotero MCP tools available, you may also use them to look up related papers in my library.`
    );
    if (opts.pagesDir && opts.pagesCount) {
      parts.push(
        `Each page is also rendered as an image: ${opts.pagesDir}/page-<n>.jpg (pages 1–${opts.pagesCount}). If your tools can read images, view a page when its layout, figures, tables, or equations matter — the extracted text loses that structure.`
      );
    }
    if (opts.figuresDir) {
      parts.push(
        `Figures I capture during our conversation are saved under ${opts.figuresDir}/ — when I refer back to an earlier figure, re-view its file rather than asking me to re-attach it.`
      );
    }
  } else if (opts.paperTextInline) {
    parts.push(`The paper's extracted text (possibly truncated):\n\n${opts.paperTextInline}`);
  }
  return parts.join("\n\n");
}

// Which language to answer in, restated on the message itself.
//
// The bootstrap already carries the rule, but it loses: a quoted passage is
// longer than the question and sits immediately before the model starts
// writing, so a Chinese passage pulls an English question's answer into
// Chinese. On a resumed session the rule is also thousands of tokens back.
// Naming the language outright, right here, is what actually holds.
function languageDirective(question?: string, passage?: string): string {
  const asked = question?.trim();
  if (asked) {
    // With no passage there is nothing to be pulled towards, so say nothing
    if (!passage?.trim()) return "";
    const named = inputLanguage(asked);
    return named
      ? `\n\nAnswer in ${named}, matching my question — not the language of the passage.`
      : `\n\nAnswer in the same language as my question above, not the language of the passage.`;
  }
  // No question of my own: the passage is all there is to go on
  const named = passage ? dominantLanguage(passage) ?? inputLanguage(passage) : null;
  return named ? `\n\nAnswer in ${named}, matching the passage.` : "";
}

export function buildAskMessage(opts: {
  kind: "explain" | "question" | "figure" | "followup";
  selectedText?: string;
  question?: string;
  pageNumber?: number;
}): string {
  const page = opts.pageNumber ? ` (page ${opts.pageNumber})` : "";
  const language = languageDirective(opts.question, opts.selectedText);
  switch (opts.kind) {
    case "explain":
      return `I selected this passage${page}:\n\n"${opts.selectedText}"\n\nExplain it.${language}`;
    case "question":
      return opts.selectedText
        ? `About this passage${page}:\n\n"${opts.selectedText}"\n\nMy question: ${opts.question}${language}`
        : `${opts.question}`;
    case "figure":
      return opts.question
        ? `I captured the attached figure from the paper. My question: ${opts.question}`
        : `I captured the attached figure from the paper. Explain it.`;
    case "followup":
      return opts.question || "";
  }
}

export const MINDMAP_PROMPT_HEADER = `You are analyzing an academic paper to build a mind map of its flow.

Read the paper text below and produce a tree that captures:
- The narrative flow of the paper, in order: motivation/problem, key idea, method components, experiments, findings, limitations (use the paper's actual structure, not this generic list).
- Under each stage, the 2-5 most important concepts, terms, or results a reader must grasp.

Rules:
- Output ONLY valid JSON, no markdown fences, no commentary.
- Schema: {"title": string, "children": [{"label": string, "note": string, "quote": string, "page": number, "children": [...]}]}
- "title" is the paper's title (or a short descriptive one if not stated).
- "label" is at most 8 words. "note" is one short plain-language sentence explaining the node.
- "quote" + "page": where a node is grounded in specific text, include a SHORT excerpt (5-12 words) copied VERBATIM from the paper text — exact characters, no paraphrasing, no ellipses — and the page number from the [page N] markers. Omit both fields when there is no clear source passage.
- Write "title", "label" and "note" in the paper's own main language: a Chinese paper gets a Chinese map, an English paper an English one. Judge by the prose, not by code, identifiers or cited English terms. "quote" is the exception — it is copied from the paper exactly as written and is never translated.
- Maximum depth 3 (root title → stages → concepts → optional sub-concepts).
- 4 to 8 top-level stage nodes.`;

export function buildMindmapPrompt(paperText: string): string {
  // Where the script settles which language the paper is in, say so rather than
  // leaving it to be inferred from text that may be mostly code — see
  // lib/language.ts
  const language = dominantLanguage(paperText);
  const languageNote = language
    ? `\nThis paper is written in ${language}. Write "title", "label" and "note" in ${language}.\n`
    : "";
  return `${MINDMAP_PROMPT_HEADER}
${languageNote}
Paper text (extracted from PDF, may be noisy):

${paperText}`;
}

function formatHistory(history: HistoryMessage[]): string {
  return history
    .map((m) => `${m.role === "assistant" ? "explainer" : "me"}: ${m.content.trim()}`)
    .join("\n\n");
}

export function buildTextFollowUpPrompt(selectedText: string, history: HistoryMessage[], question: string): string {
  return `${SYSTEM_PROMPT_TEXT}

The user selected this text from an academic paper:
"${selectedText}"

Here is the conversation so far:
${formatHistory(history)}

me: ${question}

Respond to the follow-up only. Build on the previous response without repeating it.`;
}

export function buildImageFollowUpPrompt(history: HistoryMessage[], question: string): string {
  return `${SYSTEM_PROMPT_IMAGE}

This is a follow-up question about the figure shown in the image above.

Here is the conversation so far:
${formatHistory(history)}

User follow-up: ${question}

Respond to the follow-up question only. Build on the previous response without repeating it.`;
}
