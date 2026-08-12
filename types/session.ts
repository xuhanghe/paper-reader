export type AnnotationType = "text" | "image";

export type Message = {
  role: "user" | "assistant";
  content: string;
  imageDataUrl?: string; // figure attached to a user message
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
};

export type ConceptEntry = {
  annotationId: string;
  label: string;
  type: AnnotationType;
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
