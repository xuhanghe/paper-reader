"use client";
import { useState, useCallback } from "react";
import { SessionState, Annotation, ConceptEntry, Model } from "@/types/session";
import { makeLabel } from "@/lib/session-utils";

const DEFAULT_STATE: SessionState = {
  pdfName: "",
  pdfDataUrl: "",
  annotations: [],
  concepts: [],
  model: "claude-sonnet-4-6",
};

export function useSession() {
  const [session, setSession] = useState<SessionState>(DEFAULT_STATE);

  const setPdf = useCallback((name: string, dataUrl: string) => {
    setSession((s) => ({ ...s, pdfName: name, pdfDataUrl: dataUrl, annotations: [], concepts: [] }));
  }, []);

  const setModel = useCallback((model: Model) => {
    setSession((s) => ({ ...s, model }));
  }, []);

  const addAnnotation = useCallback((partial: Omit<Annotation, "id" | "createdAt" | "label">): string => {
    const id = typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const label = makeLabel(partial.selectedText || "Figure region", partial.type);
    const annotation: Annotation = { ...partial, id, label, createdAt: Date.now() };
    const concept: ConceptEntry = { annotationId: id, label, type: partial.type };
    setSession((s) => ({
      ...s,
      annotations: [...s.annotations, annotation],
      concepts: [...s.concepts, concept],
    }));
    return id;
  }, []);

  const appendMessage = useCallback((annotationId: string, role: "user" | "assistant", content: string) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === annotationId
          ? { ...a, messages: [...a.messages, { role, content }] }
          : a
      ),
    }));
  }, []);

  const updateLastAssistantMessage = useCallback((annotationId: string, content: string) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) => {
        if (a.id !== annotationId) return a;
        const msgs = [...a.messages];
        const lastIdx = msgs.length - 1;
        if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
          msgs[lastIdx] = { role: "assistant", content };
        } else {
          msgs.push({ role: "assistant", content });
        }
        return { ...a, messages: msgs };
      }),
    }));
  }, []);

  const setAnnotationSessionId = useCallback((annotationId: string, sessionId: string) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === annotationId ? { ...a, sessionId } : a
      ),
    }));
  }, []);

  const removeAnnotation = useCallback((annotationId: string) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.filter((a) => a.id !== annotationId),
      concepts: s.concepts.filter((c) => c.annotationId !== annotationId),
    }));
  }, []);

  const saveSession = useCallback(() => {
    const json = JSON.stringify(session, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.pdfName.replace(/\.pdf$/i, "") || "session"}-paper-reader.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session]);

  const loadSession = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const loaded = JSON.parse(e.target?.result as string) as SessionState;
        setSession(loaded);
      } catch {
        alert("Failed to load session file. Make sure it's a valid paper-reader session JSON.");
      }
    };
    reader.readAsText(file);
  }, []);

  return {
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
  };
}
