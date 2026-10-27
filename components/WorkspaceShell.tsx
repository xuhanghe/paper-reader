"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import ReactMarkdown, { defaultUrlTransform, type Options as MarkdownOptions } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { MaterialTabs, type MaterialTab } from "@/components/MaterialTabs";
import { loadOpenTabs } from "@/lib/open-tabs";
import { createTabStore } from "@/lib/tab-store";
import { loadPaperData, loadWorkspacePdf } from "@/lib/paper-data";
import { SkillsDrawer } from "@/components/SkillsDrawer";
import { WorkspaceAgent, type AgentAsk, type WorkspaceAgentHandle } from "@/components/WorkspaceAgent";
import { CopyPapersDialog, CreateWorkspaceDialog, DeleteWorkspaceDialog, PaperPicker } from "@/components/WorkspaceDialogs";
import { CollapsedRail, ResizeHandle, usePanelWidth } from "@/components/ResizablePanel";
import { useAgentSkills } from "@/hooks/useAgentSkills";
import { useWorkspaceFiles } from "@/hooks/useWorkspaceFiles";
import { createZoteroHighlight } from "@/lib/zotero-highlight-api";
import { DEFAULT_HIGHLIGHT_COLOR } from "@/lib/highlight-colors";
import type { AskedPassage, PdfViewerHandle, SelectionSegment } from "@/components/PdfViewer";
import { saveDraft } from "@/lib/drafts";
import { uid } from "@/lib/uid";
import { forgetChat } from "@/lib/workspace-chat";
import type { Annotation, Highlight, PdfRects } from "@/types/session";
import type { ResearchWorkspace, WorkspaceDocument } from "@/types/workspace";
import styles from "./workspace-shell.module.css";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((module) => module.PdfViewer), { ssr: false });

const WORKSPACES_KEY = "paper-reader:research-workspaces:v1";
const ACTIVE_WORKSPACE_KEY = "paper-reader:active-workspace:v1";
const WORKSPACE_DOCS_KEY = "paper-reader:workspace-docs:v1";

// Same mechanism as the Reader's open-tabs store, keyed per workspace — a
// workspace's open documents are its own, but they load, save and notify
// exactly as the Reader's do.
const docStore = (workspaceId: string) =>
  createTabStore<WorkspaceDocument>(
    `${WORKSPACE_DOCS_KEY}:${workspaceId}`,
    (entry) => {
      const doc = entry as WorkspaceDocument | null;
      return !!doc?.id && (doc.kind === "paper" ? !!doc.paper?.name : !!doc.name);
    }
  );
const WORKSPACE_ACTIVE_DOC_KEY = "paper-reader:workspace-active-doc:v1";
const WORKSPACE_LAYOUT_KEY = "paper-reader:workspace-layout:v1";
const NO_SUBSCRIBE = () => () => {};
const useIsClient = () => useSyncExternalStore(NO_SUBSCRIBE, () => true, () => false);


// What the Reader knows about a paper, shown and kept here too: its
// highlights (the reader's own, and Zotero's), and the passages with a
// conversation attached. One paper, one set of marks, whichever surface.
type ZoteroAnnotation = { key: string; text: string; comment: string; page?: number; position?: PdfRects; type: string; color?: string };
type PaperMarks = { sessionId: string | null; highlights: Highlight[]; zotero: ZoteroAnnotation[]; asked: AskedPassage[] };
const NO_MARKS: PaperMarks = { sessionId: null, highlights: [], zotero: [], asked: [] };

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
}

function saveWorkspaces(workspaces: ResearchWorkspace[]) {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces)); } catch {}
}

// The document that was being read in a workspace, if it is still open there
function savedActiveDoc(workspaceId: string | null, docs: WorkspaceDocument[]): string | null {
  if (!workspaceId) return null;
  const id = loadJson<string | null>(`${WORKSPACE_ACTIVE_DOC_KEY}:${workspaceId}`, null);
  return id && docs.some((doc) => doc.id === id) ? id : null;
}

