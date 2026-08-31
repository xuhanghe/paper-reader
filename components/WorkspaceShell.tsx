"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MaterialTab } from "@/components/MaterialTabs";
import { SkillsDrawer } from "@/components/SkillsDrawer";
import { ModelPicker } from "@/components/ModelPicker";
import { useAgentSkills } from "@/hooks/useAgentSkills";
import { createZoteroHighlight } from "@/lib/zotero-highlight-api";
import { DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import { flattenZoteroCollections, zoteroCollectionBranch, zoteroPaperTab, type ZoteroCollection, type ZoteroPaper } from "@/lib/workspace-zotero";
import type { CustomApiConfig, Effort, Highlight, Model } from "@/types/session";
import type { ResearchWorkspace, WorkspaceDocument } from "@/types/workspace";
import styles from "./WorkspaceShell.module.css";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((module) => module.PdfViewer), { ssr: false });

const WORKSPACES_KEY = "paper-reader:research-workspaces:v1";
const ACTIVE_WORKSPACE_KEY = "paper-reader:active-workspace:v1";
const READER_TABS_KEY = "paper-reader:open-tabs";
const CUSTOM_API_KEY = "paper-reader:custom-api";
const NO_SUBSCRIBE = () => () => {};
const useIsClient = () => useSyncExternalStore(NO_SUBSCRIBE, () => true, () => false);

type WorkspaceFile = { path: string; name: string; kind: "file" | "directory"; extension?: string; size?: number };
type AgentTool = { name: string; detail: string; status?: string };
type AgentMessage = { id: string; role: "user" | "assistant"; content: string; tools?: AgentTool[] };

function uid() {
  return typeof crypto !== "undefined" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
}

function saveWorkspaces(workspaces: ResearchWorkspace[]) {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces)); } catch {}
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "RW";
}

function safePdfName(name: string) {
  const stem = name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "paper";
  return `${stem}.pdf`;
}

function fileLabel(file: WorkspaceFile) {
  const extension = (file.extension || "file").toUpperCase();
  return extension.length <= 4 ? extension : "FILE";
}

async function responseAsDataUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the PDF."));
    reader.readAsDataURL(blob);
  });
}

async function loadPaperData(paper: MaterialTab): Promise<{ data: string; attachmentKey?: string }> {
  if (paper.zoteroKey) {
    const response = await fetch(`/api/zotero/file?key=${encodeURIComponent(paper.zoteroKey)}`);
    if (!response.ok) throw new Error("Could not load this paper from Zotero.");
    return { data: await responseAsDataUrl(response), attachmentKey: response.headers.get("X-Attachment-Key") || paper.attachmentKey };
  }
  const response = await fetch(`/api/sessions?id=${encodeURIComponent(paper.id)}`);
  if (!response.ok) throw new Error("This local paper is no longer available.");
  const payload = await response.json();
  if (!payload.state?.pdfDataUrl) throw new Error("This local paper has no saved document data.");
  return { data: payload.state.pdfDataUrl, attachmentKey: paper.attachmentKey };
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: ResearchWorkspace) => void }) {
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  if (!open) return null;
  const submit = async () => {
    if (!name.trim() || !root.trim()) { setError("Choose a name and directory."); return; }
    setCreating(true); setError("");
    try {
      const response = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, create: false }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create the workspace.");
      onCreated({ id: uid(), name: name.trim(), root: data.root, createdAt: Date.now(), papers: [] });
      setName(""); setRoot("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the workspace.");
    } finally { setCreating(false); }
  };
  const browse = async () => {
    setBrowsing(true); setError("");
    try {
      const response = await fetch("/api/workspaces/select-directory", {
        method: "POST",
      });
      const data = await response.json();
      if (response.status === 499) return;
      if (!response.ok) throw new Error(data.error || "Could not open the folder picker.");
      setRoot(data.root || "");
      if (!name.trim() && data.root) setName(String(data.root).split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") || "Research workspace");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not choose that folder."); }
    finally { setBrowsing(false); }
  };
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-workspace-title">
        <header><div><small>NEW WORKSPACE</small><h2 id="create-workspace-title">Choose or create its directory</h2></div><button onClick={onClose} aria-label="Close">×</button></header>
        <label><span>NAME</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Efficient inference evaluation" /></label>
        <label><span>WORKING DIRECTORY</span><div className={styles.pathInput}><input value={root} readOnly placeholder="Choose with the macOS folder picker" /><button type="button" onClick={browse} disabled={browsing}>{browsing ? "Opening…" : "Choose / create…"}</button></div></label>
        <p className={styles.nativePickerNote}>Select an existing repository, or use New Folder in the macOS dialog.</p>
        <div className={styles.lockNote}><span>⌘</span><p><strong>This directory is fixed after creation.</strong><small>Create another workspace if you later need a different project root.</small></p></div>
        <p className={styles.zeroPaperNote}>The directory is attached in place. The workspace starts with 0 linked papers; add them later with <strong>＋P</strong>.</p>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={onClose}>Cancel</button><button className={styles.primary} onClick={submit} disabled={creating}>{creating ? "Creating…" : "Create workspace"}</button></footer>
      </section>
    </div>
  );
}

