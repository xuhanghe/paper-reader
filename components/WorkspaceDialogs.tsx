"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileIcon, FolderIcon } from "@/components/FileIcon";
import type { MaterialTab } from "@/components/MaterialTabs";
import { defaultExportPath } from "@/lib/conversation-export";
import { loadPaperData, safePdfName } from "@/lib/paper-data";
import { uid } from "@/lib/uid";
import type { AgentMessage } from "@/lib/workspace-chat";
import { flattenZoteroCollections, zoteroCollectionBranch, zoteroPaperTab, type ZoteroCollection, type ZoteroPaper } from "@/lib/workspace-zotero";
import type { Model } from "@/types/session";
import type { ResearchWorkspace } from "@/types/workspace";
import styles from "./workspace-dialogs.module.css";

// The Workspace's dialogs: making and removing a workspace, attaching papers,
// copying them into the folder, and exporting the agent conversation.

// Escape closes a dialog, as the Reader's do — but not while it is doing what
// it was opened for (creating, removing, exporting, copying): closing then
// would hide how that ends.
function useEscapeToClose(active: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => { latest.current = close; });
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      // The Escape that ends an input method's composition is the input method's
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      latest.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
}

export function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: ResearchWorkspace) => void }) {
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  useEscapeToClose(open && !creating, onClose);

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
        <div className={styles.lockNote}><span><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" /></svg></span><p><strong>This directory is fixed after creation.</strong><small>Create another workspace if you later need a different project root.</small></p></div>
        <p className={styles.zeroPaperNote}>The directory is attached in place. The workspace starts with 0 linked papers; add them any time with <strong>Add papers</strong>.</p>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={onClose}>Cancel</button><button className={styles.primary} onClick={submit} disabled={creating}>{creating ? "Creating…" : "Create workspace"}</button></footer>
      </section>
    </div>
  );
}

export function DeleteWorkspaceDialog({ workspace, onClose, onDelete }: { workspace: ResearchWorkspace; onClose: () => void; onDelete: (deleteDirectory: boolean) => Promise<void> }) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState<"record" | "directory" | null>(null);
  const [error, setError] = useState("");
  useEscapeToClose(!deleting, onClose);
  const remove = async (deleteDirectory: boolean) => {
    setDeleting(deleteDirectory ? "directory" : "record"); setError("");
    try { await onDelete(deleteDirectory); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove this workspace."); setDeleting(null); }
  };
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={`${styles.modal} ${styles.deleteWorkspaceModal}`} role="dialog" aria-modal="true" aria-labelledby="delete-workspace-title">
        <header><div><small>REMOVE WORKSPACE</small><h2 id="delete-workspace-title">What should happen to its folder?</h2></div><button onClick={onClose} disabled={!!deleting} aria-label="Close">×</button></header>
        <div className={styles.deleteChoices}>
          <article>
            <span>01</span><div><h3>Remove from Paper Reader only</h3><p>The workspace, paper links, and conversation disappear from this app. The directory and every file inside it stay untouched.</p></div>
            <button onClick={() => void remove(false)} disabled={!!deleting}>{deleting === "record" ? "Removing…" : "Keep folder and remove workspace"}</button>
          </article>
          <article className={styles.deleteDirectoryChoice}>
            <span>02</span><div><h3>Remove workspace and folder</h3><p>The workspace is removed from Paper Reader and its directory is moved to macOS Trash, where it can still be recovered.</p><code title={workspace.root}>{workspace.root}</code></div>
            <label><small>TYPE <strong>{workspace.name}</strong> TO CONFIRM</small><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <button onClick={() => void remove(true)} disabled={!!deleting || confirmation !== workspace.name}>{deleting === "directory" ? "Moving to Trash…" : "Move folder to Trash"}</button>
          </article>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={onClose} disabled={!!deleting}>Cancel</button></footer>
      </section>
    </div>
  );
}

type PaperChoice = { tab: MaterialTab; detail: string };

export function PaperPicker({ open, papers, existing, onClose, onAdd }: { open: boolean; papers: MaterialTab[]; existing: MaterialTab[]; onClose: () => void; onAdd: (papers: MaterialTab[]) => void }) {
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
  useEscapeToClose(open, close);
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
    <div className={styles.modalBackdrop} role="presentation">
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
          {choices.slice(0, visibleCount).map((choice) => <label key={choice.tab.id}><input type="checkbox" checked={!!selected[choice.tab.id]} onChange={() => toggle(choice)} /><span className={styles.kindPdf}><FileIcon kind="pdf" size={22} /></span><p><strong>{choice.tab.name.replace(/\.pdf$/i, "")}</strong><small>{choice.detail}</small></p></label>)}
          {choices.length > visibleCount && <button className={styles.loadMore} onClick={() => setVisibleCount((count) => count + 100)}>Show 100 more <small>{choices.length - visibleCount} remaining</small></button>}
        </div>
        {error && choices.length > 0 && <p className={styles.error}>{error}</p>}
        <footer><button onClick={close}>Cancel</button><button className={styles.primary} disabled={!selectedCount} onClick={() => { const tabs = Object.values(selected); setSelected({}); onAdd(tabs); }}>Attach {selectedCount || ""} paper{selectedCount === 1 ? "" : "s"}</button></footer>
      </section>
    </div>
  );
}

