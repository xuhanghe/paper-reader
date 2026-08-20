"use client";
import { useRef, useState, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { extractZoteroItemText } from "@/lib/extract-text";
import dynamic from "next/dynamic";
import { useSession, sessionIdFor } from "@/hooks/useSession";
import { MindmapSidebar } from "@/components/MindmapSidebar";
import { ExplainPanel } from "@/components/ExplainPanel";
import { ZoteroLibrary } from "@/components/ZoteroLibrary";
import { SaveToZoteroModal } from "@/components/SaveToZoteroModal";
import { OpenUrlModal } from "@/components/OpenUrlModal";
import { CustomApiConfig, DocType } from "@/types/session";
import { CustomApiModal } from "@/components/CustomApiModal";
import { ModelPicker } from "@/components/ModelPicker";
import { MaterialTabs, MaterialTab } from "@/components/MaterialTabs";
import { DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import { providerIdFor } from "@/lib/provider-id";
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

const HtmlViewer = dynamic(() => import("@/components/HtmlViewer").then((m) => m.HtmlViewer), {
  ssr: false,
});

function ResizeHandle({ onDrag, onStart, onEnd }: { onDrag: (dx: number) => void; onStart?: () => void; onEnd?: () => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          onStart?.();
          setDragging(true);
          let lastX = e.clientX;
          const move = (ev: MouseEvent) => { onDrag(ev.clientX - lastX); lastX = ev.clientX; };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setDragging(false);
            onEnd?.();
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
        className="w-[5px] -mx-[2px] z-10 shrink-0 cursor-col-resize group/handle flex justify-center"
      >
        <div
          className="w-[1.5px] h-full transition-all group-hover/handle:w-[3px]"
          style={{ background: dragging ? "var(--accent)" : "var(--border-light)" }}
          onMouseEnter={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = "rgba(232,120,76,0.55)"; }}
          onMouseLeave={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = "var(--border-light)"; }}
        />
      </div>
      {/* While dragging, shield iframes/canvases so they don't swallow mouse events */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Dragging a panel this far past its minimum width collapses it into its rail
const COLLAPSE_SNAP = 45;
// Pulling a collapsed rail back out this far past the collapse point reopens
// it. The gap between the two keeps the panel from flickering on the boundary.
const REOPEN_SNAP = 28;

// Resizable panel width. Dragging below the minimum auto-collapses the panel;
// the width resets to its default so reopening gives a comfortable size again.
function usePanelWidth(
  initial: number,
  min: number,
  max: number,
  direction: 1 | -1, // 1 = panel grows rightwards (left panels), -1 = right panels
  isOpen: boolean,
  setOpen: (open: boolean) => void
) {
  const [width, setWidth] = useState(initial);
  // Where the pointer is, in panel-width terms. It keeps falling below `min`
  // as the drag continues — that overshoot is what collapses the panel, and
  // what tells us when the pointer has come back far enough to reopen it.
  const rawRef = useRef(initial);
  const widthRef = useRef(initial);
  const openRef = useRef(isOpen);
  useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  // Collapsed or open is a function of where the pointer is right now, not of
  // what the gesture has already done — so overshooting and pulling straight
  // back re-expands the panel without letting go. The two thresholds differ so
  // the panel can't flicker while the pointer sits on the boundary.
  const collapseAt = min - COLLAPSE_SNAP;
  const reopenAt = collapseAt + REOPEN_SNAP;

  const onStart = useCallback(() => {
    // From a rail, start at the collapse point: a short pull brings it back
    rawRef.current = openRef.current ? widthRef.current : collapseAt;
  }, [collapseAt]);

  const onDrag = useCallback(
    (dx: number) => {
      rawRef.current = clamp(rawRef.current + direction * dx, 0, max);

      if (openRef.current) {
        if (rawRef.current < collapseAt) {
          setOpen(false);
          return;
        }
      } else {
        if (rawRef.current <= reopenAt) return;
        setOpen(true);
      }
      const clamped = clamp(rawRef.current, min, max);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [min, max, direction, setOpen, collapseAt, reopenAt]
  );

  // Let go while collapsed and the stored width resets, so reopening from the
  // rail button later gives a comfortable size rather than the minimum
  const onEnd = useCallback(() => {
    if (openRef.current) return;
    widthRef.current = initial;
    setWidth(initial);
  }, [initial]);

  return [width, onDrag, onStart, onEnd] as const;
}

const CUSTOM_API_KEY = "paper-reader:custom-api";
const TABS_KEY = "paper-reader:open-tabs";
const LAYOUT_KEY = "paper-reader:layout";

// Panel sizes and open/closed state survive a refresh. First run opens the
// library only — the map pops open when a material is opened, and the explain
// panel opens itself on the first question.
type Layout = {
  zoteroOpen: boolean; explainOpen: boolean; mapOpen: boolean;
  zoteroWidth: number; explainWidth: number; mapWidth: number;
};
const DEFAULT_LAYOUT: Layout = {
  zoteroOpen: true, explainOpen: false, mapOpen: false,
  zoteroWidth: 272, explainWidth: 460, mapWidth: 336,
};

function loadLayout(): Layout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...JSON.parse(raw) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function loadTabs(): MaterialTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((t) => t?.id && t?.name) : [];
  } catch {
    return [];
  }
}

// The reader's initial state comes from localStorage (layout, tabs), which the
// server can't know — so the first paint is a plain backdrop and the real UI
// renders once we're on the client. Avoids a hydration mismatch.
const NO_SUBSCRIBE = () => () => {};
const useIsClient = () => useSyncExternalStore(NO_SUBSCRIBE, () => true, () => false);

function loadCustomApi(): CustomApiConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CUSTOM_API_KEY);
    return raw ? (JSON.parse(raw) as CustomApiConfig) : null;
  } catch {
    return null;
  }
}