type PaperChoice = { tab: MaterialTab; detail: string };

function PaperPicker({ open, papers, existing, onClose, onAdd }: { open: boolean; papers: MaterialTab[]; existing: MaterialTab[]; onClose: () => void; onAdd: (papers: MaterialTab[]) => void }) {
  const [source, setSource] = useState("__all__");
  const [query, setQuery] = useState("");
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [zoteroPapers, setZoteroPapers] = useState<ZoteroPaper[]>([]);
  const [selected, setSelected] = useState<Record<string, MaterialTab>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const collectionOptions = useMemo(() => flattenZoteroCollections(collections), [collections]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/zotero/collections").then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Zotero collections.");
      if (!cancelled) setCollections(data.collections || []);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load Zotero collections."); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (source === "__reader__") return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const keys = source === "__all__" ? [""] : zoteroCollectionBranch(collections, source);
        const pages = await Promise.all(keys.map(async (collectionKey) => {
          const params = new URLSearchParams();
          if (collectionKey) params.set("collection", collectionKey);
          if (query.trim()) params.set("q", query.trim());
          const response = await fetch(`/api/zotero/items?${params}`, { signal: controller.signal });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not load Zotero papers.");
          return (data.items || []) as ZoteroPaper[];
        }));
        const unique = new Map<string, ZoteroPaper>();
        pages.flat().forEach((paper) => unique.set(paper.key, paper));
        setZoteroPapers([...unique.values()]);
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Could not load Zotero papers.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, source, query, collections]);

  const existingIds = useMemo(() => new Set(existing.flatMap((paper) => [paper.id, paper.zoteroKey].filter(Boolean) as string[])), [existing]);
  const choices = useMemo<PaperChoice[]>(() => {
    if (source === "__reader__") {
      const normalized = query.trim().toLowerCase();
      return papers.filter((paper) => paper.docType === "pdf" && !existingIds.has(paper.id) && !existingIds.has(paper.zoteroKey || ""))
        .filter((paper) => !normalized || paper.name.toLowerCase().includes(normalized))
        .map((tab) => ({ tab, detail: tab.zoteroKey ? "Open Zotero tab · zero copy" : "Open Reader tab · zero copy" }));
    }
    return zoteroPapers.filter((paper) => !existingIds.has(paper.key)).map((paper) => ({
      tab: zoteroPaperTab(paper),
      detail: [paper.creators, paper.year, "Zotero link · zero copy"].filter(Boolean).join(" · "),
    }));
  }, [source, query, papers, zoteroPapers, existingIds]);

  const close = () => { setSelected({}); setQuery(""); setSource("__all__"); setVisibleCount(100); setError(""); onClose(); };
  const toggle = (choice: PaperChoice) => setSelected((current) => {
    const next = { ...current };
    if (next[choice.tab.id]) delete next[choice.tab.id]; else next[choice.tab.id] = choice.tab;
    return next;
  });

  if (!open) return null;
  const selectedCount = Object.keys(selected).length;
  const allShownSelected = choices.length > 0 && choices.every((choice) => !!selected[choice.tab.id]);
  const toggleSelectAll = () => setSelected((current) => {
    const next = { ...current };
    if (allShownSelected) choices.forEach((choice) => delete next[choice.tab.id]);
    else choices.forEach((choice) => { next[choice.tab.id] = choice.tab; });
    return next;
  });
  return (
    <div className={styles.modalBackdrop}>
      <section className={`${styles.modal} ${styles.paperModal}`} role="dialog" aria-modal="true" aria-labelledby="add-papers-title">
        <header><div><small>ZOTERO LIBRARY</small><h2 id="add-papers-title">Attach papers</h2></div><button onClick={close} aria-label="Close">×</button></header>
        <div className={styles.paperPickerToolbar}>
          <select value={source} onChange={(event) => { setSource(event.target.value); setQuery(""); setVisibleCount(100); if (event.target.value === "__reader__") setLoading(false); }} aria-label="Paper source">
            <option value="__all__">All Zotero papers</option>
            {collectionOptions.map((collection) => <option key={collection.key} value={collection.key}>{`${"\u00a0\u00a0".repeat(collection.depth)}${collection.name} (${collection.numItems})`}</option>)}
            <option value="__reader__">Open Reader tabs</option>
          </select>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(100); }} placeholder={source === "__reader__" ? "Search open tabs…" : "Search Zotero by title, creator, or year…"} autoFocus />
        </div>
        <div className={styles.paperPickerSummary}>
          <p><strong>{loading ? "Searching…" : `${choices.length} available`}</strong><small>{selectedCount ? `${selectedCount} selected` : "PDFs remain linked to Zotero"}</small></p>
          <button onClick={toggleSelectAll} disabled={loading || !choices.length}>{allShownSelected ? "Clear all shown" : `Select all ${choices.length || ""}`}</button>
        </div>
        <div className={styles.paperPicker}>
          {!loading && choices.length === 0 && <p className={styles.empty}>{error || (query ? "No matching papers." : "No unattached papers in this source.")}</p>}
          {choices.slice(0, visibleCount).map((choice) => <label key={choice.tab.id}><input type="checkbox" checked={!!selected[choice.tab.id]} onChange={() => toggle(choice)} /><span className={styles.kindPdf}>PDF</span><p><strong>{choice.tab.name.replace(/\.pdf$/i, "")}</strong><small>{choice.detail}</small></p></label>)}
          {choices.length > visibleCount && <button className={styles.loadMore} onClick={() => setVisibleCount((count) => count + 100)}>Show 100 more <small>{choices.length - visibleCount} remaining</small></button>}
        </div>
        {error && choices.length > 0 && <p className={styles.error}>{error}</p>}
        <footer><button onClick={close}>Cancel</button><button className={styles.primary} disabled={!selectedCount} onClick={() => { const tabs = Object.values(selected); setSelected({}); onAdd(tabs); }}>Attach {selectedCount || ""} paper{selectedCount === 1 ? "" : "s"}</button></footer>
      </section>
    </div>
  );
}

