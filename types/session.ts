export type AnnotationType = "text" | "image";

export type Message = {
  role: "user" | "assistant";
  content: string;
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

export type Model = "claude-haiku-4-5-20251001" | "claude-sonnet-4-6" | "claude-opus-4-7";

export type SessionState = {
  pdfName: string;
  pdfDataUrl: string; // base64 of the PDF
  annotations: Annotation[];
  concepts: ConceptEntry[];
  model: Model;
};
