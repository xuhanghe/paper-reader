"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { SessionState, Annotation, ConceptEntry, Model, Effort, Mindmap, DocType, Highlight, Message } from "@/types/session";
import { makeLabel } from "@/lib/session-utils";
import { cacheDocument, getCachedDocument } from "@/lib/document-cache";
import { fetchZoteroDocument } from "@/lib/paper-data";
import { sessionIdFor, legacySessionIdFor } from "@/lib/session-id";
import { uid } from "@/lib/uid";

const DEFAULT_STATE: SessionState = {
  pdfName: "",
  pdfDataUrl: "",
  annotations: [],
  concepts: [],
  // Sonnet, the way the CLI names its current one; sessions keep what they chose
  model: "claude:sonnet",
  effort: "high",
  mindmap: null,
  highlights: [],
};

const LAST_SESSION_KEY = "paper-reader:last-session";
const AUTOSAVE_DELAY_MS = 800;

// The latest state of every paper opened on this surface, kept across the
// reader being unmounted — crossing to the Workspace and back. Coming back
// used to fetch the saved session again and parse it (a paper not in Zotero
// carries its whole PDF in there), then autosave the same bytes straight
// back. The document itself is shared with the document cache.
const keptSessions = new Map<string, SessionState>();
// What was last written for each paper — without its document — so an
// autosave of the state just loaded, or just written, is not written again
const lastSaved = new Map<string, string>();
// The document the server holds for each local paper. A local paper's PDF is
// megabytes and its conversation changes with every answer, so a save carries
// the document only when the server does not have this one yet; the server
// keeps it beside the state (lib/session-store).
const documentSent = new Map<string, string>();

type SaveRequest = { key: string; body: string; document?: string };

// A save of one paper's state: `key` is the state without the document, for
// telling whether anything changed; `body` adds the document when it is new
function saveRequest(id: string, s: SessionState): SaveRequest {
  const key = JSON.stringify({ id, state: { ...s, pdfDataUrl: "" } });
  if (s.zoteroKey || !s.pdfDataUrl || documentSent.get(id) === s.pdfDataUrl) return { key, body: key };
  return { key, body: JSON.stringify({ id, state: s }), document: s.pdfDataUrl };
}

// Papers let go of, until opened again: a save still in flight when one is
// closed must not pin its document here once it lands
const released = new Set<string>();

// A closed paper: nothing here holds on to its state or its document
function letGo(id: string) {
  keptSessions.delete(id);
  documentSent.delete(id);
  released.add(id);
}

async function send(id: string, request: SaveRequest): Promise<boolean> {
  const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: request.body });
  if (res.ok && request.document && !released.has(id)) documentSent.set(id, request.document);
  return res.ok;
}

// Stable per-paper session id: the Zotero item key when the paper lives in
// Zotero (survives renames, consistent everywhere), else a name slug. Lives
// in lib/session-id.ts; re-exported so callers keep importing it from here.
export { sessionIdFor };

// A saved conversation that cannot be fetched is asked for again before the
// paper is given up on as new
const RESTORE_ATTEMPTS = 3;
const RESTORE_RETRY_MS = 1000;