function CopyPapersDialog({ open, workspace, onClose, onCopied }: { open: boolean; workspace: ResearchWorkspace; onClose: () => void; onCopied: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  if (!open) return null;
  const close = () => { setSelected([]); setError(""); onClose(); };
  const copy = async () => {
    setCopying(true); setError("");
    try {
      for (const paper of workspace.papers.filter((item) => selected.includes(item.id))) {
        const loaded = await loadPaperData(paper);
        const response = await fetch("/api/workspaces/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: workspace.root, path: `papers/${safePdfName(paper.name)}`, dataUrl: loaded.data }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Could not copy ${paper.name}.`);
      }
      onCopied(); close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not copy the selected PDFs."); }
    finally { setCopying(false); }
  };
  return (
    <div className={styles.modalBackdrop}>
      <section className={styles.modal} role="dialog" aria-modal="true">
        <header><div><small>EXPLICIT FILE COPY</small><h2>Choose PDFs to copy</h2></div><button onClick={close}>×</button></header>
        <div className={styles.destination}><span>⌘</span><p><strong>Destination</strong><code>{workspace.root}/papers</code></p></div>
        <div className={styles.paperPicker}>{workspace.papers.map((paper) => <label key={paper.id}><input type="checkbox" checked={selected.includes(paper.id)} onChange={() => setSelected((current) => current.includes(paper.id) ? current.filter((id) => id !== paper.id) : [...current, paper.id])} /><span className={styles.kindPdf}>PDF</span><p><strong>{paper.name.replace(/\.pdf$/i, "")}</strong><small>Linked source remains unchanged</small></p></label>)}</div>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={close}>Cancel</button><button className={styles.primary} onClick={copy} disabled={!selected.length || copying}>{copying ? "Copying…" : `Copy ${selected.length || "selected"} PDF${selected.length === 1 ? "" : "s"}`}</button></footer>
      </section>
    </div>
  );
}

export function WorkspaceShell() {
  const router = useRouter();
  const isClient = useIsClient();
  const [workspaces, setWorkspaces] = useState<ResearchWorkspace[]>(() => loadJson(WORKSPACES_KEY, []));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => loadJson<string | null>(ACTIVE_WORKSPACE_KEY, null) || workspaces[0]?.id || null);
  const [createOpen, setCreateOpen] = useState(() => workspaces.length === 0);
  const [paperPickerOpen, setPaperPickerOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [readerTabs] = useState<MaterialTab[]>(() => loadJson(READER_TABS_KEY, []));
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [openDocs, setOpenDocs] = useState<WorkspaceDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState("");
  const [pdfAttachmentKey, setPdfAttachmentKey] = useState<string | undefined>();
  const [pdfError, setPdfError] = useState("");
  const [pdfHighlights, setPdfHighlights] = useState<Highlight[]>([]);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState<Model>("claude-sonnet-4-6");
  const [effort, setEffort] = useState<Effort>("high");
  const [writeOnce, setWriteOnce] = useState(false);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const initialChat = loadJson<{ messages: AgentMessage[]; session?: string }>(`paper-reader:workspace-chat:${activeWorkspaceId || "none"}`, { messages: [] });
  const [messages, setMessages] = useState<AgentMessage[]>(initialChat.messages || []);
  const [providerSession, setProviderSession] = useState<string | undefined>(initialChat.session);
  const { skills, activeSkillIds, toggleSkill, loading: skillsLoading } = useAgentSkills();
  const abortRef = useRef<AbortController | null>(null);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces[0] || null;
  const activeDoc = openDocs.find((document) => document.id === activeDocId) || null;

  const persist = useCallback((next: ResearchWorkspace[]) => { setWorkspaces(next); saveWorkspaces(next); }, []);

  const refreshFiles = useCallback(async () => {
    if (!activeWorkspace) return;
    setFilesLoading(true);
    try {
      const response = await fetch(`/api/workspaces/files?root=${encodeURIComponent(activeWorkspace.root)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setFiles(data.files || []);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Could not read workspace files."); }
    finally { setFilesLoading(false); }
  }, [activeWorkspace]);

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);

  useEffect(() => {
    if (!activeWorkspace) return;
    try { localStorage.setItem(`paper-reader:workspace-chat:${activeWorkspace.id}`, JSON.stringify({ messages, session: providerSession })); } catch {}
  }, [messages, providerSession, activeWorkspace]);

  const switchWorkspace = (id: string) => {
    const saved = loadJson<{ messages: AgentMessage[]; session?: string }>(`paper-reader:workspace-chat:${id}`, { messages: [] });
    setActiveWorkspaceId(id); setMessages(saved.messages || []); setProviderSession(saved.session);
    setOpenDocs([]); setActiveDocId(null); setPdfData(""); setEditorContent("");
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(id)); } catch {}
  };

  const openDocument = useCallback(async (document: WorkspaceDocument) => {
    setOpenDocs((current) => current.some((item) => item.id === document.id) ? current : [...current, document]);
    setActiveDocId(document.id); setPreview(false); setNotice("");
    if (document.kind === "paper" || document.kind === "workspacePdf") {
      setPdfData(""); setPdfError(""); setPdfHighlights([]);
      try {
        if (document.kind === "paper") {
          const loaded = await loadPaperData(document.paper);
          setPdfData(loaded.data); setPdfAttachmentKey(loaded.attachmentKey);
        } else {
          if (!activeWorkspace) return;
          const response = await fetch(`/api/workspaces/files?root=${encodeURIComponent(activeWorkspace.root)}&path=${encodeURIComponent(document.path)}&raw=1`);
          if (!response.ok) throw new Error("Could not read this workspace PDF.");
          setPdfData(await responseAsDataUrl(response)); setPdfAttachmentKey(undefined);
        }
      } catch (reason) { setPdfError(reason instanceof Error ? reason.message : "Could not load this paper."); }
      return;
    }
    if (!activeWorkspace) return;
    try {
      const response = await fetch(`/api/workspaces/files?root=${encodeURIComponent(activeWorkspace.root)}&path=${encodeURIComponent(document.path)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setEditorContent(data.content); setSavedContent(data.content);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Could not open this file."); }
  }, [activeWorkspace]);

  const closeDocument = (id: string) => {
    const index = openDocs.findIndex((document) => document.id === id);
    const next = openDocs.filter((document) => document.id !== id);
    setOpenDocs(next);
    if (activeDocId === id) {
      const neighbour = next[Math.max(0, index - 1)] || next[0];
      if (neighbour) void openDocument(neighbour); else setActiveDocId(null);
    }
  };

  const saveFile = async () => {
    if (!activeWorkspace || activeDoc?.kind !== "file") return;
    const response = await fetch("/api/workspaces/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: activeWorkspace.root, path: activeDoc.path, content: editorContent }) });
    const data = await response.json();
    if (!response.ok) { setNotice(data.error || "Could not save the file."); return; }
    setSavedContent(editorContent); setNotice(`Saved ${activeDoc.path}`); void refreshFiles();
  };

  const createFile = async () => {
    if (!activeWorkspace) return;
    const suggested = `notes/untitled-${files.filter((file) => file.name.startsWith("untitled-")).length + 1}.md`;
    const relative = window.prompt("New file path inside this workspace", suggested)?.trim();
    if (!relative) return;
    const response = await fetch("/api/workspaces/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: activeWorkspace.root, path: relative, content: `# ${relative.split("/").pop()?.replace(/\.[^.]+$/, "") || "New note"}\n\n` }) });
    const data = await response.json();
    if (!response.ok) { setNotice(data.error || "Could not create the file."); return; }
    await refreshFiles();
    void openDocument({ id: `file:${relative}`, kind: "file", path: relative, name: relative.split("/").pop() || relative, extension: relative.split(".").pop() || "" });
  };

  const addPapers = (papers: MaterialTab[]) => {
    if (!activeWorkspace) return;
    const next = workspaces.map((workspace) => workspace.id === activeWorkspace.id ? { ...workspace, papers: [...workspace.papers, ...papers.filter((paper) => !workspace.papers.some((item) => item.id === paper.id))] } : workspace);
    persist(next); setPaperPickerOpen(false);
  };

  const detachPaper = (paper: MaterialTab) => {
    if (!activeWorkspace) return;
    persist(workspaces.map((workspace) => workspace.id === activeWorkspace.id ? { ...workspace, papers: workspace.papers.filter((item) => item.id !== paper.id) } : workspace));
    closeDocument(`paper:${paper.id}`);
    setNotice(`Detached “${paper.name.replace(/\.pdf$/i, "")}” from this workspace. Zotero was not changed.`);
  };

  const removeHighlight = (id: string) => {
    const item = pdfHighlights.find((highlight) => highlight.id === id);
    setPdfHighlights((current) => current.filter((highlight) => highlight.id !== id));
    if (item?.zoteroKey) fetch(`/api/zotero/annotations?key=${encodeURIComponent(item.zoteroKey)}`, { method: "DELETE" }).catch(() => {});
  };

  const makeHighlight = async (text: string, pageNumber?: number, position?: { pageIndex: number; rects: number[][] }, color = DEFAULT_HIGHLIGHT_COLOR, note?: string, occurrence = 0) => {
    const id = uid();
    setPdfHighlights((current) => [...current, { id, text, pageNumber, position, color, note, occurrence, createdAt: Date.now() }]);
    if (!pdfAttachmentKey || !position) return;
    try {
      const created = await createZoteroHighlight(pdfAttachmentKey, { text, pageIndex: position.pageIndex, rects: position.rects }, { color, comment: note });
      setPdfHighlights((current) => current.map((highlight) => highlight.id === id ? { ...highlight, zoteroKey: created.key } : highlight));
    } catch { setNotice("The highlight is visible here, but could not sync to Zotero."); }
  };

  const askAgent = async () => {
    if (!activeWorkspace || !question.trim() || streaming) return;
    const userText = question.trim();
    const assistantId = uid();
    setMessages((current) => [...current, { id: uid(), role: "user", content: userText }, { id: assistantId, role: "assistant", content: "", tools: [] }]);
    setQuestion(""); setStreaming(true);
    const approved = writeOnce; setWriteOnce(false);
    const controller = new AbortController(); abortRef.current = controller;
    const context = activeDoc?.kind === "file" ? `Open file: ${activeDoc.path}\n\n${editorContent}` : activeDoc?.kind === "paper" ? `Open paper: ${activeDoc.paper.name}\nZotero key: ${activeDoc.paper.zoteroKey || "local reader paper"}` : activeDoc?.kind === "workspacePdf" ? `Open workspace PDF: ${activeDoc.path}` : "No document is open.";
    try {
      const custom = loadJson<CustomApiConfig | null>(CUSTOM_API_KEY, null);
      const response = await fetch("/api/workspaces/ask", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: activeWorkspace.root, question: userText, context, model, effort, custom, session_id: providerSession, allow_writes: approved, skills: activeSkillIds }) });
      if (!response.ok || !response.body) throw new Error(await response.text());
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let carry = ""; let text = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        carry += decoder.decode(value, { stream: true }); const lines = carry.split("\n"); carry = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "system" && event.session_id) setProviderSession(event.session_id);
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text;
            if (event.type === "result" && typeof event.result === "string" && !text) text = event.result;
            const tools: AgentTool[] = [];
            if (event.type === "tool") tools.push({ name: event.name, detail: event.detail, status: event.status });
            if (event.type === "assistant" && Array.isArray(event.message?.content)) {
              for (const block of event.message.content) {
                if (block.type === "text" && typeof block.text === "string") text += block.text;
                if (block.type === "tool_use") tools.push({ name: block.name || "tool", detail: JSON.stringify(block.input || {}).slice(0, 180), status: "requested" });
              }
            }
            setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: text, tools: tools.length ? [...(message.tools || []), ...tools] : message.tools } : message));
          } catch {}
        }
      }
      if (approved) void refreshFiles();
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: `Error: ${reason instanceof Error ? reason.message : "Could not reach the agent."}` } : message));
    } finally { abortRef.current = null; setStreaming(false); }
  };

  const fileRows = useMemo(() => files.filter((file) => file.kind === "file"), [files]);

  if (!isClient) return <div className={styles.app} />;

  return (
    <div className={styles.app}>
      <header className="pr-app-bar">
        <div className="pr-brand"><span>P</span><strong>Paper Reader</strong></div>
        <nav className="pr-surface-switch" aria-label="Application surface"><Link href="/">Reader</Link><Link href="/workspace" className="active" aria-current="page">Workspace</Link></nav>
        <div className="pr-reader-actions"><span className="pr-web-pill">🌐 Web on</span><button className="pr-capability-button" onClick={() => setSkillsOpen(true)}>◆ Skills <small>{activeSkillIds.length || ""}</small></button>{activeWorkspace && <span className={styles.workspaceName}><i />{activeWorkspace.name}</span>}</div>
      </header>

      <main className={styles.shell}>
        <nav className={styles.rail} aria-label="Research workspaces">
          {workspaces.map((workspace) => <button key={workspace.id} className={workspace.id === activeWorkspace?.id ? styles.active : ""} onClick={() => switchWorkspace(workspace.id)} title={workspace.name}><b>{initials(workspace.name)}</b><span>{workspace.name}</span></button>)}
          <button className={styles.newWorkspace} onClick={() => setCreateOpen(true)} title="New workspace">＋</button>
        </nav>

        <aside className={styles.projectSidebar}>
          <header><div><span>WORKSPACE</span><small>{activeWorkspace ? `${activeWorkspace.papers.length} papers · ${fileRows.length} files` : "No workspace"}</small></div><p><button onClick={() => setPaperPickerOpen(true)} disabled={!activeWorkspace} title="Add linked paper">＋P</button><button onClick={createFile} disabled={!activeWorkspace} title="New file">＋</button></p></header>
          <div className={styles.tree}>
            <section>
              <h3><span>▾</span>SOURCE PAPERS <small>{activeWorkspace?.papers.length || 0}</small></h3>
              {activeWorkspace?.papers.map((paper) => {
                const documentId = `paper:${paper.id}`;
                return <div key={paper.id} className={`${styles.paperRow} ${activeDocId === documentId ? styles.activeRow : ""}`}>
                  <button className={styles.paperOpen} onClick={() => void openDocument({ id: documentId, kind: "paper", paper })}>
                    <span className={styles.kindPdf}>PDF</span><p><strong>{paper.name.replace(/\.pdf$/i, "")}</strong><small>{paper.zoteroKey ? "Zotero link" : "Reader link"} · zero copy</small></p>
                  </button>
                  <button className={styles.detachPaper} onClick={() => detachPaper(paper)} title="Detach from workspace" aria-label={`Detach ${paper.name.replace(/\.pdf$/i, "")} from this workspace`}>×</button>
                </div>;
              })}
              {activeWorkspace && !activeWorkspace.papers.length && <p className={styles.treeEmpty}>Search Zotero or select a collection with ＋P.</p>}
            </section>
            <section><h3><span>▾</span>WORKING FILES <small>Editable</small></h3>{filesLoading && <p className={styles.treeEmpty}>Reading directory…</p>}{fileRows.map((file) => { const pdf = file.extension === "pdf"; const id = `${pdf ? "workspace-pdf" : "file"}:${file.path}`; return <button key={file.path} className={activeDocId === id ? styles.activeRow : ""} style={{ paddingLeft: `${10 + Math.min(3, file.path.split("/").length - 1) * 12}px` }} onClick={() => void openDocument(pdf ? { id, kind: "workspacePdf", path: file.path, name: file.name } : { id, kind: "file", path: file.path, name: file.name, extension: file.extension || "" })}><span className={pdf ? styles.kindPdf : styles.fileKind}>{fileLabel(file)}</span><p><strong>{file.name}</strong><small>{file.path}</small></p></button>; })}</section>
          </div>
          {activeWorkspace && <footer><button onClick={() => setCopyOpen(true)} disabled={!activeWorkspace.papers.length}><span>⇩</span><strong>Copy selected PDFs…</strong></button><button onClick={() => setSkillsOpen(true)}><span>◆</span><strong>Skills</strong><small>{activeSkillIds.length} active</small></button></footer>}
        </aside>

        <section className={styles.documentPanel}>
          <div className={styles.docTabs}>{openDocs.map((document) => { const pdf = document.kind === "paper" || document.kind === "workspacePdf"; return <button key={document.id} className={document.id === activeDocId ? styles.activeTab : ""} onClick={() => void openDocument(document)}><span className={pdf ? styles.kindPdf : styles.fileKind}>{pdf ? "PDF" : (document.kind === "file" ? (document.extension || "FILE").toUpperCase() : "FILE")}</span><strong>{document.kind === "paper" ? document.paper.name.replace(/\.pdf$/i, "") : document.name}</strong><i onClick={(event) => { event.stopPropagation(); closeDocument(document.id); }}>×</i></button>; })}</div>
          {!activeDoc && <div className={styles.emptyDocument}><span>⌘</span><h2>Open a paper or workspace file</h2><p>PDFs and editable files share this center surface. The agent follows the document you open.</p>{activeWorkspace && <button onClick={() => setPaperPickerOpen(true)}>Add a paper</button>}</div>}
          {(activeDoc?.kind === "paper" || activeDoc?.kind === "workspacePdf") && <div className={styles.pdfStage}>{pdfError ? <div className={styles.emptyDocument}><h2>Paper unavailable</h2><p>{pdfError}</p></div> : pdfData ? <PdfViewer pdfDataUrl={pdfData} onTextSelected={(text, page) => setQuestion(`Explain this passage from page ${page || "?"}:\n\n“${text}”`)} onAskAboutSelection={(text, prompt, page) => setQuestion(`${prompt}\n\nPassage from page ${page || "?"}:\n“${text}”`)} onRegionCaptured={() => {}} onHighlight={(text, page, position, color, occurrence) => void makeHighlight(text, page, position, color, undefined, occurrence)} onNote={(text, note, page, position, color, occurrence) => void makeHighlight(text, page, position, color, note, occurrence)} onRemoveHighlight={removeHighlight} highlights={pdfHighlights} /> : <div className={styles.emptyDocument}><p>Loading PDF…</p></div>}</div>}
          {activeDoc?.kind === "file" && <><header className={styles.editorToolbar}><div><strong>{activeDoc.path}</strong><small>{activeDoc.extension === "md" ? "Markdown" : "Text"} · editable workspace file</small></div>{activeDoc.extension === "md" && <span><button className={!preview ? styles.selected : ""} onClick={() => setPreview(false)}>Edit</button><button className={preview ? styles.selected : ""} onClick={() => setPreview(true)}>Preview</button></span>}<p><small className={editorContent === savedContent ? "" : styles.unsaved}>{editorContent === savedContent ? "Saved" : "Unsaved"}</small><button onClick={saveFile}>Save ⌘S</button></p></header><div className={styles.editorStage}>{preview && activeDoc.extension === "md" ? <article className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]}>{editorContent}</ReactMarkdown></article> : <textarea value={editorContent} onChange={(event) => setEditorContent(event.target.value)} spellCheck={false} />}</div></>}
        </section>

        <aside className={styles.agentPanel}>
          <header><div><span>✦</span><p><strong>Workspace Agent</strong><small>{activeDoc ? `Working with ${activeDoc.kind === "paper" ? activeDoc.paper.name : activeDoc.path}` : "Workspace context"}</small></p></div><ModelPicker model={model} effort={effort} onModelChange={setModel} onEffortChange={setEffort} onConfigureCustom={() => setNotice("Configure custom models from Reader.")} /></header>
          <div className={styles.messages}>{!messages.length && <div className={styles.agentWelcome}><span>✦</span><h2>Start with the decision you need to make</h2><p>I can read the open document, inspect workspace files, search the live web, use your active skills, and turn an idea into an experiment handoff.</p><button onClick={() => setQuestion("Evaluate whether this idea is novel, feasible, and worth a small experiment.")}>Evaluate an idea</button><button onClick={() => setQuestion("Search for the latest related work and identify the strongest novelty risk.")}>Check latest related work</button></div>}{messages.map((message) => <article key={message.id} className={message.role === "user" ? styles.userMessage : styles.agentMessage}>{message.role === "assistant" && <span>✦</span>}<div>{message.tools && message.tools.length > 0 && <details className={styles.tools}><summary>✓ Used {message.tools.length} tool{message.tools.length === 1 ? "" : "s"}</summary>{message.tools.map((tool, index) => <p key={`${tool.name}-${index}`}><strong>{tool.name}</strong><small>{tool.detail}</small></p>)}</details>}<ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (streaming ? "Working…" : "")}</ReactMarkdown></div></article>)}</div>
          <footer className={styles.composerArea}><div className={styles.composer}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void askAgent(); } }} placeholder="Ask about the open document or workspace…" /><div><span><button className={styles.webStatic} title="Live web search is always available">🌐 Web on</button><button onClick={() => setSkillsOpen(true)}>◆ {activeSkillIds.length} skills</button><button className={writeOnce ? styles.writeApproved : ""} onClick={() => setWriteOnce((value) => !value)} title="Approve file writes for only the next message">{writeOnce ? "✓ Write once" : "⌘ Read only"}</button></span>{streaming ? <button className={styles.send} onClick={() => abortRef.current?.abort()}>■</button> : <button className={styles.send} disabled={!question.trim() || !activeWorkspace} onClick={() => void askAgent()}>↑</button>}</div></div><small>{writeOnce ? "Next message may edit files inside the fixed directory" : "Current document + workspace attached · writes require approval"}</small></footer>
        </aside>
      </main>

      {notice && <div className={styles.toast}>{notice}<button onClick={() => setNotice("")}>×</button></div>}
      <SkillsDrawer open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={skills} activeIds={activeSkillIds} onToggle={toggleSkill} loading={skillsLoading} />
      <CreateWorkspaceDialog open={createOpen} onClose={() => { if (workspaces.length) setCreateOpen(false); else router.replace("/"); }} onCreated={(workspace) => { const next = [...workspaces, workspace]; persist(next); switchWorkspace(workspace.id); setCreateOpen(false); }} />
      {activeWorkspace && <PaperPicker open={paperPickerOpen} papers={readerTabs} existing={activeWorkspace.papers} onClose={() => setPaperPickerOpen(false)} onAdd={addPapers} />}
      {activeWorkspace && <CopyPapersDialog open={copyOpen} workspace={activeWorkspace} onClose={() => setCopyOpen(false)} onCopied={() => { setNotice("Selected PDFs copied into this workspace."); void refreshFiles(); }} />}
    </div>
  );
}
