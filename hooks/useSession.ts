"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { SessionState, Annotation, ConceptEntry, Model, Effort, Mindmap, DocType, Highlight, Message } from "@/types/session";
import { makeLabel } from "@/lib/session-utils";
import { cacheDocument, getCachedDocument } from "@/lib/document-cache";

const DEFAULT_STATE: SessionState = {
  pdfName: "",
  pdfDataUrl: "",
  annotations: [],
  concepts: [],
  model: "claude-sonnet-4-6",
  effort: "high",
  mindmap: null,
  highlights: [],
};

const LAST_SESSION_KEY = "paper-reader:last-session";
const AUTOSAVE_DELAY_MS = 800;

// Stable per-paper session id: the Zotero item key when the paper lives in
// Zotero (survives renames, consistent everywhere), else a name slug.
export function sessionIdFor(pdfName: string, zoteroKey?: string): string {
  if (zoteroKey) return zoteroKey;
  return pdfName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "untitled";
}

export function useSession() {
  const [session, setSession] = useState<SessionState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Close the open material and return to the empty reader (last tab closed)
  const clearPaper = useCallback(() => {
    setSession((s) => ({ ...DEFAULT_STATE, model: s.model, effort: s.effort }));
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch {}
  }, []);

  // Persist the current paper right now instead of waiting for the debounce —
  // used before switching tabs so no recent turn is lost
  const flushSave = useCallback(async () => {
    const s = sessionRef.current;
    if (!s.pdfName || !s.pdfDataUrl) return;
    const id = sessionIdFor(s.pdfName, s.zoteroKey);
    const state = s.zoteroKey ? { ...s, pdfDataUrl: "" } : s;
    try {
      localStorage.setItem(LAST_SESSION_KEY, id);
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state }),
      });
    } catch {
      // best effort — the debounced autosave will retry
    }
  }, []);

  // On launch, reopen the paper the user was reading when they closed the app.
  // Sessions for Zotero papers are zero-copy (no embedded PDF bytes) — the
  // document is refetched from Zotero here. hydrated gates the autosave.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const last = localStorage.getItem(LAST_SESSION_KEY);
        if (!last) return;
        const res = await fetch(`/api/sessions?id=${encodeURIComponent(last)}`);
        if (!res.ok) return;
        const { state } = await res.json();
        if (!state?.pdfName) return;

        if (!state.pdfDataUrl && state.zoteroKey) {
          // Already in memory from this browsing session (the other surface
          // fetched it, or this one did before a switch)? Then the round trip
          // to Zotero and the re-encode are pure latency.
          const cached = getCachedDocument(last);
          if (cached) {
            state.pdfDataUrl = cached;
            state.docType = cached.startsWith("data:application/pdf") ? "pdf" : state.docType || "pdf";
            setSession(state);
            return;
          }
          // Zero-copy session: pull the document back out of Zotero
          const fileRes = await fetch(`/api/zotero/file?key=${encodeURIComponent(state.zoteroKey)}`);
          if (!fileRes.ok) return;
          // Needed to write highlights back as Zotero annotations
          state.zoteroAttachmentKey = fileRes.headers.get("X-Attachment-Key") || state.zoteroAttachmentKey;
          if ((fileRes.headers.get("Content-Type") || "").includes("text/html")) {
            state.pdfDataUrl = await fileRes.text();
            state.docType = "html";
          } else {
            const blob = await fileRes.blob();
            state.pdfDataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error("read failed"));
              reader.readAsDataURL(blob);
            });
            state.docType = "pdf";
          }
        }
        if (state.pdfDataUrl) {
          cacheDocument(last, state.pdfDataUrl);
          setSession(state);
        }
      } catch {
        // no saved session or Zotero unreachable — open blank
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Debounced autosave of the full session, keyed by paper.
  // Paused while a saved conversation is being restored, so a fresh empty
  // state can never overwrite the saved one.
  useEffect(() => {
    if (!hydrated || restoring || !session.pdfName || !session.pdfDataUrl) return;
    const id = sessionIdFor(session.pdfName, session.zoteroKey);
    const t = setTimeout(() => {
      try { localStorage.setItem(LAST_SESSION_KEY, id); } catch {}
      // Zero-copy: papers that live in Zotero are saved without the document
      // bytes — only the conversation context is stored locally
      const state = session.zoteroKey ? { ...session, pdfDataUrl: "" } : session;
      fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state }),
      }).catch(() => {});
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [session, hydrated, restoring]);

  // Show the document immediately; merge any saved conversation in the background
  const setPdf = useCallback((name: string, dataUrl: string, docType: DocType = "pdf", zoteroKey?: string, zoteroAttachmentKey?: string, sourceUrl?: string) => {
    setSession((s) => ({ ...s, pdfName: name, pdfDataUrl: dataUrl, docType, zoteroKey, zoteroAttachmentKey, sourceUrl, annotations: [], concepts: [], mindmap: null, highlights: [], providerSessions: {} }));
    setRestoring(true);
    (async () => {
      try {
        // legacy = the old name-slug id, so pre-zoteroKey sessions migrate over
        const res = await fetch(
          `/api/sessions?id=${encodeURIComponent(sessionIdFor(name, zoteroKey))}&legacy=${encodeURIComponent(sessionIdFor(name))}&lean=1`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data?.state?.pdfName !== name) return;
        // Keep the freshly loaded document bytes; only merge if the user
        // hasn't switched to another paper in the meantime
        setSession((s) =>
          s.pdfName === name
            ? {
                ...data.state,
                pdfDataUrl: s.pdfDataUrl,
                docType: s.docType,
                zoteroKey: s.zoteroKey ?? data.state.zoteroKey,
                zoteroAttachmentKey: s.zoteroAttachmentKey ?? data.state.zoteroAttachmentKey,
                sourceUrl: s.sourceUrl ?? data.state.sourceUrl,
              }
            : s
        );
      } catch {
        // no saved conversation — keep the fresh session
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  const addHighlight = useCallback((partial: Omit<Highlight, "id" | "createdAt">): string => {
    const id = typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    setSession((s) => ({
      ...s,
      highlights: [...(s.highlights || []), { ...partial, id, createdAt: Date.now() }],
    }));
    return id;
  }, []);

  const removeHighlight = useCallback((id: string) => {
    setSession((s) => ({
      ...s,
      highlights: (s.highlights || []).filter((h) => h.id !== id),
    }));
  }, []);

  // Records where a highlight landed in Zotero once the background write returns
  const setHighlightZoteroKey = useCallback((id: string, zoteroKey: string) => {
    setSession((s) => ({
      ...s,
      highlights: (s.highlights || []).map((h) => (h.id === id ? { ...h, zoteroKey } : h)),
    }));
  }, []);

  // Drops the local mirror of highlights that live in Zotero. Called for two
  // opposite reasons, both ending the mirror's usefulness: the annotation can
  // now be read back from Zotero (so the Zotero copy takes over the display),
  // or it has been deleted there (so the highlight should be gone entirely).
  const dropMirroredHighlights = useCallback((zoteroKeys: string[]) => {
    if (zoteroKeys.length === 0) return;
    const keys = new Set(zoteroKeys);
    setSession((s) => {
      const kept = (s.highlights || []).filter((h) => !(h.zoteroKey && keys.has(h.zoteroKey)));
      return kept.length === (s.highlights || []).length ? s : { ...s, highlights: kept };
    });
  }, []);

  const recolorHighlight = useCallback((id: string, color: string) => {
    setSession((s) => ({
      ...s,
      highlights: (s.highlights || []).map((h) => (h.id === id ? { ...h, color } : h)),
    }));
  }, []);

  // An empty note clears it, matching Zotero's own behaviour for comments
  const setHighlightNote = useCallback((id: string, note: string) => {
    setSession((s) => ({
      ...s,
      highlights: (s.highlights || []).map((h) => (h.id === id ? { ...h, note: note || undefined } : h)),
    }));
  }, []);

  // Rewrite a message and drop everything after it, the way a chat box does
  // when you edit and resend. The empty assistant message that follows is where
  // the new answer lands.
  const replaceMessageFrom = useCallback((annotationId: string, index: number, message: Message) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === annotationId
          ? { ...a, messages: [...a.messages.slice(0, index), message, { role: "assistant" as const, content: "" }] }
          : a
      ),
    }));
  }, []);

  // forName pins the map to the paper it was generated for — if the user
  // switched papers while generation ran, the result is discarded instead of
  // landing on (and autosaving into) the wrong paper's session
  const setMindmap = useCallback((mindmap: Mindmap | null, forName?: string) => {
    setSession((s) => (forName && s.pdfName !== forName ? s : { ...s, mindmap }));
  }, []);

  const setModel = useCallback((model: Model) => {
    setSession((s) => ({ ...s, model }));
  }, []);

  const setEffort = useCallback((effort: Effort) => {
    setSession((s) => ({ ...s, effort }));
  }, []);

  const setMapModel = useCallback((mapModel: Model) => {
    setSession((s) => ({ ...s, mapModel }));
  }, []);

  const setMapEffort = useCallback((mapEffort: Effort) => {
    setSession((s) => ({ ...s, mapEffort }));
  }, []);

  // Fused per-paper conversation: one provider-native session id per provider
  const setProviderSession = useCallback((provider: string, id: string) => {
    setSession((s) => ({ ...s, providerSessions: { ...s.providerSessions, [provider]: id } }));
  }, []);

  const addAnnotation = useCallback((partial: Omit<Annotation, "id" | "createdAt" | "label">): string => {
    const id = typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const firstUserMessage = partial.messages.find((m) => m.role === "user")?.content;
    const label = makeLabel(partial.selectedText || firstUserMessage || "Figure region", partial.type);
    const annotation: Annotation = { ...partial, id, label, createdAt: Date.now() };
    const concept: ConceptEntry = { annotationId: id, label, type: partial.type };
    setSession((s) => ({
      ...s,
      annotations: [...s.annotations, annotation],
      concepts: [...s.concepts, concept],
    }));
    return id;
  }, []);

  const appendMessage = useCallback((annotationId: string, role: "user" | "assistant", content: string, imageDataUrl?: string) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === annotationId
          ? { ...a, messages: [...a.messages, imageDataUrl ? { role, content, imageDataUrl } : { role, content }] }
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

  // Stamp the number the server gave this ask onto the message that made it —
  // the question if there is one, otherwise the answer's own bubble, which is
  // all a bare "explain this" leaves behind.
  const markTurn = useCallback((annotationId: string, turn: number) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) => {
        if (a.id !== annotationId || a.messages.length === 0) return a;
        const msgs = [...a.messages];
        let at = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") { at = i; break; }
        }
        if (at === -1) at = msgs.length - 1;
        if (msgs[at].turn === turn) return a;
        msgs[at] = { ...msgs[at], turn };
        return { ...a, messages: msgs };
      }),
    }));
  }, []);

  const setTakeaways = useCallback((annotationId: string, takeaways: string[], summarizedTurns: number) => {
    setSession((s) => ({
      ...s,
      concepts: s.concepts.map((c) =>
        c.annotationId === annotationId ? { ...c, takeaways, summarizedTurns } : c
      ),
    }));
  }, []);

  const editTakeaways = useCallback((annotationId: string, takeaways: string[]) => {
    setSession((s) => ({
      ...s,
      concepts: s.concepts.map((c) =>
        c.annotationId === annotationId ? { ...c, takeaways, edited: true } : c
      ),
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
    restoring,
    paperId: session.pdfName ? sessionIdFor(session.pdfName, session.zoteroKey) : null,
    flushSave,
    clearPaper,
    setProviderSession,
    setPdf,
    setModel,
    setEffort,
    setMapModel,
    setMapEffort,
    setMindmap,
    addHighlight,
    removeHighlight,
    recolorHighlight,
    setHighlightNote,
    setHighlightZoteroKey,
    dropMirroredHighlights,
    addAnnotation,
    removeAnnotation,
    setAnnotationSessionId,
    appendMessage,
    updateLastAssistantMessage,
    markTurn,
    setTakeaways,
    editTakeaways,
    replaceMessageFrom,
    saveSession,
    loadSession,
  };
}
