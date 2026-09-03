// Where a passage sits on its page, in PDF-space rectangles — the format
// Zotero stores annotations in, and zoom-independent. Recorded at selection
// time, when the position is known exactly, so painting never has to re-derive
// it from the text layer's unreliable geometry.
export type PdfRects = { pageIndex: number; rects: number[][] };

export type AnnotationType = "text" | "image";

export type Message = {
  role: "user" | "assistant";
  content: string;
  imageDataUrl?: string; // figure attached to a user message
  // The number this ask was given in the fused thread. An answer citing
  // `turn:N` resolves to the message carrying it. Absent on messages from
  // before citations existed, and on ones the model never saw.
  turn?: number;
};

export type Annotation = {
  id: string;
  type: AnnotationType;
  label: string;
  selectedText?: string;
  imageDataUrl?: string;
  messages: Message[];
  createdAt: number;
  sessionId?: string;
  pageNumber?: number; // PDF page where the text was selected
  // Which of the identical passages on that page it was; see Highlight
  occurrence?: number;
  position?: PdfRects; // where it sits, recorded when it was selected
  // A passage selected across pages: where each page's share sits, and the
  // words on that page, so every page can be marked. `position` and
  // `pageNumber` describe the first of these.
  positions?: (PdfRects & { text?: string })[];
};

export type ConceptEntry = {
  annotationId: string;
  label: string;
  type: AnnotationType;
  // What the conversation established, a few lines at most. Absent until it
  // has been summarised — the label alone says where you asked something, not
  // what you learned.
  takeaways?: string[];
  // How many messages the summary covers, so it can tell when it is out of date
  summarizedTurns?: number;
  // Touched by hand. The automatic pass then leaves it alone — a summary
  // rewriting someone's own notes is worse than a stale one.
  edited?: boolean;
};

// "claude-*" ids run via the claude CLI; "codex" via the codex CLI;
// "custom" via a user-configured OpenAI-compatible endpoint
export type Model = string;

export type CustomApiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  vision?: boolean;
  // Wire format the endpoint speaks; absent in configs saved before this
  // existed, which stay on OpenAI
  format?: "openai" | "anthropic";
  maxTokens?: number; // Anthropic requires one; defaults to 8192
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type MindmapNode = {
  label: string;
  note?: string;
  quote?: string; // verbatim excerpt from the paper this node is grounded in
  page?: number; // 1-based page the quote appears on
  children?: MindmapNode[];
};

export type Mindmap = {
  title: string;
  children: MindmapNode[];
};

export type DocType = "pdf" | "html";

export type Highlight = {
  id: string;
  text: string;
  pageNumber?: number;
  note?: string;
  createdAt: number;
  source?: "user" | "zotero"; // zotero = mirrored from Zotero's PDF annotations
  color?: string; // Zotero palette hex; defaults to yellow
  // Which of the identical passages on the page this one is. A phrase often
  // appears twice — an abstract and a contributions list saying the same words
  // — and matching by text alone always painted the first.
  occurrence?: number;
  // Where it sits, recorded at selection time (or carried by the Zotero
  // annotation it mirrors). With this present, painting uses the stored
  // geometry; text matching only places the invisible click targets.
  position?: PdfRects;
  // Key of the Zotero annotation this highlight was written to. Set once the
  // background sync returns; keeps the highlight visible while Zotero is still
  // syncing it down, and lets edits/removals reach the right annotation.
  zoteroKey?: string;
};

export type SessionState = {
  pdfName: string;
  // For PDFs this is a base64 data URL; for HTML snapshots it is the raw HTML.
  // (Field names kept for compatibility with previously saved sessions.)
  pdfDataUrl: string;
  docType?: DocType; // absent in old sessions → "pdf"
  zoteroKey?: string; // Zotero item key when opened from the library (for notes)
  sourceUrl?: string; // original URL when the material came from "Open URL"
  zoteroAttachmentKey?: string; // the PDF attachment key (annotations attach here)
  // One fused conversation per paper, per provider ("claude" | "codex").
  // Values are provider-native session ids, resumed for every ask.
  providerSessions?: Record<string, string>;
  annotations: Annotation[];
  concepts: ConceptEntry[];
  model: Model; // model for the Explain panel (chat)
  effort?: Effort; // absent in old sessions → "high"
  mapModel?: Model; // model for paper-map generation (defaults to `model`)
  mapEffort?: Effort;
  mindmap?: Mindmap | null;
  highlights?: Highlight[];
};