// The conversation written out as Markdown, to carry to another agent or
// machine: a note to whoever reads it next, and a choice of where it goes
export function ExportDialog({ open, workspace, messages, model, onClose, onExported }: {
  open: boolean;
  workspace: ResearchWorkspace;
  messages: AgentMessage[];
  model: Model;
  onClose: () => void;
  onExported: (result: { path: string; inside: boolean }) => void;
}) {
  const [notes, setNotes] = useState("");
  const [target, setTarget] = useState(() => defaultExportPath(new Date()));
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = () => { setError(""); onClose(); };
  useEscapeToClose(open && !saving, close);
  if (!open) return null;
  const choose = async () => {
    setChoosing(true); setError("");
    try {
      const response = await fetch("/api/workspaces/select-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultName: target.split("/").pop(), location: workspace.root }) });
      if (response.status === 499) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the save dialog.");
      if (data.path) setTarget(String(data.path));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open the save dialog."); }
    finally { setChoosing(false); }
  };
  const save = async () => {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/workspaces/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        root: workspace.root, name: workspace.name, path: target, notes, model,
        papers: workspace.papers.map((paper) => ({ id: paper.id, name: paper.name, zoteroKey: paper.zoteroKey })),
        messages: messages.map((message) => ({ role: message.role, content: message.content, tools: message.tools, hasImage: !!message.imageDataUrl })),
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not export the conversation.");
      onExported({ path: String(data.path), inside: !!data.inside });
      setNotes(""); setTarget(defaultExportPath(new Date()));
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not export the conversation."); }
    finally { setSaving(false); }
  };
  const turns = messages.filter((message) => message.role === "user").length;
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="export-conversation-title">
        <header><div><small>EXPORT CONVERSATION</small><h2 id="export-conversation-title">Carry this conversation elsewhere</h2></div><button onClick={close} aria-label="Close">×</button></header>
        <p className={styles.zeroPaperNote}>{turns} {turns === 1 ? "turn" : "turns"} with the agent, the papers attached, and your notes below go into one Markdown file for another agent or machine to pick up.</p>
        <label><span>NOTES FOR WHOEVER READS IT NEXT</span><textarea autoFocus value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What to know first, what is still open, what to do with it…" rows={5} data-export-notes="" /></label>
        <label><span>SAVE AS</span><div className={styles.pathInput}><input value={target} onChange={(event) => setTarget(event.target.value)} spellCheck={false} data-export-path="" /><button type="button" onClick={choose} disabled={choosing}>{choosing ? "Opening…" : "Choose…"}</button></div></label>
        <p className={styles.nativePickerNote}>A relative path goes inside this workspace; Choose… opens the macOS save dialog for anywhere else.</p>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={close} disabled={saving}>Cancel</button><button className={styles.primary} onClick={save} disabled={saving || !target.trim()}>{saving ? "Exporting…" : "Export"}</button></footer>
      </section>
    </div>
  );
}

export function CopyPapersDialog({ open, workspace, onClose, onCopied }: { open: boolean; workspace: ResearchWorkspace; onClose: () => void; onCopied: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const close = () => { setSelected([]); setError(""); onClose(); };
  useEscapeToClose(open && !copying, close);
  if (!open) return null;
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
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="copy-papers-title">
        <header><div><small>EXPLICIT FILE COPY</small><h2 id="copy-papers-title">Choose PDFs to copy</h2></div><button onClick={close} aria-label="Close">×</button></header>
        <div className={styles.destination}><span><FolderIcon size={20} /></span><p><strong>Destination</strong><code>{workspace.root}/papers</code></p></div>
        <div className={styles.paperPicker}>{workspace.papers.map((paper) => <label key={paper.id}><input type="checkbox" checked={selected.includes(paper.id)} onChange={() => setSelected((current) => current.includes(paper.id) ? current.filter((id) => id !== paper.id) : [...current, paper.id])} /><span className={styles.kindPdf}><FileIcon kind="pdf" size={22} /></span><p><strong>{paper.name.replace(/\.pdf$/i, "")}</strong><small>Linked source remains unchanged</small></p></label>)}</div>
        {error && <p className={styles.error}>{error}</p>}
        <footer><button onClick={close}>Cancel</button><button className={styles.primary} onClick={copy} disabled={!selected.length || copying}>{copying ? "Copying…" : `Copy ${selected.length || "selected"} PDF${selected.length === 1 ? "" : "s"}`}</button></footer>
      </section>
    </div>
  );
}
