"use client";
import { useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useSession } from "@/hooks/useSession";
import { ConceptSidebar } from "@/components/ConceptSidebar";
import { ExplainPanel } from "@/components/ExplainPanel";
import { Model } from "@/types/session";
import { RegionResult } from "@/hooks/useRegionDrag";
import type { PdfViewerHandle } from "@/components/PdfViewer";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
      Loading viewer…
    </div>
  ),
});

const MODELS: { id: Model; label: string }[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku — fast" },
  { id: "claude-sonnet-4-6", label: "Sonnet — balanced" },
  { id: "claude-opus-4-7", label: "Opus — thorough" },
];

export default function Home() {
  const {
    session,
    setPdf,
    setModel,
    addAnnotation,
    removeAnnotation,
    setAnnotationSessionId,
    appendMessage,
    updateLastAssistantMessage,
    saveSession,
    loadSession,
  } = useSession();

  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const annotationRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pdfViewerRef = useRef<PdfViewerHandle>(null);

  const handleDelete = useCallback((id: string) => {
    removeAnnotation(id);
    if (activeAnnotationId === id) setActiveAnnotationId(null);
    delete annotationRefs.current[id];
  }, [removeAnnotation, activeAnnotationId]);

  const streamExplanation = useCallback(
    async (annotationId: string, endpoint: string, body: Record<string, unknown>) => {
      setStreamingIds((s) => new Set(s).add(annotationId));
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, model: session.model }),
        });

        if (!res.ok || !res.body) {
          updateLastAssistantMessage(annotationId, "Error: could not get a response from Claude.");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let sessionCaptured = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });

          const lines = chunk.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              // Capture session_id from the init event for future follow-ups
              if (!sessionCaptured && event.type === "system" && event.session_id) {
                setAnnotationSessionId(annotationId, event.session_id);
                sessionCaptured = true;
              } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                accumulated += event.delta.text;
                updateLastAssistantMessage(annotationId, accumulated);
              } else if (event.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "text") accumulated += block.text;
                }
                updateLastAssistantMessage(annotationId, accumulated);
              } else if (event.type === "result" && event.result && !accumulated) {
                accumulated = typeof event.result === "string" ? event.result : "";
                updateLastAssistantMessage(annotationId, accumulated);
              }
            } catch {
              // non-JSON line, skip
            }
          }
        }
      } catch (err) {
        console.error(err);
        updateLastAssistantMessage(annotationId, "Error: failed to connect to Claude.");
      } finally {
        setStreamingIds((s) => { const next = new Set(s); next.delete(annotationId); return next; });
      }
    },
    [session.model, updateLastAssistantMessage, setAnnotationSessionId]
  );

  const handleViewInPdf = useCallback(
    (annotationId: string) => {
      const annotation = session.annotations.find((a) => a.id === annotationId);
      if (!annotation?.selectedText || !annotation.pageNumber) return;
      pdfViewerRef.current?.highlightText(annotation.pageNumber, annotation.selectedText);
    },
    [session.annotations]
  );

  const handleTextSelected = useCallback(
    (text: string, pageNumber?: number) => {
      const id = addAnnotation({ type: "text", selectedText: text, pageNumber, messages: [{ role: "assistant", content: "" }] });
      setActiveAnnotationId(id);
      streamExplanation(id, "/api/explain", { selected_text: text });
    },
    [addAnnotation, streamExplanation]
  );

  const handleRegionCaptured = useCallback(
    (result: RegionResult) => {
      const id = addAnnotation({
        type: "image",
        selectedText: "Figure region",
        imageDataUrl: result.imageDataUrl,
        messages: [{ role: "assistant", content: "" }],
      });
      setActiveAnnotationId(id);
      streamExplanation(id, "/api/explain-image", { image_base64: result.imageDataUrl });
    },
    [addAnnotation, streamExplanation]
  );

  const handleReExplainImage = useCallback(
    (annotationId: string) => {
      const annotation = session.annotations.find((a) => a.id === annotationId);
      if (!annotation?.imageDataUrl) return;
      // Create a fresh annotation — same as capturing a new region
      const id = addAnnotation({
        type: "image",
        selectedText: "Figure region",
        imageDataUrl: annotation.imageDataUrl,
        messages: [{ role: "assistant", content: "" }],
      });
      setActiveAnnotationId(id);
      streamExplanation(id, "/api/explain-image", { image_base64: annotation.imageDataUrl });
    },
    [session.annotations, addAnnotation, streamExplanation]
  );

  const handleFollowUp = useCallback(
    (annotationId: string, question: string) => {
      const annotation = session.annotations.find((a) => a.id === annotationId);
      if (!annotation) return;

      appendMessage(annotationId, "user", question);
      appendMessage(annotationId, "assistant", "");
      setActiveAnnotationId(annotationId);

      if (annotation.sessionId) {
        // Resume the existing Claude Code session — only the new question is sent
        streamExplanation(annotationId, "/api/followup", {
          question,
          session_id: annotation.sessionId,
        });
      } else {
        // Fallback: no session ID yet, send history inline
        const history = annotation.messages.filter((m) => m.content.trim());
        const endpoint = annotation.type === "image" ? "/api/explain-image" : "/api/explain";
        const body = annotation.type === "image"
          ? { image_base64: annotation.imageDataUrl, history, question }
          : { selected_text: annotation.selectedText || "", history, question };
        streamExplanation(annotationId, endpoint, body);
      }
    },
    [appendMessage, session.annotations, streamExplanation]
  );

  const handlePdfUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setPdf(file.name, dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [setPdf]
  );

  const handleLoadSession = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadSession(file);
    },
    [loadSession]
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
      {/* Header */}
      <header className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ background: "var(--paper)", borderBottom: "1px solid var(--border)" }}>
        <span className="font-semibold text-sm tracking-tight mr-3 select-none" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
          Paper Reader
        </span>

        <label className="btn-primary cursor-pointer text-xs px-3 py-1.5">
          Open PDF
          <input type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
        </label>

        {session.pdfName ? (
          <>
            <span className="text-xs truncate max-w-[180px]" style={{ color: "var(--ink-faint)" }} title={session.pdfName}>{session.pdfName}</span>
            <button onClick={saveSession} className="btn-ghost text-xs px-3 py-1.5">
              Save session
            </button>
          </>
        ) : null}

        <label className="btn-ghost cursor-pointer text-xs px-3 py-1.5">
          Load session
          <input type="file" accept=".json,application/json" onChange={handleLoadSession} className="hidden" />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>Model</span>
          <select
            value={session.model}
            onChange={(e) => setModel(e.target.value as Model)}
            className="text-xs px-2 py-1.5 rounded focus:outline-none cursor-pointer"
            style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink-muted)" }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: PDF pane */}
        <div className="w-1/2 flex flex-col overflow-hidden" style={{ borderRight: "1px solid var(--border)" }}>
          {session.pdfDataUrl ? (
            <PdfViewer
              ref={pdfViewerRef}
              pdfDataUrl={session.pdfDataUrl}
              onTextSelected={handleTextSelected}
              onRegionCaptured={handleRegionCaptured}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4" style={{ background: "var(--parchment)" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--ink-faint)" }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              <p className="text-sm" style={{ color: "var(--ink-muted)" }}>Open a PDF to get started</p>
              <label className="btn-primary cursor-pointer text-sm px-5 py-2">
                Open PDF
                <input type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
              </label>
              <p className="text-xs" style={{ color: "var(--ink-faint)" }}>or</p>
              <label className="btn-ghost cursor-pointer text-xs px-3 py-1.5">
                Load a previous session
                <input type="file" accept=".json,application/json" onChange={handleLoadSession} className="hidden" />
              </label>
            </div>
          )}
        </div>

        {/* Right: Explain panel + concept sidebar */}
        <div className="w-1/2 flex overflow-hidden">
          <ExplainPanel
            annotations={session.annotations}
            activeId={activeAnnotationId}
            model={session.model}
            streamingIds={streamingIds}
            onFollowUp={handleFollowUp}
            onDelete={handleDelete}
            onReExplainImage={handleReExplainImage}
            onViewInPdf={handleViewInPdf}
            annotationRefs={annotationRefs}
          />
          <ConceptSidebar
            concepts={session.concepts}
            onSelect={(id) => setActiveAnnotationId(id)}
            isOpen={sidebarOpen}
            onToggle={() => setSidebarOpen((v) => !v)}
          />
        </div>
      </div>
    </div>
  );
}