// A document's content, wherever it lives: a paper's PDF (Zotero, or a
// Reader session), a PDF in the workspace folder, or a file's text
type DocumentContent = { pdf: string; attachmentKey?: string } | { text: string };
async function readDocument(document: WorkspaceDocument, root: string | undefined): Promise<DocumentContent> {
  if (document.kind === "paper") {
    const loaded = await loadPaperData(document.paper);
    return { pdf: loaded.data, attachmentKey: loaded.attachmentKey };
  }
  if (!root) throw new Error("No workspace is open.");
  if (document.kind === "workspacePdf") return { pdf: await loadWorkspacePdf(root, document.path, document.id) };
  const response = await fetch(`/api/workspaces/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(document.path)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not open this file.");
  return { text: data.content };
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "RW";
}

// One document shape, tinted per type — the tint is the identity, the way a
// VS Code icon theme's colours are, instead of a lettered badge block.
const FILE_TINTS: Record<string, string> = {
  md: "#6cb6ff", markdown: "#6cb6ff",
  pdf: "#e2a36a",
  json: "#d9b96c", yaml: "#d9b96c", yml: "#d9b96c", toml: "#d9b96c",
  png: "#b18ae0", jpg: "#b18ae0", jpeg: "#b18ae0", webp: "#b18ae0", svg: "#b18ae0", gif: "#b18ae0",
  py: "#8fd18a", ts: "#7fb6e8", tsx: "#7fb6e8", js: "#e8d67f", ipynb: "#e8a87f", sh: "#8fd18a",
  csv: "#8fd1c0", tsv: "#8fd1c0", tex: "#8fd1c0", bib: "#8fd1c0",
};

function FileGlyph({ extension }: { extension?: string }) {
  const tint = FILE_TINTS[(extension || "").toLowerCase()] || "#98a2ab";
  return (
    <svg className={styles.fileGlyph} viewBox="0 0 16 16" width={15} height={15} aria-hidden="true" style={{ color: tint }}>
      <path d="M4 1.75h5.2l2.8 2.8v9.7H4z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      <path d="M9.2 1.75v2.8H12" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg className={`${styles.fileGlyph} ${styles.folderGlyph}`} viewBox="0 0 16 16" width={15} height={15} aria-hidden="true">
      {open
        ? <path d="M1.75 12.25v-8.5h4.3l1.5 1.9h5.2v1.6M1.75 12.25l1.6-5h11l-1.6 5z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
        : <path d="M1.75 3.75h4.3l1.5 1.9h6.7v6.6h-12.5z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />}
    </svg>
  );
}

// The end of a long path, which is the part that tells folders apart
function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

// A Markdown file as it reads. Memoised on its text: highlighting guesses each
// code block's language, which is too slow to redo whenever anything else on
// the page changes.
const PREVIEW_REMARK = [remarkGfm, remarkMath];
const PREVIEW_REHYPE = [rehypeKatex, [rehypeHighlight, { detect: true }]] as MarkdownOptions["rehypePlugins"];
const MarkdownPreview = memo(function MarkdownPreview({ root, path, content }: { root: string; path: string; content: string }) {
  const transform = useCallback((url: string, key: string) => (key === "src" ? workspaceMarkdownAssetUrl(root, path, url) : defaultUrlTransform(url)), [root, path]);
  return (
    <article className={styles.markdown}>
      <ReactMarkdown remarkPlugins={PREVIEW_REMARK} rehypePlugins={PREVIEW_REHYPE} urlTransform={transform}>{content}</ReactMarkdown>
    </article>
  );
});

function workspacePathDepth(path: string) {
  return Math.max(0, path.split("/").filter(Boolean).length - 1);
}

function parentWorkspacePaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function workspaceMarkdownAssetUrl(root: string, documentPath: string, url: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(url)) return defaultUrlTransform(url);
  const [rawPath, suffix = ""] = url.split(/(?=[?#])/u, 2);
  let decodedPath = rawPath;
  try { decodedPath = decodeURIComponent(rawPath); } catch {}
  const parts = url.startsWith("/") ? [] : documentPath.split("/").slice(0, -1);
  for (const part of decodedPath.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const params = new URLSearchParams({ root, path: parts.join("/"), raw: "1" });
  return `/api/workspaces/files?${params}${suffix}`;
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
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<ResearchWorkspace | null>(null);
  const [readerTabs] = useState<MaterialTab[]>(loadOpenTabs);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [draggedFilePath, setDraggedFilePath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [workspaceLayout0] = useState(() =>
    loadJson(WORKSPACE_LAYOUT_KEY, {
      projectWidth: 320, agentWidth: 420, projectOpen: true, agentOpen: true,
      papersOpen: true, filesOpen: true,
    })
  );
  // Both panels collapse to a rail, the same way the Reader's do: drag the
  // handle past the panel's minimum, or use the chevron in its header.
  const [projectOpen, setProjectOpen] = useState(workspaceLayout0.projectOpen ?? true);
  const [agentOpen, setAgentOpen] = useState(workspaceLayout0.agentOpen ?? true);
  // The two sections of the project tree fold away independently, so a long
  // file list doesn't push the papers off the top and vice versa.
  const [papersOpen, setPapersOpen] = useState(workspaceLayout0.papersOpen ?? true);
  const [filesOpen, setFilesOpen] = useState(workspaceLayout0.filesOpen ?? true);
  const [projectWidth, dragProject, startProject, endProject] = usePanelWidth(workspaceLayout0.projectWidth, 250, 560, 1, projectOpen, setProjectOpen);
  const [agentWidth, dragAgent, startAgent, endAgent] = usePanelWidth(workspaceLayout0.agentWidth, 320, 720, -1, agentOpen, setAgentOpen);
  // What is open belongs to the workspace, not to the app: a workspace is a
  // desk, and you expect to come back to the papers you left on it. Persisted
  // because switching surfaces unmounts this component entirely.
  const [openDocs, setOpenDocs] = useState<WorkspaceDocument[]>(
    () => docStore(activeWorkspaceId || "none").load()
  );
  // And the one being read when the workspace was left is open again
  const [activeDocId, setActiveDocId] = useState<string | null>(() => savedActiveDoc(activeWorkspaceId, openDocs));
  const activeDocRef = useRef(activeDocId);
  useEffect(() => { activeDocRef.current = activeDocId; }, [activeDocId]);
  const [pdfData, setPdfData] = useState("");
  const [pdfAttachmentKey, setPdfAttachmentKey] = useState<string | undefined>();
  const [pdfError, setPdfError] = useState("");
  const [marks, setMarks] = useState<PaperMarks>(NO_MARKS);
  const marksRef = useRef(marks);
  useEffect(() => { marksRef.current = marks; }, [marks]);
  const pdfViewerRef = useRef<PdfViewerHandle>(null);
  const agentRef = useRef<WorkspaceAgentHandle>(null);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");
  const { skills, activeSkillIds, toggleSkill, loading: skillsLoading } = useAgentSkills();
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces[0] || null;
  const activeDoc = openDocs.find((document) => document.id === activeDocId) || null;
  const docTabs = useMemo<MaterialTab[]>(
    () =>
      openDocs.map((doc) =>
        doc.kind === "paper"
          ? { ...doc.paper, id: doc.id, kind: "paper" as const }
          : {
              id: doc.id,
              name: doc.name,
              docType: "pdf" as const,
              kind: doc.kind === "workspacePdf" ? ("paper" as const) : ("file" as const),
            }
      ),
    [openDocs]
  );

  const persist = useCallback((next: ResearchWorkspace[]) => { setWorkspaces(next); saveWorkspaces(next); }, []);

  const { files, loading: filesLoading, refresh: refreshFiles } = useWorkspaceFiles(activeWorkspace?.root ?? null, setNotice);

  useEffect(() => {
    try { localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({ projectWidth, agentWidth, projectOpen, agentOpen, papersOpen, filesOpen })); } catch {}
  }, [projectWidth, agentWidth, projectOpen, agentOpen, papersOpen, filesOpen]);

  // The agent's conversation, draft, mode and model are its own (see
  // WorkspaceAgent): it is remounted for each workspace and loads them itself
  const switchWorkspace = (id: string) => {
    const docs = docStore(id).load();
    setActiveWorkspaceId(id);
    setOpenDocs(docs);
    setActiveDocId(savedActiveDoc(id, docs)); setPdfData(""); setPdfError(""); setMarks(NO_MARKS); setEditorContent(""); setSavedContent(""); setExpandedDirectories(new Set());
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(id)); } catch {}
  };

  const deleteWorkspace = async (workspace: ResearchWorkspace, deleteDirectory: boolean) => {
    if (deleteDirectory) {
      const response = await fetch("/api/workspaces", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: workspace.root, confirmRoot: workspace.root }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not move the workspace directory to Trash.");
    }

    const next = workspaces.filter((item) => item.id !== workspace.id);
    persist(next);
    // Its answer, if one is streaming, stops with it
    forgetChat(workspace.id);
    saveDraft(`workspace:${workspace.id}`, { text: "" });
    setDeleteWorkspaceTarget(null);
    if (workspace.id === activeWorkspace?.id) {
      if (next[0]) switchWorkspace(next[0].id);
      else {
        setActiveWorkspaceId(null); setOpenDocs([]); setActiveDocId(null); setPdfData(""); setEditorContent("");
        try { localStorage.removeItem(ACTIVE_WORKSPACE_KEY); } catch {}
        setCreateOpen(true);
      }
    }
    setNotice(deleteDirectory ? `Removed “${workspace.name}” and moved its folder to Trash.` : `Removed “${workspace.name}” from Paper Reader. Its folder was kept.`);
  };

  useEffect(() => {
    if (!activeWorkspaceId) return;
    docStore(activeWorkspaceId).save(openDocs);
  }, [openDocs, activeWorkspaceId]);

  useEffect(() => {
    // Never persist the null that every mount starts with — it would erase
    // the very id the restore below is about to read.
    if (!activeWorkspaceId || !activeDocId) return;
    try { localStorage.setItem(`${WORKSPACE_ACTIVE_DOC_KEY}:${activeWorkspaceId}`, JSON.stringify(activeDocId)); } catch {}
  }, [activeDocId, activeWorkspaceId]);

  // The Reader's marks on this paper — its session's highlights and the
  // passages it has conversations about, and Zotero's annotations — so the
  // page looks the same here as there
  const loadMarks = useCallback(async (paper: MaterialTab) => {
    const [session, notes] = await Promise.all([
      fetch(`/api/sessions?id=${encodeURIComponent(paper.id)}&lean=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      paper.zoteroKey ? fetch(`/api/zotero/notes?key=${encodeURIComponent(paper.zoteroKey)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
    ]);
    // The paper may have changed under the fetch
    if (activeDocRef.current !== `paper:${paper.id}`) return;
    const state = (session?.state ?? null) as { highlights?: Highlight[]; annotations?: Annotation[] } | null;
    setMarks({
      sessionId: paper.id,
      highlights: state?.highlights ?? [],
      zotero: ((notes?.annotations ?? []) as ZoteroAnnotation[]).filter((a) => a.text?.trim()),
      asked: (state?.annotations ?? [])
        .filter((a) => a.type === "text" && a.selectedText?.trim())
        .map((a): AskedPassage => ({ id: a.id, text: a.selectedText!, pageNumber: a.pageNumber, label: a.label, kind: "asked", occurrence: a.occurrence, position: a.position, positions: a.positions })),
    });
  }, []);

  // The open document's content, onto the stage: a PDF and the marks on it,
  // or a file's text — unless another document was opened in the meantime
  const loadDocument = useCallback((document: WorkspaceDocument) => {
    const current = () => activeDocRef.current === document.id;
    readDocument(document, activeWorkspace?.root).then(
      (content) => {
        if (!current()) return;
        if ("text" in content) { setEditorContent(content.text); setSavedContent(content.text); return; }
        setPdfData(content.pdf); setPdfAttachmentKey(content.attachmentKey);
        if (document.kind === "paper") void loadMarks(document.paper);
      },
      (reason) => {
        const message = reason instanceof Error ? reason.message : "";
        if (document.kind === "file") setNotice(message || "Could not open this file.");
        else if (current()) setPdfError(message || "Could not load this paper.");
      }
    );
  }, [activeWorkspace, loadMarks]);

  const openDocument = useCallback((document: WorkspaceDocument) => {
    setOpenDocs((current) => current.some((item) => item.id === document.id) ? current : [...current, document]);
    activeDocRef.current = document.id;
    setActiveDocId(document.id); setPreview(false); setNotice("");
    if (document.kind === "paper" || document.kind === "workspacePdf") { setPdfData(""); setPdfError(""); setMarks(NO_MARKS); }
    loadDocument(document);
  }, [loadDocument]);

  // Coming back to this surface, or to this workspace, the document last read
  // is the active one already (see activeDocId); its content is loaded once
  // per visit — not again when the last tab is closed, which would reopen it
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || restoredFor.current === activeWorkspaceId) return;
    restoredFor.current = activeWorkspaceId;
    const document = openDocs.find((entry) => entry.id === activeDocId);
    if (document) loadDocument(document);
  }, [activeWorkspaceId, activeDocId, openDocs, loadDocument]);

  const closeDocument = (id: string) => {
    const index = openDocs.findIndex((document) => document.id === id);
    const next = openDocs.filter((document) => document.id !== id);
    setOpenDocs(next);
    if (activeDocId === id) {
      const neighbour = next[Math.max(0, index - 1)] || next[0];
      if (neighbour) { void openDocument(neighbour); return; }
      setActiveDocId(null);
      setPdfData(""); setPdfError(""); setMarks(NO_MARKS); setEditorContent(""); setSavedContent("");
      try { localStorage.removeItem(`${WORKSPACE_ACTIVE_DOC_KEY}:${activeWorkspaceId}`); } catch {}
    }
  };

  const saveFile = async () => {
    if (!activeWorkspace || activeDoc?.kind !== "file") return;
    const response = await fetch("/api/workspaces/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: activeWorkspace.root, path: activeDoc.path, content: editorContent }) });
    const data = await response.json();
    if (!response.ok) { setNotice(data.error || "Could not save the file."); return; }
    setSavedContent(editorContent); setNotice(`Saved ${activeDoc.path}`); refreshFiles();
  };

  const createFile = async () => {
    if (!activeWorkspace) return;
    const suggested = `notes/untitled-${files.filter((file) => file.name.startsWith("untitled-")).length + 1}.md`;
    const relative = window.prompt("New file path inside this workspace", suggested)?.trim();
    if (!relative) return;
    const response = await fetch("/api/workspaces/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: activeWorkspace.root, path: relative, content: `# ${relative.split("/").pop()?.replace(/\.[^.]+$/, "") || "New note"}\n\n` }) });
    const data = await response.json();
    if (!response.ok) { setNotice(data.error || "Could not create the file."); return; }
    refreshFiles();
    setExpandedDirectories((current) => {
      const next = new Set(current);
      parentWorkspacePaths(relative).forEach((path) => next.add(path));
      return next;
    });
    void openDocument({ id: `file:${relative}`, kind: "file", path: relative, name: relative.split("/").pop() || relative, extension: relative.split(".").pop() || "" });
  };

  const createDirectory = async () => {
    if (!activeWorkspace) return;
    const relative = window.prompt("New folder path inside this workspace", "new-folder")?.trim().replace(/\/+$/, "");
    if (!relative) return;
    try {
      const response = await fetch("/api/workspaces/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: activeWorkspace.root, path: relative, kind: "directory" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create the folder.");
      setExpandedDirectories((current) => {
        const next = new Set(current);
        parentWorkspacePaths(relative).forEach((path) => next.add(path));
        next.add(relative);
        return next;
      });
      refreshFiles();
      setNotice(`Created folder ${relative}.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not create the folder.");
    }
  };

  const moveFile = async (from: string, toDirectory: string) => {
    if (!activeWorkspace) return;
    try {
      const response = await fetch("/api/workspaces/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: activeWorkspace.root, from, toDirectory }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not move the file.");
      const movedPath = String(data.path);
      const oldEntry = files.find((entry) => entry.path === from);
      const isPdf = oldEntry?.extension === "pdf";
      const oldId = `${isPdf ? "workspace-pdf" : "file"}:${from}`;
      const newId = `${isPdf ? "workspace-pdf" : "file"}:${movedPath}`;
      const name = movedPath.split("/").pop() || movedPath;
      setOpenDocs((current) => current.map((document) => {
        if ((document.kind === "file" || document.kind === "workspacePdf") && document.path === from) {
          return { ...document, id: newId, path: movedPath, name };
        }
        return document;
      }));
      setActiveDocId((current) => current === oldId ? newId : current);
      if (toDirectory) setExpandedDirectories((current) => new Set(current).add(toDirectory));
      refreshFiles();
      setNotice(`Moved ${name} ${toDirectory ? `into ${toDirectory}` : "to the workspace root"}.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not move the file.");
    } finally {
      setDraggedFilePath(null);
      setDropTarget(null);
    }
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

  // Highlights live in the paper's own session, where the Reader keeps
  // them, and in Zotero when the paper is there. A PDF from the workspace
  // folder is not a paper: its marks stay here for as long as it is open.
  // Zotero's own annotations are painted alongside, except those this app
  // wrote, whose local copy already carries colour and note.
  const allHighlights = useMemo<Highlight[]>(() => {
    const mirrored = new Set(marks.highlights.map((h) => h.zoteroKey).filter(Boolean));
    return [
      ...marks.highlights,
      ...marks.zotero
        .filter((a) => !mirrored.has(a.key))
        .map((a): Highlight => ({ id: `zotero-${a.key}`, text: a.text, pageNumber: a.page, position: a.position, note: a.comment || undefined, source: "zotero", color: a.color, createdAt: 0 })),
    ];
  }, [marks]);

  const persistHighlights = useCallback((sessionId: string, highlights: Highlight[]) => {
    const paper = activeDoc?.kind === "paper" ? activeDoc.paper : undefined;
    const seed = paper ? { pdfName: paper.name, zoteroKey: paper.zoteroKey, zoteroAttachmentKey: pdfAttachmentKey } : undefined;
    const failed = () => setNotice("The highlight shows here, but could not be saved for the Reader.");
    fetch("/api/sessions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: sessionId, highlights, seed }) })
      .then((response) => { if (!response.ok) failed(); })
      .catch(failed);
  }, [activeDoc, pdfAttachmentKey]);

  // One way to change the paper's highlights: the ref keeps two changes in
  // one tick consistent, and every change reaches the session
  const updateHighlights = useCallback((update: (current: Highlight[]) => Highlight[]) => {
    const next = update(marksRef.current.highlights);
    marksRef.current = { ...marksRef.current, highlights: next };
    setMarks((current) => ({ ...current, highlights: next }));
    if (marksRef.current.sessionId) persistHighlights(marksRef.current.sessionId, next);
  }, [persistHighlights]);

  const patchZoteroAnnotation = (key: string, patch: { color?: string; comment?: string }) => {
    fetch("/api/zotero/annotations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, ...patch }) }).catch(() => {});
  };
  const deleteZoteroAnnotation = (key: string) => {
    fetch(`/api/zotero/annotations?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
  };

  const makeHighlight = async (text: string, pageNumber?: number, position?: PdfRects, color = DEFAULT_HIGHLIGHT_COLOR, note?: string, occurrence = 0, segments?: SelectionSegment[]) => {
    // A selection across pages becomes one highlight per page, as in the
    // Reader; the note goes on the first
    const shares = segments && segments.length > 1
      ? segments.map((s, index) => ({ text: s.text, note: index === 0 ? note : undefined, pageNumber: s.pageIndex + 1, position: { pageIndex: s.pageIndex, rects: s.rects }, occurrence: 0 }))
      : [{ text, note, pageNumber, position, occurrence }];
    for (const share of shares) {
      const id = uid();
      updateHighlights((current) => [...current, { id, text: share.text, pageNumber: share.pageNumber, position: share.position, color, note: share.note, occurrence: share.occurrence, createdAt: Date.now() }]);
      if (!pdfAttachmentKey || !share.position) continue;
      try {
        const created = await createZoteroHighlight(pdfAttachmentKey, { text: share.text, pageIndex: share.position.pageIndex, rects: share.position.rects }, { color, comment: share.note });
        updateHighlights((current) => current.map((h) => (h.id === id ? { ...h, zoteroKey: created.key } : h)));
      } catch { setNotice("The highlight is visible here, but could not sync to Zotero."); }
    }
  };

  // Highlights read from Zotero carry a "zotero-<key>" id; ones made here a
  // plain id plus, once the write lands, the key of their Zotero copy
  const removeHighlight = (id: string) => {
    if (id.startsWith("zotero-")) {
      const key = id.slice(7);
      setMarks((current) => ({ ...current, zotero: current.zotero.filter((a) => a.key !== key) }));
      deleteZoteroAnnotation(key);
      return;
    }
    const item = marksRef.current.highlights.find((h) => h.id === id);
    updateHighlights((current) => current.filter((h) => h.id !== id));
    if (item?.zoteroKey) deleteZoteroAnnotation(item.zoteroKey);
  };

  const recolorHighlight = (id: string, color: string) => {
    if (id.startsWith("zotero-")) {
      const key = id.slice(7);
      setMarks((current) => ({ ...current, zotero: current.zotero.map((a) => (a.key === key ? { ...a, color } : a)) }));
      patchZoteroAnnotation(key, { color });
      return;
    }
    const item = marksRef.current.highlights.find((h) => h.id === id);
    updateHighlights((current) => current.map((h) => (h.id === id ? { ...h, color } : h)));
    if (item?.zoteroKey) patchZoteroAnnotation(item.zoteroKey, { color });
  };

  // An empty note clears it, as in Zotero
  const editHighlightNote = (id: string, note: string) => {
    if (id.startsWith("zotero-")) {
      const key = id.slice(7);
      setMarks((current) => ({ ...current, zotero: current.zotero.map((a) => (a.key === key ? { ...a, comment: note } : a)) }));
      patchZoteroAnnotation(key, { comment: note });
      return;
    }
    const item = marksRef.current.highlights.find((h) => h.id === id);
    updateHighlights((current) => current.map((h) => (h.id === id ? { ...h, note: note || undefined } : h)));
    if (item?.zoteroKey) patchZoteroAnnotation(item.zoteroKey, { comment: note });
  };

  // A passage held for the next question, as the Reader's Quote does; the
  // composer is the agent's, which opens to show it
  const quoteIntoComposer = (text: string, page?: number, remark?: string) => {
    setAgentOpen(true);
    agentRef.current?.quote(text, page, remark);
  };
  // A passage the Reader has a conversation about: quoted, with a word that
  // there is one — the agent can read it from the paper's folder
  const quoteAskedPassage = (id: string) => {
    const passage = marks.asked.find((p) => p.id === id);
    if (passage) quoteIntoComposer(passage.text, passage.pageNumber, "(I have a conversation about this passage in the Reader.)");
  };
  // Asked from the page, as the Reader asks: a passage to explain or define,
  // a question about it, a captured figure. The answer is wanted in sight.
  const askFromPage = (ask: AgentAsk) => {
    setAgentOpen(true);
    agentRef.current?.ask(ask);
  };

  // What the agent is handed, and the handlers it calls back: stable, so the
  // agent panel re-renders for its own changes and not for every one here
  const desk = useRef<{ doc: WorkspaceDocument | null; content: string; pdf: boolean }>({ doc: null, content: "", pdf: false });
  useEffect(() => {
    desk.current = { doc: activeDoc, content: editorContent, pdf: !!pdfData };
  });
  const getContext = useCallback(() => {
    const { doc, content } = desk.current;
    return doc?.kind === "file" ? `Open file: ${doc.path}\n\n${content}`
      : doc?.kind === "paper" ? `Open paper: ${doc.paper.name}\nZotero key: ${doc.paper.zoteroKey || "local reader paper"}`
      : doc?.kind === "workspacePdf" ? `Open workspace PDF: ${doc.path}`
      : "No document is open.";
  }, []);
  // A citation in an answer goes to the passage in the open paper, as in the Reader
  const followCitation = useCallback((page: number, quote: string) => {
    if (!desk.current.pdf) { setNotice("Open the paper to follow this citation."); return; }
    void pdfViewerRef.current?.highlightText(page, quote);
  }, []);
  const collapseAgent = useCallback(() => setAgentOpen(false), []);
  const openSkills = useCallback(() => setSkillsOpen(true), []);
  const exported = useCallback(({ path, inside }: { path: string; inside: boolean }) => {
    // Opening the file clears the notice, so the notice comes after
    if (inside) { refreshFiles(); void openDocument({ id: `file:${path}`, kind: "file", path, name: path.split("/").pop() || path, extension: "md" }); }
    setNotice(`Exported the conversation to ${path}`);
  }, [refreshFiles, openDocument]);
  const documentLabel = activeDoc ? (activeDoc.kind === "paper" ? activeDoc.paper.name : activeDoc.path) : null;

  const fileRows = useMemo(() => files.filter((file) => file.kind === "file"), [files]);
  const visibleWorkspaceEntries = useMemo(() => files.filter((entry) => parentWorkspacePaths(entry.path).every((path) => expandedDirectories.has(path))), [files, expandedDirectories]);
  const toggleDirectory = (path: string) => setExpandedDirectories((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  if (!isClient) return <div className={styles.app} />;

  return (
    <div className={styles.app}>
      <header className="pr-app-bar">
        <div className="pr-brand"><span>P</span><strong>Paper Reader</strong></div>
        <nav className="pr-surface-switch" aria-label="Application surface"><Link href="/">Reader</Link><Link href="/workspace" className="active" aria-current="page">Workspace</Link></nav>
        <div className="pr-reader-actions"><button className="pr-capability-button" onClick={() => setSkillsOpen(true)} title="Choose agent skills"><i aria-hidden>◆</i><span>Skills</span>{activeSkillIds.length > 0 && <small>{activeSkillIds.length}</small>}</button>{activeWorkspace && <span className={styles.workspaceName}><i />{activeWorkspace.name}</span>}</div>
      </header>

      <main className={styles.shell}>
        <nav className={styles.rail} aria-label="Research workspaces">
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspace?.id;
            return (
              <button key={workspace.id} type="button" className={active ? styles.active : ""} onClick={() => switchWorkspace(workspace.id)} aria-label={workspace.name} aria-current={active ? "true" : undefined}>
                <b>{initials(workspace.name)}</b><span aria-hidden="true">{workspace.name}</span>
              </button>
            );
          })}
          <div className={styles.railActions}>
            <button type="button" className={styles.newWorkspaceButton} onClick={() => setCreateOpen(true)} aria-label="New workspace">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 7.5h6l2-2h9v13h-17z" /><path d="M12 10v6M9 13h6" /></svg><span aria-hidden="true">New workspace</span>
            </button>
            <button type="button" className={styles.removeWorkspaceButton} disabled={!activeWorkspace} onClick={() => activeWorkspace && setDeleteWorkspaceTarget(activeWorkspace)} aria-label="Remove current workspace">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5.5 7.5h13M9 7.5v-2h6v2M7.5 7.5l1 11h7l1-11M10.5 10.5v5M13.5 10.5v5" /></svg><span aria-hidden="true">Remove current workspace</span>
            </button>
          </div>
        </nav>

        {!projectOpen && <CollapsedRail label="Workspace" side="left" onExpand={() => setProjectOpen(true)} title="Show the workspace panel" />}
        {projectOpen && (
        <aside className={styles.projectSidebar} style={{ width: projectWidth }}>
          <header>
            <div>
              <strong title={activeWorkspace?.name}>{activeWorkspace?.name ?? "No workspace"}</strong>
              <small title={activeWorkspace?.root}>{activeWorkspace ? shortPath(activeWorkspace.root) : "Create one to begin"}</small>
            </div>
            <button className={styles.collapsePanel} onClick={() => setProjectOpen(false)} title="Hide the workspace panel" aria-label="Hide the workspace panel">‹</button>
          </header>
          <div className={styles.tree}>
            <section>
              <h3><button type="button" className={styles.sectionChevron} onClick={() => setPapersOpen((open) => !open)} aria-expanded={papersOpen} title={papersOpen ? "Collapse source papers" : "Expand source papers"}>{papersOpen ? "⌄" : "›"}</button><strong className={styles.sectionTitle} onClick={() => setPapersOpen((open) => !open)}>SOURCE PAPERS <small>{activeWorkspace?.papers.length || 0}</small></strong><span className={styles.headerActions}>
                <button onClick={() => setCopyOpen(true)} disabled={!activeWorkspace?.papers.length} title="Copy PDFs into the workspace folder…" aria-label="Copy PDFs into the workspace folder"><svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true"><path d="M8 2.5v7.5M5 7.2 8 10.2l3-3M3 11.5v2h10v-2" /></svg></button>
                <button onClick={() => setPaperPickerOpen(true)} disabled={!activeWorkspace} title="Add papers from Zotero" aria-label="Add papers from Zotero"><svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
              </span></h3>
              {papersOpen && activeWorkspace?.papers.map((paper) => {
                const documentId = `paper:${paper.id}`;
                return <div key={paper.id} className={`${styles.paperRow} ${activeDocId === documentId ? styles.activeRow : ""}`}>
                  <button className={styles.paperOpen} onClick={() => void openDocument({ id: documentId, kind: "paper", paper })} title={`${paper.name} — ${paper.zoteroKey ? "linked from Zotero" : "linked from the Reader"} · zero copy`}>
                    <FileGlyph extension="pdf" /><strong>{paper.name.replace(/\.pdf$/i, "")}</strong>
                  </button>
                  <button className={styles.detachPaper} onClick={() => detachPaper(paper)} title="Detach from workspace" aria-label={`Detach ${paper.name.replace(/\.pdf$/i, "")} from this workspace`}>×</button>
                </div>;
              })}
              {papersOpen && activeWorkspace && !activeWorkspace.papers.length && (
                <div className={styles.treeEmpty}>
                  <p>Link papers from Zotero or the Reader — nothing is copied.</p>
                  <button type="button" onClick={() => setPaperPickerOpen(true)}>＋ Add papers</button>
                </div>
              )}
            </section>
            <section>
              <h3
                className={`${styles.filesHeading} ${dropTarget === "" ? styles.rootDropTarget : ""}`}
                onDragOver={(event) => { if (draggedFilePath) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(""); } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null); }}
                onDrop={(event) => { event.preventDefault(); if (draggedFilePath) void moveFile(draggedFilePath, ""); }}
              ><button type="button" className={styles.sectionChevron} onClick={() => setFilesOpen((open) => !open)} aria-expanded={filesOpen} title={filesOpen ? "Collapse working files" : "Expand working files"}>{filesOpen ? "⌄" : "›"}</button><strong className={styles.sectionTitle} onClick={() => setFilesOpen((open) => !open)}>WORKING FILES <small>{fileRows.length}</small></strong><span className={styles.headerActions}>
                <button onClick={createFile} disabled={!activeWorkspace} title="New file" aria-label="New file"><svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true"><path d="M4 1.75h5.2l2.8 2.8v9.7H4z" /><path d="M9.2 1.75v2.8H12" /><path d="M6.2 9h3.6M8 7.2v3.6" /></svg></button>
                <button onClick={createDirectory} disabled={!activeWorkspace} title="New folder" aria-label="New folder"><svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true"><path d="M1.75 3.75h4.3l1.5 1.9h6.7v6.6h-12.5z" /><path d="M6.2 8.7h3.6M8 6.9v3.6" /></svg></button>
                <button onClick={refreshFiles} disabled={!activeWorkspace || filesLoading} title="Refresh" aria-label="Refresh working files"><svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.9h-2.9" /></svg></button>
              </span></h3>
              {filesOpen && filesLoading && !files.length && <p className={styles.treeNote}>Reading the folder…</p>}
              {filesOpen && !filesLoading && activeWorkspace && !files.length && (
                <div className={styles.treeEmpty}>
                  <p>The folder is empty. Start a note, or copy linked PDFs in.</p>
                  <button type="button" onClick={createFile}>＋ New note</button>
                </div>
              )}
              {filesOpen && <div className={styles.fileExplorer} role="tree" aria-label="Workspace files">
                {visibleWorkspaceEntries.map((entry) => {
                  const depth = workspacePathDepth(entry.path);
                  const style = { "--tree-depth": depth } as CSSProperties;
                  if (entry.kind === "directory") {
                    const expanded = expandedDirectories.has(entry.path);
                    return <button
                      key={entry.path}
                      className={`${styles.explorerRow} ${styles.directoryRow} ${dropTarget === entry.path ? styles.directoryDropTarget : ""}`}
                      style={style}
                      onClick={() => toggleDirectory(entry.path)}
                      onDragOver={(event) => { if (draggedFilePath) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(entry.path); } }}
                      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null); }}
                      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (draggedFilePath) void moveFile(draggedFilePath, entry.path); }}
                      role="treeitem"
                      aria-expanded={expanded}
                      aria-selected={false}
                      title={`${entry.path} · drop a file here to move it`}
                    >
                      <span className={styles.indentGuides} aria-hidden="true">{Array.from({ length: depth }, (_, index) => <i key={index} />)}</span>
                      <span className={styles.explorerChevron} aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                      <FolderGlyph open={expanded} />
                      <strong>{entry.name}</strong>
                    </button>;
                  }
                  const pdf = entry.extension === "pdf";
                  const id = `${pdf ? "workspace-pdf" : "file"}:${entry.path}`;
                  return <button
                    key={entry.path}
                    className={`${styles.explorerRow} ${activeDocId === id ? styles.activeExplorerRow : ""} ${draggedFilePath === entry.path ? styles.draggingFile : ""}`}
                    style={style}
                    onClick={() => void openDocument(pdf ? { id, kind: "workspacePdf", path: entry.path, name: entry.name } : { id, kind: "file", path: entry.path, name: entry.name, extension: entry.extension || "" })}
                    draggable
                    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", entry.path); setDraggedFilePath(entry.path); }}
                    onDragEnd={() => { setDraggedFilePath(null); setDropTarget(null); }}
                    role="treeitem"
                    aria-selected={activeDocId === id}
                    title={`${entry.path} · drag to move`}
                  >
                    <span className={styles.indentGuides} aria-hidden="true">{Array.from({ length: depth }, (_, index) => <i key={index} />)}</span>
                    <span className={styles.explorerChevron} aria-hidden="true" />
                    <FileGlyph extension={entry.extension} />
                    <strong>{entry.name}</strong>
                  </button>;
                })}
              </div>}
            </section>
          </div>
        </aside>

        )}
        <ResizeHandle onDrag={dragProject} onStart={startProject} onEnd={endProject} />

        <section className={styles.documentPanel}>
          {/* The Reader's tab bar, not a copy of it — one component, so the
              two surfaces cannot drift apart in style or behaviour. */}
          <MaterialTabs
            tabs={docTabs}
            activeId={activeDocId}
            loadingId={null}
            onSelect={(id) => { const doc = openDocs.find((entry) => entry.id === id); if (doc) void openDocument(doc); }}
            onClose={closeDocument}
            onReorder={(ordered) => setOpenDocs(ordered.map((tab) => openDocs.find((doc) => doc.id === tab.id)!).filter(Boolean))}
            rememberAs="workspace"
          />
          {!activeDoc && (
            <div className={styles.emptyDocument}>
              <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.5 5.5c2.6-1.2 5.1-1.2 7.5 0v13c-2.4-1.2-4.9-1.2-7.5 0zM12 5.5c2.4-1.2 4.9-1.2 7.5 0v13c-2.6-1.2-5.1-1.2-7.5 0" /></svg></span>
              <h2>Open a paper or a workspace file</h2>
              <p>Read papers, edit project files, and work with the agent without leaving this workspace.</p>
              {activeWorkspace && (
                <div className={styles.emptyActions}>
                  <button type="button" className={styles.primaryAction} onClick={() => setPaperPickerOpen(true)}>Add papers</button>
                  <button type="button" className={styles.secondaryAction} onClick={createFile}>New note</button>
                </div>
              )}
            </div>
          )}
          {(activeDoc?.kind === "paper" || activeDoc?.kind === "workspacePdf") && <div className={styles.pdfStage}>{pdfError ? <div className={styles.emptyDocument}><h2>Paper unavailable</h2><p>{pdfError}</p></div> : pdfData ? <PdfViewer
                ref={pdfViewerRef}
                pdfDataUrl={pdfData}
                onTextSelected={(text, page, _occurrence, _position, intent) => askFromPage({ kind: intent ?? "explain", selectedText: text, pageNumber: page })}
                onAskAboutSelection={(text, prompt, page) => askFromPage({ kind: "question", question: prompt, selectedText: text, pageNumber: page })}
                onQuoteSelection={(text, page) => quoteIntoComposer(text, page)}
                onRegionCaptured={(result) => askFromPage({ kind: "figure", imageDataUrl: result.imageDataUrl })}
                onHighlight={(text, page, position, color, occurrence, segments) => void makeHighlight(text, page, position, color, undefined, occurrence, segments)}
                onNote={(text, note, page, position, color, occurrence, segments) => void makeHighlight(text, page, position, color, note, occurrence, segments)}
                onRemoveHighlight={removeHighlight}
                onRecolorHighlight={recolorHighlight}
                onEditHighlightNote={editHighlightNote}
                highlights={allHighlights}
                askedPassages={marks.asked}
                onAskedClick={quoteAskedPassage}
                zoteroKey={activeDoc.kind === "paper" ? activeDoc.paper.zoteroKey : undefined}
                // Its own place in the paper, apart from the Reader's: the two
                // surfaces read the same paper for different ends
                positionKey={`workspace:${activeDoc.kind === "paper" ? activeDoc.paper.id : activeDoc.path}`}
              /> : <div className={styles.emptyDocument}><p>Loading PDF…</p></div>}</div>}
          {activeDoc?.kind === "file" && <><header className={styles.editorToolbar}><div><strong>{activeDoc.path}</strong><small>{activeDoc.extension === "md" ? "Markdown" : "Text"} · editable workspace file</small></div>{activeDoc.extension === "md" && <span role="group" aria-label="View"><button className={!preview ? styles.selected : ""} aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button><button className={preview ? styles.selected : ""} aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></span>}<p><small className={editorContent === savedContent ? "" : styles.unsaved}>{editorContent === savedContent ? "Saved" : "Unsaved"}</small><button onClick={() => void saveFile()} disabled={editorContent === savedContent} title="Save (⌘S)">Save</button></p></header><div className={styles.editorStage}>{preview && activeDoc.extension === "md" && activeWorkspace ? <MarkdownPreview root={activeWorkspace.root} path={activeDoc.path} content={editorContent} /> : <textarea value={editorContent} onChange={(event) => setEditorContent(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveFile(); } }} spellCheck={false} aria-label={`Edit ${activeDoc.path}`} />}</div></>}
        </section>

        <ResizeHandle onDrag={dragAgent} onStart={startAgent} onEnd={endAgent} />

        {/* Mounted while collapsed too: an ask from the page, or an answer
            still streaming, goes on without the panel drawn */}
        <WorkspaceAgent
          key={activeWorkspace?.id ?? "none"}
          ref={agentRef}
          workspace={activeWorkspace}
          open={agentOpen}
          width={agentWidth}
          onCollapse={collapseAgent}
          documentLabel={documentLabel}
          getContext={getContext}
          activeSkillIds={activeSkillIds}
          onOpenSkills={openSkills}
          onCitePaper={followCitation}
          onFilesChanged={refreshFiles}
          onNotice={setNotice}
          onExported={exported}
        />
        {!agentOpen && <CollapsedRail label="Agent" side="right" onExpand={() => setAgentOpen(true)} title="Show the workspace agent" />}
      </main>

      {notice && <div className={styles.toast}>{notice}<button onClick={() => setNotice("")}>×</button></div>}
      <SkillsDrawer open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={skills} activeIds={activeSkillIds} onToggle={toggleSkill} loading={skillsLoading} />
      <CreateWorkspaceDialog open={createOpen} onClose={() => { if (workspaces.length) setCreateOpen(false); else router.replace("/"); }} onCreated={(workspace) => { const next = [...workspaces, workspace]; persist(next); switchWorkspace(workspace.id); setCreateOpen(false); }} />
      {deleteWorkspaceTarget && <DeleteWorkspaceDialog workspace={deleteWorkspaceTarget} onClose={() => setDeleteWorkspaceTarget(null)} onDelete={(deleteDirectory) => deleteWorkspace(deleteWorkspaceTarget, deleteDirectory)} />}
      {activeWorkspace && <PaperPicker open={paperPickerOpen} papers={readerTabs} existing={activeWorkspace.papers} onClose={() => setPaperPickerOpen(false)} onAdd={addPapers} />}
      {activeWorkspace && <CopyPapersDialog open={copyOpen} workspace={activeWorkspace} onClose={() => setCopyOpen(false)} onCopied={() => { setNotice("Selected PDFs copied into this workspace."); refreshFiles(); }} />}
    </div>
  );
}