export default function Home() {
  const {
    session,
    restoring,
    paperId,
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
    replaceMessageFrom,
    saveSession,
    loadSession,
  } = useSession();

  const isClient = useIsClient();
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  // Saved layout, read once — useState's initializer keeps it stable
  const [layout0] = useState(loadLayout);
  const [sidebarOpen, setSidebarOpen] = useState(layout0.mapOpen);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [zoteroOpen, setZoteroOpen] = useState(layout0.zoteroOpen);
  const [explainOpen, setExplainOpen] = useState(layout0.explainOpen);
  const [zoteroWidth, dragZotero, startZotero, endZotero] = usePanelWidth(layout0.zoteroWidth, 170, 520, 1, zoteroOpen, setZoteroOpen);
  const [explainWidth, dragExplain, startExplain, endExplain] = usePanelWidth(layout0.explainWidth, 300, 900, -1, explainOpen, setExplainOpen);
  const [mindmapWidth, dragMindmap, startMindmap, endMindmap] = usePanelWidth(layout0.mapWidth, 240, 620, -1, sidebarOpen, setSidebarOpen);

  // Remember the layout so a refresh comes back exactly as it was
  useEffect(() => {
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ zoteroOpen, explainOpen, mapOpen: sidebarOpen, zoteroWidth, explainWidth, mapWidth: mindmapWidth })
      );
    } catch {}
  }, [zoteroOpen, explainOpen, sidebarOpen, zoteroWidth, explainWidth, mindmapWidth]);
  const [mindmapLoading, setMindmapLoading] = useState(false);
  const [mindmapError, setMindmapError] = useState<string | null>(null);
  const [pendingZoteroSave, setPendingZoteroSave] = useState<{
    name: string;
    dataUrl: string;
    docType?: "pdf" | "html";
    sourceUrl?: string;
  } | null>(null);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const bumpLibraryRefresh = useCallback(() => setLibraryRefresh((v) => v + 1), []);
  const [customApi, setCustomApi] = useState<CustomApiConfig | null>(loadCustomApi);
  const [customApiModalOpen, setCustomApiModalOpen] = useState(false);

  // ── Open materials (tabs) ─────────────────────────────────────────
  // Tab metadata persists across restarts; document bytes are cached in
  // memory for instant switching and refetched on demand when missing.
  const [tabs, setTabs] = useState<MaterialTab[]>(loadTabs);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const materialCache = useRef<Record<string, string>>({});

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch {}
  }, [tabs]);

  // Opening a material (library click, file, URL, tab switch) registers a tab
  // and pops the map sidebar. The launch restore doesn't go through here, so
  // a refresh reopens the last paper without disturbing the saved layout.
  const openMaterial = useCallback(
    (name: string, dataUrl: string, docType: DocType = "pdf", zoteroKey?: string, attachmentKey?: string, sourceUrl?: string) => {
      setPdf(name, dataUrl, docType, zoteroKey, attachmentKey, sourceUrl);
      setSidebarOpen(true);
      const id = sessionIdFor(name, zoteroKey);
      materialCache.current[id] = dataUrl;
      const entry: MaterialTab = { id, name, docType, zoteroKey, attachmentKey, sourceUrl };
      setTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev.map((t) => (t.id === id ? { ...t, ...entry } : t))
          : [...prev, entry]
      );
    },
    [setPdf]
  );

  // The paper restored at launch shows as a tab without being stored twice
  const visibleTabs = useMemo<MaterialTab[]>(() => {
    if (!paperId || !session.pdfName || tabs.some((t) => t.id === paperId)) return tabs;
    return [
      ...tabs,
      {
        id: paperId,
        name: session.pdfName,
        docType: session.docType || "pdf",
        zoteroKey: session.zoteroKey,
        attachmentKey: session.zoteroAttachmentKey,
        sourceUrl: session.sourceUrl,
      },
    ];
  }, [tabs, paperId, session.pdfName, session.docType, session.zoteroKey, session.zoteroAttachmentKey, session.sourceUrl]);

  const openTab = useCallback(
    async (id: string) => {
      const tab = visibleTabs.find((t) => t.id === id);
      if (!tab || id === paperId) return;
      setSwitchingTo(id);
      try {
        await flushSave(); // don't lose the current paper's latest turns
        let data = materialCache.current[id];

        if (!data) {
          // Not in memory (e.g. after a restart): reload from Zotero, or from
          // the saved session for materials that don't live in Zotero
          if (tab.zoteroKey) {
            const res = await fetch(`/api/zotero/file?key=${encodeURIComponent(tab.zoteroKey)}`);
            if (!res.ok) throw new Error("zotero fetch failed");
            // Refresh the attachment key so highlights can sync after a restart
            tab.attachmentKey = res.headers.get("X-Attachment-Key") || tab.attachmentKey;
            if ((res.headers.get("Content-Type") || "").includes("text/html")) {
              data = await res.text();
            } else {
              const blob = await res.blob();
              data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error("read failed"));
                reader.readAsDataURL(blob);
              });
            }
          } else {
            const res = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`);
            if (!res.ok) throw new Error("session fetch failed");
            const { state } = await res.json();
            data = state?.pdfDataUrl;
          }
          if (!data) throw new Error("no document data");
          materialCache.current[id] = data;
        }

        openMaterial(tab.name, data, tab.docType, tab.zoteroKey, tab.attachmentKey, tab.sourceUrl);
      } catch {
        // Couldn't reload it — drop the tab rather than leaving a dead one
        setTabs((prev) => prev.filter((t) => t.id !== id));
      } finally {
        setSwitchingTo(null);
      }
    },
    [visibleTabs, paperId, flushSave, openMaterial]
  );

  // Re-read the open material from Zotero, bypassing the in-memory copy, so
  // edits made in Zotero (a replaced file, new annotations) show up here. The
  // conversation and map are restored from the saved session as on any reopen.
  const [reloading, setReloading] = useState(false);
  const reloadCurrentMaterial = useCallback(async () => {
    const tab = visibleTabs.find((t) => t.id === paperId);
    if (!tab?.zoteroKey || reloading) return;
    setReloading(true);
    try {
      await flushSave();
      const res = await fetch(`/api/zotero/file?key=${encodeURIComponent(tab.zoteroKey)}`, { cache: "no-store" });
      if (!res.ok) return;
      const attachmentKey = res.headers.get("X-Attachment-Key") || tab.attachmentKey;
      let data: string;
      if ((res.headers.get("Content-Type") || "").includes("text/html")) {
        data = await res.text();
      } else {
        const blob = await res.blob();
        data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("read failed"));
          reader.readAsDataURL(blob);
        });
      }
      materialCache.current[tab.id] = data;
      openMaterial(tab.name, data, tab.docType, tab.zoteroKey, attachmentKey, tab.sourceUrl);
    } catch {
      // couldn't reach Zotero — keep showing what's already loaded
    } finally {
      setReloading(false);
    }
  }, [visibleTabs, paperId, reloading, flushSave, openMaterial]);

  const closeTab = useCallback(
    (id: string) => {
      delete materialCache.current[id];
      const remaining = visibleTabs.filter((t) => t.id !== id);
      setTabs((prev) => prev.filter((t) => t.id !== id));
      if (id === paperId) {
        const idx = visibleTabs.findIndex((t) => t.id === id);
        const neighbour = remaining[idx] || remaining[idx - 1] || remaining[0];
        if (neighbour) openTab(neighbour.id);
        else clearPaper();
      }
    },
    [visibleTabs, paperId, openTab, clearPaper]
  );
  type ZoteroAnnotation = { key: string; text: string; comment: string; page?: number; type: string; color?: string };
  const [zoteroNotesState, setZoteroNotesState] = useState<{
    forKey: string;
    notes: { key: string; html: string }[];
    annotations: ZoteroAnnotation[];
  } | null>(null);

  // Highlights as of the last render, readable from callbacks that must not
  // re-run every time one changes
  const highlightsRef = useRef(session.highlights);
  useEffect(() => {
    highlightsRef.current = session.highlights;
  }, [session.highlights]);

  // Reconcile the local mirrors against what Zotero just reported. Annotations
  // Zotero returned no longer need a mirror; ones it didn't are checked
  // individually, because "missing" means either "deleted in Zotero" (drop the
  // highlight) or "written seconds ago, not synced down yet" (keep it).
  const reconcileMirroredHighlights = useCallback(
    async (presentKeys: string[]) => {
      const present = new Set(presentKeys);
      dropMirroredHighlights(presentKeys);
      const unresolved = (highlightsRef.current || [])
        .map((h) => h.zoteroKey)
        .filter((k): k is string => !!k && !present.has(k));
      if (unresolved.length === 0) return;
      try {
        const res = await fetch(`/api/zotero/annotations?keys=${unresolved.join(",")}`);
        if (!res.ok) return;
        const { missing } = await res.json();
        if (missing?.length) dropMirroredHighlights(missing);
      } catch {
        // couldn't check — leave the highlights alone
      }
    },
    [dropMirroredHighlights]
  );

  // Load Zotero child notes + PDF annotations for the open paper; display
  // derives from the key match so stale data never shows for a different paper.
  // Only a successful read reconciles — an unreachable Zotero must never be
  // mistaken for "the user deleted these annotations".
  const loadZoteroNotes = useCallback(
    (key: string, isStale: () => boolean) => {
      fetch(`/api/zotero/notes?key=${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("zotero unreachable"))))
        .then((d) => {
          if (isStale()) return;
          const annotations: ZoteroAnnotation[] = d.annotations || [];
          setZoteroNotesState({ forKey: key, notes: d.notes || [], annotations });
          reconcileMirroredHighlights(annotations.map((a) => a.key));
        })
        .catch(() => {
          // Keep whatever was already loaded for this paper — a transient
          // failure shouldn't blank out the notes panel
          if (!isStale()) {
            setZoteroNotesState((prev) => (prev?.forKey === key ? prev : { forKey: key, notes: [], annotations: [] }));
          }
        });
    },
    [reconcileMirroredHighlights]
  );

  useEffect(() => {
    const key = session.zoteroKey;
    if (!key) return;
    let stale = false;
    const isStale = () => stale;
    loadZoteroNotes(key, isStale);
    // Coming back from Zotero is the moment annotations are most likely to have
    // changed, so re-read them when the window regains focus
    const onFocus = () => { if (!document.hidden) loadZoteroNotes(key, isStale); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [session.zoteroKey, loadZoteroNotes]);

  const zoteroLive = session.zoteroKey && zoteroNotesState?.forKey === session.zoteroKey ? zoteroNotesState : null;
  const zoteroNotes = zoteroLive?.notes ?? [];
  const zoteroAnnotations = useMemo(() => zoteroLive?.annotations ?? [], [zoteroLive]);

  // Annotations this session already wrote to Zotero are dropped from the
  // Zotero side: the local copy is the same highlight, and it carries the
  // colour and note even before Zotero has synced the annotation back down.
  const visibleZoteroAnnotations = useMemo(() => {
    const mirrored = new Set((session.highlights || []).map((h) => h.zoteroKey).filter(Boolean));
    return zoteroAnnotations.filter((a) => !mirrored.has(a.key));
  }, [zoteroAnnotations, session.highlights]);

  // Zotero's own PDF highlights painted alongside the user's
  const allHighlights = useMemo(
    () => [
      ...(session.highlights || []),
      ...visibleZoteroAnnotations
        .filter((a) => a.text.trim())
        .map((a) => ({
          id: `zotero-${a.key}`,
          text: a.text,
          pageNumber: a.page,
          note: a.comment || undefined,
          source: "zotero" as const,
          color: a.color,
          createdAt: 0,
        })),
    ],
    [session.highlights, visibleZoteroAnnotations]
  );
  // Passages with a conversation attached, marked in the page itself. Figure
  // captures have no text to mark, and a card whose selection has been cleared
  // has nothing to point at.
  const askedPassages = useMemo(
    () =>
      session.annotations
        .filter((a) => a.type === "text" && a.selectedText?.trim())
        .map((a) => ({
          id: a.id,
          text: a.selectedText!,
          pageNumber: a.pageNumber,
          label: a.label,
        })),
    [session.annotations]
  );

  const annotationRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pdfViewerRef = useRef<PdfViewerHandle>(null);

  // Clicking a highlight in the paper reveals its entry in the Notes panel.
  // The counter distinguishes repeat clicks on the same highlight.
  const [focusNote, setFocusNote] = useState<{ id: string; n: number } | null>(null);
  const revealNote = useCallback((id: string) => {
    setSidebarOpen(true);
    setFocusNote((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
  }, []);

  // Land on the highlight itself. Text search is only the fallback: it starts
  // at the top of the page and, for CJK, often doesn't match the passage at all.
  const jumpToHighlight = useCallback(async (id: string, page: number | undefined, text: string) => {
    const landed = await pdfViewerRef.current?.scrollToHighlight?.(id, page);
    if (!landed && page) pdfViewerRef.current?.highlightText(page, text);
  }, []);

  // Clicking a marked passage in the paper opens its conversation — the mirror
  // of the panel's "view in PDF"
  const openConversation = useCallback((id: string) => {
    setExplainOpen(true);
    setActiveAnnotationId(id);
  }, []);

  const handleDelete = useCallback((id: string) => {
    removeAnnotation(id);
    if (activeAnnotationId === id) setActiveAnnotationId(null);
    delete annotationRefs.current[id];
  }, [removeAnnotation, activeAnnotationId]);

  // In-flight answers, so each can be stopped independently
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const stopAsk = useCallback((annotationId: string) => {
    abortControllers.current.get(annotationId)?.abort();
  }, []);

  // Every question — selection explain, figure, general, follow-up — goes
  // through the fused per-paper conversation on /api/ask. The provider's
  // session id is captured once and resumed for all later asks.
  const streamAsk = useCallback(
    async (
      annotationId: string,
      ask: {
        kind: "explain" | "question" | "figure" | "followup";
        selected_text?: string;
        question?: string;
        page_number?: number;
        image_base64?: string;
        web_search?: boolean;
      }
    ) => {
      setExplainOpen(true);
      setStreamingIds((s) => new Set(s).add(annotationId));
      // One controller per conversation, so Stop cancels this answer and not
      // whatever else is streaming in another card
      abortControllers.current.get(annotationId)?.abort();
      const controller = new AbortController();
      abortControllers.current.set(annotationId, controller);
      try {
        const provider = providerIdFor(session.model);
        const res = await fetch("/api/ask", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper_id: paperId,
            paper_title: session.pdfName,
            ...ask,
            annotation_id: annotationId,
            model: session.model,
            effort: session.effort,
            custom: session.model === "custom" ? customApi : undefined,
            session_id: session.providerSessions?.[provider],
          }),
        });

        if (!res.ok || !res.body) {
          updateLastAssistantMessage(annotationId, "Error: could not get a response from the model.");
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
              // Capture the provider session id — the fused paper conversation
              if (event.type === "turn" && typeof event.turn === "number") {
                // What the model will cite this ask as, if it points back at it
                markTurn(annotationId, event.turn);
              } else if (!sessionCaptured && event.type === "system" && event.session_id) {
                setProviderSession(provider, event.session_id);
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
        // Stopping is a choice, not a failure — keep whatever arrived
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.error(err);
          updateLastAssistantMessage(annotationId, "Error: failed to connect to the model.");
        }
      } finally {
        abortControllers.current.delete(annotationId);
        setStreamingIds((s) => { const next = new Set(s); next.delete(annotationId); return next; });
      }
    },
    [session.model, session.effort, session.pdfName, session.providerSessions, paperId, customApi, updateLastAssistantMessage, setProviderSession, markTurn]
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
      streamAsk(id, { kind: "explain", selected_text: text, page_number: pageNumber });
    },
    [addAnnotation, streamAsk]
  );

  const handleAskAboutSelection = useCallback(
    (text: string, question: string, pageNumber?: number) => {
      const id = addAnnotation({
        type: "text",
        selectedText: text,
        pageNumber,
        messages: [{ role: "user", content: question }, { role: "assistant", content: "" }],
      });
      setActiveAnnotationId(id);
      streamAsk(id, { kind: "question", selected_text: text, question, page_number: pageNumber });
    },
    [addAnnotation, streamAsk]
  );

  // "Ask anything" composer: paper text as context, optional image and a
  // referenced paper from the Zotero library
  const handleAskGeneral = useCallback(
    async (question: string, imageDataUrl?: string, reference?: { key: string; title: string }, webSearch?: boolean) => {
      const displayContent = reference ? `${question}\n\n(referencing: ${reference.title})` : question;
      const id = addAnnotation({
        type: imageDataUrl ? "image" : "text",
        imageDataUrl: imageDataUrl || undefined,
        messages: [
          { role: "user", content: displayContent, ...(imageDataUrl ? { imageDataUrl } : {}) },
          { role: "assistant", content: "" },
        ],
      });
      setActiveAnnotationId(id);

      // A referenced library paper travels inside the question text — the
      // paper itself is already in the fused session's context
      let fusedQuestion = question;
      if (reference) {
        const extracted = await extractZoteroItemText(reference.key);
        if ("text" in extracted) {
          fusedQuestion = `${question}\n\nI am also referencing another paper from my library, "${reference.title}". Its extracted text (possibly truncated):\n\n${extracted.text}`;
        }
      }

      streamAsk(id, {
        kind: imageDataUrl ? "figure" : "question",
        question: fusedQuestion,
        image_base64: imageDataUrl,
        web_search: webSearch,
      });
    },
    [addAnnotation, streamAsk]
  );

  // Zero-copy annotations: for Zotero papers, highlights are written into
  // Zotero as real annotation items. The write happens *after* the local
  // highlight is painted — Zotero round-trips through zotero.org and its sync,
  // which is far too slow to make the user wait for ink on the page.
  const [zoteroSyncError, setZoteroSyncError] = useState<string | null>(null);
  // Highlights undone before their Zotero write came back; the annotation is
  // deleted again as soon as we learn its key, so nothing is left stranded.
  const abandonedHighlights = useRef<Set<string>>(new Set());

  // Every edit to an existing highlight — colour, note — goes through here to
  // the one annotation in Zotero
  const patchZoteroAnnotation = useCallback((key: string, patch: { color?: string; comment?: string }) => {
    fetch("/api/zotero/annotations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...patch }),
    }).catch(() => {});
  }, []);

  const syncHighlightToZotero = useCallback(
    async (
      id: string,
      text: string,
      note: string | undefined,
      page: number | undefined,
      position: { pageIndex: number; rects: number[][] },
      color: string
    ) => {
      const attachmentKey = session.zoteroAttachmentKey;
      if (!attachmentKey) return; // not a Zotero paper — session-local only
      try {
        const res = await fetch("/api/zotero/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachment_key: attachmentKey, text, comment: note, page, position, color }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.key) {
          setZoteroSyncError(data.error || "This highlight could not be saved to Zotero.");
          return;
        }
        if (abandonedHighlights.current.delete(id)) {
          fetch(`/api/zotero/annotations?key=${encodeURIComponent(data.key)}`, { method: "DELETE" }).catch(() => {});
          return;
        }
        setHighlightZoteroKey(id, data.key);
        // Edits made while this write was in flight had no key to target yet.
        // Replay them now so the Zotero copy never lags behind what's on screen.
        const current = (highlightsRef.current || []).find((h) => h.id === id);
        const drift: { color?: string; comment?: string } = {};
        if (current && current.color !== color) drift.color = current.color;
        if (current && (current.note || "") !== (note || "")) drift.comment = current.note || "";
        if (Object.keys(drift).length > 0) patchZoteroAnnotation(data.key, drift);
      } catch {
        setZoteroSyncError("Could not reach Zotero — the highlight is saved locally only.");
      }
    },
    [session.zoteroAttachmentKey, setHighlightZoteroKey, patchZoteroAnnotation]
  );

  // Most-recent-first stack of highlights made on the open paper, for ⌘Z undo.
  // Reset per paper so an undo can never reach back into a different one.
  const highlightUndo = useRef<string[]>([]);
  useEffect(() => {
    highlightUndo.current = [];
  }, [paperId]);

  const handleHighlight = useCallback(
    (text: string, pageNumber?: number, position?: { pageIndex: number; rects: number[][] }, color = DEFAULT_HIGHLIGHT_COLOR) => {
      const id = addHighlight({ text, pageNumber, color });
      highlightUndo.current.push(id);
      if (position) syncHighlightToZotero(id, text, undefined, pageNumber, position, color);
    },
    [addHighlight, syncHighlightToZotero]
  );

  const handleNote = useCallback(
    (text: string, note: string, pageNumber?: number, position?: { pageIndex: number; rects: number[][] }, color = DEFAULT_HIGHLIGHT_COLOR) => {
      const id = addHighlight({ text, note, pageNumber, color });
      highlightUndo.current.push(id);
      if (position) syncHighlightToZotero(id, text, note, pageNumber, position, color);
    },
    [addHighlight, syncHighlightToZotero]
  );

  // Edit a question already asked and send it again, dropping the answer it
  // got and anything after it — the chat-box gesture.
  //
  // What this cannot do is un-ask it: the CLI providers hold their own
  // conversation history server-side and are resumed by session id, so the
  // model still remembers the original wording and reads the edit as a
  // correction. The panel shows only the edited version.
  const handleEditMessage = useCallback(
    (annotationId: string, index: number, text: string) => {
      const annotation = session.annotations.find((a) => a.id === annotationId);
      const previous = annotation?.messages[index];
      if (!annotation || previous?.role !== "user" || !text.trim()) return;

      stopAsk(annotationId);
      replaceMessageFrom(annotationId, index, { role: "user", content: text, imageDataUrl: previous.imageDataUrl });
      setActiveAnnotationId(annotationId);

      // Re-editing the opening question keeps it grounded in its passage; later
      // turns are follow-ups, the passage having been established already
      const opening = index === 0 && !!annotation.selectedText;
      streamAsk(annotationId, {
        kind: opening ? "question" : "followup",
        question: text,
        selected_text: opening ? annotation.selectedText : undefined,
        page_number: opening ? annotation.pageNumber : undefined,
        image_base64: previous.imageDataUrl,
      });
    },
    [session.annotations, replaceMessageFrom, stopAsk, streamAsk]
  );

  const handleRemoveZoteroAnnotation = useCallback(
    (key: string) => {
      const forKey = session.zoteroKey;
      setZoteroNotesState((prev) =>
        prev && prev.forKey === forKey
          ? { ...prev, annotations: prev.annotations.filter((a) => a.key !== key) }
          : prev
      );
      fetch(`/api/zotero/annotations?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    },
    [session.zoteroKey]
  );

  // One entry point for both stores: highlights loaded from Zotero carry a
  // "zotero-<key>" id, ones made here a plain uuid plus (once the write lands)
  // the key of the annotation they were mirrored into.
  const handleRemoveHighlight = useCallback(
    (id: string) => {
      highlightUndo.current = highlightUndo.current.filter((h) => h !== id);
      if (id.startsWith("zotero-")) {
        handleRemoveZoteroAnnotation(id.slice(7));
        return;
      }
      const local = (session.highlights || []).find((h) => h.id === id);
      removeHighlight(id);
      if (local?.zoteroKey) handleRemoveZoteroAnnotation(local.zoteroKey);
      // Written to Zotero but the key hasn't come back yet — clean it up then
      else abandonedHighlights.current.add(id);
    },
    [handleRemoveZoteroAnnotation, removeHighlight, session.highlights]
  );

  const handleRecolorHighlight = useCallback(
    (id: string, color: string) => {
      if (id.startsWith("zotero-")) {
        const key = id.slice(7);
        const forKey = session.zoteroKey;
        setZoteroNotesState((prev) =>
          prev && prev.forKey === forKey
            ? { ...prev, annotations: prev.annotations.map((a) => (a.key === key ? { ...a, color } : a)) }
            : prev
        );
        patchZoteroAnnotation(key, { color });
      } else {
        recolorHighlight(id, color);
        const local = (session.highlights || []).find((h) => h.id === id);
        if (local?.zoteroKey) patchZoteroAnnotation(local.zoteroKey, { color });
      }
    },
    [session.zoteroKey, session.highlights, recolorHighlight, patchZoteroAnnotation]
  );

  // Editing a note goes to the same single copy the highlight lives in
  const handleEditNote = useCallback(
    (id: string, note: string) => {
      if (id.startsWith("zotero-")) {
        const key = id.slice(7);
        const forKey = session.zoteroKey;
        setZoteroNotesState((prev) =>
          prev && prev.forKey === forKey
            ? { ...prev, annotations: prev.annotations.map((a) => (a.key === key ? { ...a, comment: note } : a)) }
            : prev
        );
        patchZoteroAnnotation(key, { comment: note });
      } else {
        setHighlightNote(id, note);
        const local = (session.highlights || []).find((h) => h.id === id);
        if (local?.zoteroKey) patchZoteroAnnotation(local.zoteroKey, { comment: note });
      }
    },
    [session.zoteroKey, session.highlights, setHighlightNote, patchZoteroAnnotation]
  );

  // ⌘Z / Ctrl+Z removes the highlight you just made
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === "z" && (e.metaKey || e.ctrlKey)) || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return; // let text fields undo
      const last = highlightUndo.current.pop();
      if (!last) return;
      e.preventDefault();
      handleRemoveHighlight(last);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleRemoveHighlight]);

  const pdfNameRef = useRef(session.pdfName);
  useEffect(() => {
    pdfNameRef.current = session.pdfName;
  }, [session.pdfName]);

  const handleGenerateMindmap = useCallback(async () => {
    const forPaper = pdfNameRef.current;
    setMindmapLoading(true);
    setMindmapError(null);
    try {
      const paperText = await pdfViewerRef.current?.getDocumentText();
      if (!paperText?.trim()) {
        if (pdfNameRef.current === forPaper) {
          setMindmapError("Could not extract text from this PDF (it may be a scanned document).");
        }
        return;
      }
      const mapModel = session.mapModel || session.model;
      const res = await fetch("/api/mindmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paper_text: paperText,
          paper_id: paperId,
          model: mapModel,
          effort: session.mapEffort || session.effort,
          custom: mapModel === "custom" ? customApi : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate the paper map");
      // Pinned to the originating paper — discarded if the user switched away
      setMindmap(data.mindmap, forPaper);
    } catch (err) {
      if (pdfNameRef.current === forPaper) {
        setMindmapError(err instanceof Error ? err.message : "Failed to generate the paper map");
      }
    } finally {
      setMindmapLoading(false);
    }
  }, [session.model, session.effort, session.mapModel, session.mapEffort, paperId, customApi, setMindmap]);

  // Initialize the paper's context store once per paper: cache the extracted
  // text as paper.md (agentic models read it with file tools), then upload
  // page snapshots in the background so multimodal models can see each page
  // as laid out. Both are skipped server-side if already present.
  const paperInitDone = useRef<string | null>(null);
  useEffect(() => {
    if (restoring || !session.pdfDataUrl || !session.pdfName || !paperId) return;
    if (paperInitDone.current === paperId) return;
    const id = paperId;
    const isPdf = session.docType !== "html";
    const mindmapAtInit = session.mindmap;
    let cancelled = false;
    let tries = 0;

    const uploadPageSnapshots = async () => {
      const PAGE_LIMIT = 30;
      const CHUNK = 4;
      for (let start = 1; start <= PAGE_LIMIT && !cancelled; start += CHUNK) {
        const nums = Array.from({ length: CHUNK }, (_, i) => start + i);
        const imgs = await pdfViewerRef.current?.renderPageImages?.(nums);
        if (!imgs?.length) break;
        await fetch("/api/paper/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, pages: imgs }),
        }).catch(() => {});
      }
    };

    const attempt = async () => {
      if (cancelled) return;
      const text = await pdfViewerRef.current?.getDocumentText(150000);
      if (cancelled) return;
      if (text?.trim()) {
        paperInitDone.current = id;
        try {
          const res = await fetch("/api/paper/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, title: session.pdfName, text, mindmap: mindmapAtInit ?? undefined }),
          });
          const data = await res.json();
          if (!cancelled && isPdf && !data.pagesCount) await uploadPageSnapshots();
        } catch {
          // server unreachable — context files will be written on next open
        }
      } else if (++tries < 15) {
        setTimeout(attempt, 900);
      }
    };
    const t = setTimeout(attempt, 900);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring, session.pdfDataUrl, session.pdfName, session.docType, paperId]);

  // Auto-generate the paper map when new material opens. Waits for the
  // background session restore to finish first — a previously generated map
  // is restored with the session and must never be regenerated.
  const autoMapAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (restoring || !session.pdfDataUrl || !session.pdfName || session.mindmap) return;
    if (autoMapAttempted.current === session.pdfName) return;
    autoMapAttempted.current = session.pdfName;

    let cancelled = false;
    let tries = 0;
    const attempt = async () => {
      if (cancelled) return;
      const probe = await pdfViewerRef.current?.getDocumentText(500);
      if (cancelled) return;
      if (probe?.trim()) {
        handleGenerateMindmap();
      } else if (++tries < 15) {
        setTimeout(attempt, 800);
      }
    };
    const t = setTimeout(attempt, 800);
    return () => { cancelled = true; clearTimeout(t); };
  }, [restoring, session.pdfDataUrl, session.pdfName, session.mindmap, handleGenerateMindmap]);

  const handleRegionCaptured = useCallback(
    (result: RegionResult) => {
      const id = addAnnotation({
        type: "image",
        selectedText: "Figure region",
        imageDataUrl: result.imageDataUrl,
        messages: [{ role: "assistant", content: "" }],
      });
      setActiveAnnotationId(id);
      streamAsk(id, { kind: "figure", image_base64: result.imageDataUrl });
    },
    [addAnnotation, streamAsk]
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
      streamAsk(id, { kind: "figure", image_base64: annotation.imageDataUrl });
    },
    [session.annotations, addAnnotation, streamAsk]
  );

  const handleFollowUp = useCallback(
    (annotationId: string, question: string, imageDataUrl?: string) => {
      const annotation = session.annotations.find((a) => a.id === annotationId);
      if (!annotation) return;

      appendMessage(annotationId, "user", question, imageDataUrl);
      appendMessage(annotationId, "assistant", "");
      setActiveAnnotationId(annotationId);

      // Follow-ups continue the fused paper conversation — the model already
      // has this card's context from earlier turns
      streamAsk(annotationId, { kind: "followup", question, image_base64: imageDataUrl });
    },
    [appendMessage, session.annotations, streamAsk]
  );

  const handlePdfUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        openMaterial(file.name, dataUrl);
        // Offer to file the PDF into the user's Zotero library
        setPendingZoteroSave({ name: file.name, dataUrl });
      };
      reader.readAsDataURL(file);
      e.target.value = "";
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

  const explainModelControls = (
    <ModelPicker
      model={session.model}
      effort={session.effort || "high"}
      onModelChange={(m) => { setModel(m); if (m === "custom" && !customApi) setCustomApiModalOpen(true); }}
      onEffortChange={setEffort}
      onConfigureCustom={() => setCustomApiModalOpen(true)}
    />
  );

  const mapModelControls = (
    <ModelPicker
      model={session.mapModel || session.model}
      effort={session.mapEffort || session.effort || "high"}
      onModelChange={(m) => { setMapModel(m); if (m === "custom" && !customApi) setCustomApiModalOpen(true); }}
      onEffortChange={setMapEffort}
      onConfigureCustom={() => setCustomApiModalOpen(true)}
    />
  );

  if (!isClient) {
    return <div className="h-screen" style={{ background: "var(--paper)" }} />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
      {/* Header */}
      <header
        className="flex items-center gap-2 px-4 shrink-0 h-12"
        style={{
          background: "linear-gradient(180deg, #11161D, var(--paper))",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="flex items-center gap-2 mr-3 select-none">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: "linear-gradient(135deg, var(--accent-bright), var(--accent))", boxShadow: "0 0 8px rgba(232,120,76,0.55)" }}
          />
          <span className="font-semibold text-sm tracking-tight" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
            Paper Reader
          </span>
        </span>

        <label className="btn-primary cursor-pointer text-xs px-3 py-1.5">
          Open PDF
          <input type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
        </label>

        <button onClick={() => setUrlModalOpen(true)} className="btn-ghost text-xs px-3 py-1.5">
          Open URL
        </button>

        {session.pdfName && (
          <span
            className="hidden md:flex items-center gap-1.5 text-xs truncate max-w-[300px] px-2.5 py-1 rounded-full ml-2"
            style={{ color: "var(--ink-muted)", background: "rgba(230,237,243,0.04)", border: "1px solid var(--border-light)" }}
            title={session.pdfName}
          >
            <span className="w-1 h-1 rounded-full shrink-0" style={{ background: "var(--accent)" }} />
            <span className="truncate">{session.pdfName.replace(/\.pdf$/i, "")}</span>
          </span>
        )}

        {/* Save the open material into Zotero — shown when it isn't from there */}
        {session.pdfDataUrl && !session.zoteroKey && (
          <button
            onClick={() =>
              setPendingZoteroSave({
                name: session.pdfName,
                dataUrl: session.pdfDataUrl,
                docType: session.docType === "html" ? "html" : "pdf",
                // Older sessions predate URL tracking — recover the page's real
                // URL from the <base> tag the fetcher embeds in the snapshot
                sourceUrl:
                  session.sourceUrl ||
                  (session.docType === "html"
                    ? session.pdfDataUrl.match(/<base\s+href="([^"]+)"/i)?.[1]
                    : undefined),
              })
            }
            className="btn-ghost text-xs px-3 py-1.5"
            title="Save this material into your Zotero library"
          >
            ⤴ Save to Zotero
          </button>
        )}

        <span className="ml-auto flex items-center gap-2">
          {session.pdfName && (
            <button onClick={saveSession} className="btn-ghost text-xs px-3 py-1.5">
              Save session
            </button>
          )}
          <label className="btn-ghost cursor-pointer text-xs px-3 py-1.5">
            Load session
            <input type="file" accept=".json,application/json" onChange={handleLoadSession} className="hidden" />
          </label>
        </span>
      </header>

      <MaterialTabs
        tabs={visibleTabs}
        activeId={paperId}
        loadingId={switchingTo}
        onSelect={openTab}
        onClose={closeTab}
      />

      {pendingZoteroSave && (
        <SaveToZoteroModal
          fileName={pendingZoteroSave.name}
          dataUrl={pendingZoteroSave.dataUrl}
          docType={pendingZoteroSave.docType}
          sourceUrl={pendingZoteroSave.sourceUrl}
          onDone={() => setPendingZoteroSave(null)}
          onSaved={bumpLibraryRefresh}
        />
      )}

      {urlModalOpen && (
        <OpenUrlModal
          onOpen={(title, data, finalUrl, docType) => openMaterial(title, data, docType, undefined, undefined, finalUrl)}
          onClose={() => setUrlModalOpen(false)}
          onSaved={bumpLibraryRefresh}
        />
      )}

      {/* A highlight that couldn't reach Zotero still exists locally — say so
          rather than letting it look synced */}
      {zoteroSyncError && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs pr-fade-up"
          style={{ background: "var(--paper)", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)", color: "var(--ink)" }}
          role="status"
        >
          <span style={{ color: "#F87171" }}>⚠</span>
          <span className="max-w-[420px]">{zoteroSyncError}</span>
          <button onClick={() => setZoteroSyncError(null)} className="btn-icon w-5 h-5 leading-none" title="Dismiss">×</button>
        </div>
      )}

      {customApiModalOpen && (
        <CustomApiModal
          initial={customApi}
          onSave={(cfg) => {
            setCustomApi(cfg);
            try { localStorage.setItem(CUSTOM_API_KEY, JSON.stringify(cfg)); } catch {}
            setCustomApiModalOpen(false);
          }}
          onClose={() => setCustomApiModalOpen(false)}
        />
      )}

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Far left: Zotero library */}
        <ZoteroLibrary
          onDocumentLoaded={openMaterial}
          activeDocName={session.pdfName}
          isOpen={zoteroOpen}
          onToggle={() => setZoteroOpen((v) => !v)}
          width={zoteroWidth}
          refreshSignal={libraryRefresh}
        />
        <ResizeHandle onDrag={dragZotero} onStart={startZotero} onEnd={endZotero} />

        {/* Left: document pane — always keeps readable width; side panels shrink instead */}
        <div className="flex flex-col overflow-hidden" style={{ flex: "1 1 400px", minWidth: 340, borderRight: "1px solid var(--border)" }}>
          {session.pdfDataUrl && session.docType === "html" ? (
            <HtmlViewer
              ref={pdfViewerRef}
              html={session.pdfDataUrl}
              onTextSelected={handleTextSelected}
              onAskAboutSelection={handleAskAboutSelection}
              onHighlight={handleHighlight}
              onNote={handleNote}
              onRemoveHighlight={handleRemoveHighlight}
              onRecolorHighlight={handleRecolorHighlight}
              onEditHighlightNote={handleEditNote}
              onHighlightClick={revealNote}
              highlights={allHighlights}
              onReload={session.zoteroKey ? reloadCurrentMaterial : undefined}
              reloading={reloading}
            />
          ) : session.pdfDataUrl ? (
            <PdfViewer
              ref={pdfViewerRef}
              pdfDataUrl={session.pdfDataUrl}
              onTextSelected={handleTextSelected}
              onAskAboutSelection={handleAskAboutSelection}
              onRegionCaptured={handleRegionCaptured}
              onHighlight={handleHighlight}
              onNote={handleNote}
              onRemoveHighlight={handleRemoveHighlight}
              onRecolorHighlight={handleRecolorHighlight}
              onEditHighlightNote={handleEditNote}
              onHighlightClick={revealNote}
              highlights={allHighlights}
              askedPassages={askedPassages}
              onAskedClick={openConversation}
              onReload={session.zoteroKey ? reloadCurrentMaterial : undefined}
              reloading={reloading}
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
              <p className="text-sm" style={{ color: "var(--ink-muted)" }}>Open a PDF, or pick a paper from your Zotero library on the left</p>
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

        {/* Right: Explain panel (collapsible) */}
        <ResizeHandle onDrag={dragExplain} onStart={startExplain} onEnd={endExplain} />
        <ExplainPanel
          annotations={session.annotations}
          activeId={activeAnnotationId}
          model={session.model}
          streamingIds={streamingIds}
          onFollowUp={handleFollowUp}
          onStop={stopAsk}
          onEditMessage={handleEditMessage}
          onAskGeneral={handleAskGeneral}
          onDelete={handleDelete}
          onReExplainImage={handleReExplainImage}
          onViewInPdf={handleViewInPdf}
          onCitePaper={(page, quote) => pdfViewerRef.current?.highlightText(page, quote)}
          annotationRefs={annotationRefs}
          isOpen={explainOpen}
          onToggle={() => setExplainOpen((v) => !v)}
          width={explainWidth}
          modelControls={explainModelControls}
        />

        {/* Far right: paper mindmap + concepts + notes */}
        <ResizeHandle onDrag={dragMindmap} onStart={startMindmap} onEnd={endMindmap} />
        <MindmapSidebar
          mindmap={session.mindmap}
          mindmapLoading={mindmapLoading}
          mindmapError={mindmapError}
          hasPdf={!!session.pdfDataUrl}
          onGenerateMindmap={handleGenerateMindmap}
          onJumpToSource={(page, quote) => pdfViewerRef.current?.highlightText(page, quote)}
          onJumpToHighlight={jumpToHighlight}
          onAskAboutNode={handleAskAboutSelection}
          concepts={session.concepts}
          onSelectConcept={(id) => setActiveAnnotationId(id)}
          highlights={session.highlights || []}
          onRemoveHighlight={handleRemoveHighlight}
          onEditNote={handleEditNote}
          focusNote={focusNote}
          zoteroNotes={zoteroNotes}
          zoteroAnnotations={visibleZoteroAnnotations}
          onRemoveZoteroAnnotation={handleRemoveZoteroAnnotation}
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          width={mindmapWidth}
          modelControls={mapModelControls}
        />
      </div>
    </div>
  );
}