export function useSession() {
  const [session, setSession] = useState<SessionState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
    if (session.pdfName && session.pdfDataUrl) keptSessions.set(sessionIdFor(session.pdfName, session.zoteroKey), session);
  }, [session]);

  // The id of the paper on screen, kept by hand so it is right the moment a
  // switch happens rather than a render later. An answer still streaming for
  // a paper the reader has left must not land in the paper they moved to.
  const activeIdRef = useRef<string | null>(null);
  // Papers left while something was still happening in them — an answer
  // streaming, a session id yet to arrive. Their state keeps advancing here,
  // out of sight, and is what the reader sees when they come back.
  const parkedRef = useRef<Map<string, SessionState>>(new Map());
  const parkedSaves = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Papers whose saved conversation is in hand — loaded, or known not to
  // exist. Opening a paper starts from an empty session and fetches the
  // saved one; until that answers, nothing is written for the paper. A flush
  // on a quick tab switch, or the parked copy's save, would otherwise write
  // the empty session over the saved conversation, and every card is gone.
  const restoredRef = useRef<Set<string>>(new Set());
  // Papers whose tab was closed while still on screen: let go once the reader
  // moves off them, rather than parked to be come back to
  const closingRef = useRef<Set<string>>(new Set());

  const persist = useCallback((id: string, s: SessionState) => {
    if (!restoredRef.current.has(id)) return Promise.resolve();
    return send(id, saveRequest(id, s)).catch(() => {});
  }, []);

  // A change meant for one paper: applied on screen if that paper is open,
  // otherwise to its parked copy, which is saved shortly after
  const applyTo = useCallback((forPaper: string | undefined, fn: (s: SessionState) => SessionState) => {
    if (!forPaper || forPaper === activeIdRef.current) {
      setSession(fn);
      return;
    }
    const parked = parkedRef.current.get(forPaper);
    if (!parked) return;
    parkedRef.current.set(forPaper, fn(parked));
    clearTimeout(parkedSaves.current.get(forPaper));
    parkedSaves.current.set(
      forPaper,
      setTimeout(() => {
        parkedSaves.current.delete(forPaper);
        const latest = parkedRef.current.get(forPaper);
        if (latest) persist(forPaper, latest);
      }, AUTOSAVE_DELAY_MS)
    );
  }, [persist]);

  // A closed tab has nothing to come back to: write what its parked copy
  // holds and let it go — its document included, which nothing else holds
  const forgetPaper = useCallback((id: string) => {
    const timer = parkedSaves.current.get(id);
    const parked = parkedRef.current.get(id);
    parkedSaves.current.delete(id);
    parkedRef.current.delete(id);
    if (timer) {
      clearTimeout(timer);
      if (parked) persist(id, parked);
    }
    // The paper on screen is saved once more on the way out; its copy here
    // goes when the reader moves off it
    if (id === activeIdRef.current) closingRef.current.add(id);
    else letGo(id);
  }, [persist]);

  // Close the open material and return to the empty reader (last tab closed)
  const clearPaper = useCallback(() => {
    const left = activeIdRef.current;
    if (left && closingRef.current.delete(left)) letGo(left);
    activeIdRef.current = null;
    setSession((s) => ({ ...DEFAULT_STATE, model: s.model, effort: s.effort }));
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch {}
  }, []);

  // Persist the current paper right now instead of waiting for the debounce —
  // used before switching tabs so no recent turn is lost
  const flushSave = useCallback(async () => {
    const s = sessionRef.current;
    if (!s.pdfName || !s.pdfDataUrl) return;
    const id = sessionIdFor(s.pdfName, s.zoteroKey);
    if (!restoredRef.current.has(id)) return;
    try {
      localStorage.setItem(LAST_SESSION_KEY, id);
      const request = saveRequest(id, s);
      if (await send(id, request)) lastSaved.set(id, request.key);
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
        // Back from the other surface: the state is still here, as left
        const kept = keptSessions.get(last);
        if (kept) {
          restoredRef.current.add(last);
          activeIdRef.current = last;
          setSession(kept);
          return;
        }
        const res = await fetch(`/api/sessions?id=${encodeURIComponent(last)}`);
        if (!res.ok) return;
        const { state } = await res.json();
        if (!state?.pdfName) return;
        lastSaved.set(last, JSON.stringify({ id: last, state: { ...state, pdfDataUrl: "" } }));
        // A local paper's document came from the server: it has it
        if (!state.zoteroKey && state.pdfDataUrl) documentSent.set(last, state.pdfDataUrl);
        restoredRef.current.add(last);

        if (!state.pdfDataUrl && state.zoteroKey) {
          // Already in memory from this browsing session (the other surface
          // fetched it, or this one did before a switch)? Then the round trip
          // to Zotero and the re-encode are pure latency.
          const cached = getCachedDocument(last);
          if (cached) {
            state.pdfDataUrl = cached;
            state.docType = cached.startsWith("data:application/pdf") ? "pdf" : state.docType || "pdf";
            activeIdRef.current = last;
            setSession(state);
            return;
          }
          // Zero-copy session: pull the document back out of Zotero
          const loaded = await fetchZoteroDocument(state.zoteroKey);
          state.zoteroAttachmentKey = loaded.attachmentKey || state.zoteroAttachmentKey;
          state.pdfDataUrl = loaded.data;
          state.docType = loaded.docType;
        }
        if (state.pdfDataUrl) {
          cacheDocument(last, state.pdfDataUrl);
          activeIdRef.current = last;
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
    if (!restoredRef.current.has(sessionIdFor(session.pdfName, session.zoteroKey))) return;
    const id = sessionIdFor(session.pdfName, session.zoteroKey);
    const t = setTimeout(() => {
      try { localStorage.setItem(LAST_SESSION_KEY, id); } catch {}
      // Zero-copy: papers that live in Zotero are saved without the document
      // bytes — only the conversation context is stored locally — and a local
      // paper's document is sent once, not with every change
      const request = saveRequest(id, session);
      if (lastSaved.get(id) === request.key && !request.document) return;
      lastSaved.set(id, request.key);
      send(id, request).catch(() => {});
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [session, hydrated, restoring]);

  // Show the document immediately; merge any saved conversation in the background
  const setPdf = useCallback((name: string, dataUrl: string, docType: DocType = "pdf", zoteroKey?: string, zoteroAttachmentKey?: string, sourceUrl?: string) => {
    const id = sessionIdFor(name, zoteroKey);
    // Park the paper being left, so an answer still arriving for it has
    // somewhere to go. Its document stays in the document cache.
    const leaving = sessionRef.current;
    const leavingId = leaving.pdfName ? sessionIdFor(leaving.pdfName, leaving.zoteroKey) : null;
    if (leavingId && leavingId !== id) {
      // A closed tab is not parked: nothing comes back to it
      if (closingRef.current.delete(leavingId)) letGo(leavingId);
      else parkedRef.current.set(leavingId, leaving.zoteroKey ? { ...leaving, pdfDataUrl: "" } : leaving);
    }
    closingRef.current.delete(id);
    released.delete(id);
    activeIdRef.current = id;
    // Coming back to a parked paper: its copy here is the latest there is —
    // everything saved to disk came from it, plus whatever streamed in since
    const parked = parkedRef.current.get(id);
    if (parked) {
      parkedRef.current.delete(id);
      clearTimeout(parkedSaves.current.get(id));
      parkedSaves.current.delete(id);
      setSession({
        ...parked,
        pdfDataUrl: dataUrl,
        docType,
        zoteroKey: zoteroKey ?? parked.zoteroKey,
        zoteroAttachmentKey: zoteroAttachmentKey ?? parked.zoteroAttachmentKey,
        sourceUrl: sourceUrl ?? parked.sourceUrl,
      });
      return;
    }
    setSession((s) => ({ ...s, pdfName: name, pdfDataUrl: dataUrl, docType, zoteroKey, zoteroAttachmentKey, sourceUrl, annotations: [], concepts: [], mindmap: null, highlights: [], providerSessions: {} }));
    restoredRef.current.delete(id);
    setRestoring(true);
    (async () => {
      try {
        for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, RESTORE_RETRY_MS));
          // Left, and not parked: nothing to restore into any more
          if (activeIdRef.current !== id && !parkedRef.current.has(id)) return;
          let res: Response;
          try {
            // legacy = the id this name had under the old ASCII-only slug, so a
            // session saved before other scripts counted migrates over
            res = await fetch(`/api/sessions?id=${encodeURIComponent(id)}&legacy=${encodeURIComponent(legacySessionIdFor(name))}&lean=1`);
          } catch {
            continue; // unreachable: try again, and write nothing meanwhile
          }
          if (!res.ok) {
            if (res.status >= 500) continue; // the server's trouble, not a missing session
            // Nothing saved under this id: the fresh session is the whole history
            restoredRef.current.add(id);
            return;
          }
          const saved = (await res.json())?.state as SessionState | undefined;
          if (!saved?.pdfName) { restoredRef.current.add(id); return; }
          // The saved conversation, under the document just loaded. Anything
          // asked while the fetch was out stays, after what was saved.
          const merge = (s: SessionState): SessionState => ({
            ...saved,
            pdfName: s.pdfName,
            pdfDataUrl: s.pdfDataUrl,
            docType: s.docType,
            zoteroKey: s.zoteroKey ?? saved.zoteroKey,
            zoteroAttachmentKey: s.zoteroAttachmentKey ?? saved.zoteroAttachmentKey,
            sourceUrl: s.sourceUrl ?? saved.sourceUrl,
            annotations: [...(saved.annotations ?? []), ...s.annotations.filter((a) => !saved.annotations?.some((b) => b.id === a.id))],
            concepts: [...(saved.concepts ?? []), ...s.concepts.filter((c) => !saved.concepts?.some((d) => d.annotationId === c.annotationId))],
            highlights: [...(saved.highlights ?? []), ...(s.highlights ?? [])],
            providerSessions: { ...(s.providerSessions ?? {}), ...(saved.providerSessions ?? {}) },
            mindmap: saved.mindmap ?? s.mindmap,
          });
          // Into the live session while this paper is open; into its parked
          // copy if the reader moved on before the answer came — that copy
          // started empty, and is what they come back to
          const parked = parkedRef.current.get(id);
          if (parked) parkedRef.current.set(id, merge(parked));
          setSession((s) => (sessionIdFor(s.pdfName, s.zoteroKey) === id ? merge(s) : s));
          restoredRef.current.add(id);
          return;
        }
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  const addHighlight = useCallback((partial: Omit<Highlight, "id" | "createdAt">): string => {
    const id = uid();
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

  // Take a question and its answer out of a conversation; what came after
  // them moves up
  const removeMessages = useCallback((annotationId: string, start: number, end: number) => {
    setSession((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === annotationId ? { ...a, messages: [...a.messages.slice(0, start), ...a.messages.slice(end)] } : a
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

  const setEffort = useCallback((effort: Effort | undefined) => {
    setSession((s) => ({ ...s, effort }));
  }, []);

  const setMapModel = useCallback((mapModel: Model) => {
    setSession((s) => ({ ...s, mapModel }));
  }, []);

  const setMapEffort = useCallback((mapEffort: Effort | undefined) => {
    setSession((s) => ({ ...s, mapEffort }));
  }, []);

  // Fused per-paper conversation: one provider-native session id per provider
  const setProviderSession = useCallback((provider: string, id: string, forPaper?: string) => {
    applyTo(forPaper, (s) => ({ ...s, providerSessions: { ...s.providerSessions, [provider]: id } }));
  }, [applyTo]);

  const addAnnotation = useCallback((partial: Omit<Annotation, "id" | "createdAt" | "label">): string => {
    const id = uid();
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

  // forPaper: the paper the answer belongs to — it keeps arriving after the
  // reader has moved to another, and must land in its own thread
  const updateLastAssistantMessage = useCallback((annotationId: string, content: string, forPaper?: string) => {
    applyTo(forPaper, (s) => ({
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
  }, [applyTo]);

  // Stamp the number the server gave this ask onto the message that made it —
  // the question if there is one, otherwise the answer's own bubble, which is
  // all a bare "explain this" leaves behind.
  const markTurn = useCallback((annotationId: string, turn: number, forPaper?: string) => {
    applyTo(forPaper, (s) => ({
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
  }, [applyTo]);

  const setTakeaways = useCallback((annotationId: string, takeaways: string[], summarizedTurns: number, forPaper?: string) => {
    applyTo(forPaper, (s) => ({
      ...s,
      concepts: s.concepts.map((c) =>
        c.annotationId === annotationId ? { ...c, takeaways, summarizedTurns } : c
      ),
    }));
  }, [applyTo]);

  // A paper's state as it stands — on screen, or parked while the reader is
  // elsewhere. For work that follows a stream to its end, wherever it ended.
  const readPaper = useCallback((forPaper?: string): SessionState | undefined => {
    if (!forPaper || forPaper === activeIdRef.current) return sessionRef.current;
    return parkedRef.current.get(forPaper);
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
        activeIdRef.current = loaded.pdfName ? sessionIdFor(loaded.pdfName, loaded.zoteroKey) : null;
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
    forgetPaper,
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
    readPaper,
    replaceMessageFrom,
    removeMessages,
    saveSession,
    loadSession,
  };
}
