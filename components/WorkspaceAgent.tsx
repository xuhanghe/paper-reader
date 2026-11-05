"use client";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentPicker } from "./AgentPicker";
import { MentionTextarea } from "./MentionTextarea";
import { CitationAnchor, MarkdownAnswer, type CiteHandlers, type MarkdownComponents } from "./MarkdownAnswer";
import { ExportDialog } from "./WorkspaceDialogs";
import { loadModelCatalog } from "@/hooks/useModelCatalog";
import { parseAgentEvent } from "@/lib/agent-events";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { extractZoteroItemText } from "@/lib/extract-text";
import { MAX_ATTACHED_IMAGES } from "@/lib/message-images";
import { deleteMention, insertMention, liveMentions, MENTION_HREF, mentionQuery, mentionRanges, mentionTitle, typedMentionStart, withMentionLinks } from "@/lib/mentions";
import { isSubmitKey } from "@/lib/keys";
import { migrateLegacyCustomApi } from "@/lib/legacy-custom-api";
import { providerIdFor } from "@/lib/model-spec";
import { readLines } from "@/lib/ndjson";
import type { SelectionIntent } from "@/lib/prompts";
import { uid } from "@/lib/uid";
import { beginRun, chatSnapshot, endRun, loadAgentChoice, loadAgentMode, saveAgentChoice, saveAgentMode, stopRun, subscribeChat, updateRun, type AgentChoice, type AgentMessage, type AgentTool, type PaperReference } from "@/lib/workspace-chat";
import type { AgentMode } from "@/lib/workspace-modes";
import type { ResearchWorkspace } from "@/types/workspace";
import styles from "./workspace-agent.module.css";

// The Workspace's agent: one conversation per workspace, with whichever agent
// and model the workspace was last asked with.
//
// Its own component, apart from the shell, so that an answer streaming in —
// or a question being typed — re-renders this panel and nothing else: not the
// file tree, the tabs or the open PDF.

// A question for the agent: typed, or asked straight from the page the way
// the Reader asks — a passage to explain or define, a question about one, a
// captured figure
export type AgentAsk = { question?: string; kind?: SelectionIntent | "question" | "figure"; selectedText?: string; pageNumber?: number; imageDataUrl?: string };

export type WorkspaceAgentHandle = {
  ask: (ask: AgentAsk) => void;
  // A passage held for the next question, as the Reader's Quote does
  quote: (text: string, page?: number, remark?: string) => void;
  // A message of the conversation, centred and pulsed — where a search
  // result lands. False when it is not in this conversation.
  revealMessage: (id: string) => boolean;
};

type Props = {
  workspace: ResearchWorkspace | null;
  // Collapsed to its rail: the conversation goes on, the panel is not drawn
  open: boolean;
  width: number;
  onCollapse: () => void;
  // What is open on the desk, as the header names it
  documentLabel: string | null;
  // And as the agent is told about it, read when a question is sent
  getContext: () => string;
  activeSkillIds: string[];
  onOpenSkills: () => void;
  // A citation in an answer: the passage it names in the open paper
  onCitePaper: (page: number, quote: string) => void;
  // The agent may have written files
  onFilesChanged: () => void;
  onNotice: (text: string) => void;
  onExported: (result: { path: string; inside: boolean }) => void;
};

const MODES: [AgentMode, string, string][] = [
  ["discussion", "Discussion", "Think it through together: the conversation is the point; files are read, and at most noted in"],
  ["auto", "Auto", "Implement: the agent reads, edits and runs what it needs inside the workspace, as Claude Code's auto mode does"],
];
const SUGGESTIONS: [string, string, string][] = [
  ["Evaluate an idea", "Novel, feasible, worth a small experiment?", "Evaluate whether this idea is novel, feasible, and worth a small experiment."],
  ["Check latest related work", "And the strongest novelty risk", "Search for the latest related work and identify the strongest novelty risk."],
];
// `turn:N` has no meaning in this chat: such a link reads as its words
const NO_TURNS = new Set<number>();
const NO_SUBSCRIBE = () => () => {};
// The images attached to a draft, kept for the session: too large for the
// drafts store, but they should still be there after a crossing to the
// Reader and back
const composerImageMemory = new Map<string, string[]>();
const NO_IMAGES: string[] = [];
const NO_REFS: PaperReference[] = [];
const titleOf = mentionTitle;

// A paper named in a question is read by the agent from its Reader folder.
// One never opened in the Reader has no text there yet: it is read out of
// Zotero here, as the Reader would, and kept there for both.
async function prepareReference(ref: PaperReference): Promise<void> {
  const ask = (body: Record<string, unknown>) =>
    fetch("/api/paper/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const { hasText } = await ask({ id: ref.id });
  if (hasText || !ref.zoteroKey) return;
  const extracted = await extractZoteroItemText(ref.zoteroKey, 1_000_000);
  if ("text" in extracted && extracted.text.trim()) await ask({ id: ref.id, title: titleOf(ref.name), text: extracted.text });
}

// A saved attachment as the browser loads it
const attachmentUrl = (root: string, file: string) => `/api/workspaces/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}&raw=1`;

// A sent question's @mentions, drawn where they stand in its text
function mentionComponents(components: MarkdownComponents, refs: PaperReference[] | undefined): MarkdownComponents {
  if (!refs?.length) return components;
  return {
    a: (props) => {
      if (!props.href?.startsWith(MENTION_HREF)) return components.a(props);
      const ref = refs.find((r) => r.id === decodeURIComponent(props.href!.slice(MENTION_HREF.length)));
      return <span className={styles.mention} title={ref ? titleOf(ref.name) : undefined} data-mention="">{props.children}</span>;
    },
  };
}

const UserTurn = memo(function UserTurn({ message, root, components }: { message: AgentMessage; root: string | null; components: MarkdownComponents }) {
  const content = useMemo(() => withMentionLinks(message.content, message.references), [message.content, message.references]);
  const turnComponents = useMemo(() => mentionComponents(components, message.references), [components, message.references]);
  const images = [
    ...(root ? (message.imagePaths ?? []).map((file) => attachmentUrl(root, file)) : []),
    ...(message.imageDataUrl ? [message.imageDataUrl] : []),
  ];
  return (
    <article className={styles.user} data-message-id={message.id}>
      {images.length > 0 && (
        <div className={styles.figures}>
          {images.map((src, n) => (
            <a key={n} href={src} target="_blank" rel="noreferrer" title="Open full size">
              <img className={styles.figure} src={src} alt={`Attached image ${n + 1}`} />
            </a>
          ))}
        </div>
      )}
      <MarkdownAnswer content={content} components={turnComponents} />
    </article>
  );
});

const ToolList = ({ tools, live }: { tools: AgentTool[]; live: boolean }) => (
  <details className={styles.tools}>
    <summary>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.2 2.4a3.4 3.4 0 0 0-4 4.4L2.5 10.5a1.4 1.4 0 0 0 2 2l3.7-3.7a3.4 3.4 0 0 0 4.4-4l-2 2-1.9-.5-.5-1.9z" /></svg>
      {live ? "Using" : "Used"} {tools.length} tool{tools.length === 1 ? "" : "s"}
    </summary>
    <ol>
      {tools.map((tool, index) => (
        <li key={`${tool.name}-${index}`}><strong>{tool.name}</strong>{tool.detail && <small>{tool.detail}</small>}</li>
      ))}
    </ol>
  </details>
);

const AgentTurn = memo(function AgentTurn({ message, live, components }: { message: AgentMessage; live: boolean; components: MarkdownComponents }) {
  const tools = message.tools ?? [];
  return (
    <article className={styles.agent} data-message-id={message.id}>
      <span className={styles.avatar} aria-hidden="true">✦</span>
      <div className={styles.reply}>
        {tools.length > 0 && <ToolList tools={tools} live={live} />}
        {message.content
          ? <MarkdownAnswer content={message.content} components={components} streaming={live} />
          : live && <p className={styles.working}><span aria-hidden="true"><i /><i /><i /></span>Working…</p>}
      </div>
    </article>
  );
});

export const WorkspaceAgent = memo(forwardRef<WorkspaceAgentHandle, Props>(function WorkspaceAgent(props, ref) {
  const { workspace, open, width, onCollapse, documentLabel, activeSkillIds, onOpenSkills } = props;
  const workspaceId = workspace?.id ?? null;
  const subscribe = useMemo(() => (workspaceId ? (listener: () => void) => subscribeChat(workspaceId, listener) : NO_SUBSCRIBE), [workspaceId]);
  const { chat, streaming } = useSyncExternalStore(subscribe, () => chatSnapshot(workspaceId), () => chatSnapshot(null));
  const messages = chat.messages;
  // Each of these belongs to the workspace; the shell remounts this panel
  // when the workspace changes, so they load fresh for it
  const [agent, setAgent] = useState<AgentChoice>(() => loadAgentChoice(workspaceId));
  const [mode, setMode] = useState<AgentMode>(() => loadAgentMode(workspaceId));
  // What is being typed for the agent, kept per workspace: see lib/drafts
  const [question, setQuestion] = useState(() => loadDraft(workspaceId ? `workspace:${workspaceId}` : null)?.text ?? "");
  // The papers the @mentions in it stand for, kept with the draft
  const [refs, setRefs] = useState<PaperReference[]>(() => loadDraft(workspaceId ? `workspace:${workspaceId}` : null)?.mentions ?? NO_REFS);
  // Images waiting to go with the next question, as data URLs until sent
  const [images, setImages] = useState<string[]>(() => (workspaceId ? composerImageMemory.get(workspaceId) ?? NO_IMAGES : NO_IMAGES));
  const [dropping, setDropping] = useState(false);
  // A mention being typed: where its @ is, and where the caret is now; the
  // name between the two is what the list is narrowed to
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [libraryResults, setLibraryResults] = useState<{ key: string; title: string }[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [sent, setSent] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // The handlers as of the latest render, for code that runs later — a
  // citation clicked, an answer finishing — without re-creating what holds them
  const latest = useRef(props);
  const mounted = useRef(false);
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A custom API configured before endpoints were saved on the server moves
  // there, wherever the app is first opened
  useEffect(() => migrateLegacyCustomApi(() => void loadModelCatalog()), []);

  useEffect(() => {
    if (workspaceId) saveAgentMode(workspaceId, mode);
  }, [mode, workspaceId]);

  // The draft is saved a moment after each change, for a refresh, and at
  // once when the workspace or the surface is left
  const draftKey = workspaceId ? `workspace:${workspaceId}` : null;
  const latestDraft = useRef({ text: question, mentions: refs });
  useEffect(() => {
    if (!draftKey) return;
    latestDraft.current = { text: question, mentions: refs };
    const timer = setTimeout(() => saveDraft(draftKey, { text: question, mentions: refs }), 300);
    return () => clearTimeout(timer);
  }, [draftKey, question, refs]);
  useEffect(() => () => {
    if (draftKey) saveDraft(draftKey, latestDraft.current);
  }, [draftKey]);
  useEffect(() => {
    if (!workspaceId) return;
    if (images.length) composerImageMemory.set(workspaceId, images);
    else composerImageMemory.delete(workspaceId);
  }, [workspaceId, images]);

  // The name typed after the @, while the caret is on it; null when no
  // mention is being typed
  const typing = mentionAt === null ? null : mentionQuery(question, mentionAt, caret);
  const pickerOpen = typing !== null;
  const query = (typing ?? "").trim();
  useEffect(() => {
    if (mentionAt !== null && typing === null) setMentionAt(null);
  }, [mentionAt, typing]);

  // The library is searched as the name is typed, a moment after the last key
  useEffect(() => {
    if (!pickerOpen || query.length < 2) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/zotero/items?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        if (live && response.ok) setLibraryResults((data.items ?? []).slice(0, 12));
      } catch {
        if (live) setLibraryResults([]);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [pickerOpen, query]);

  // This workspace's papers first, then the rest of the library
  const workspacePapers = workspace?.papers ?? [];
  const refOptions = useMemo<(PaperReference & { group: "workspace" | "library" })[]>(() => {
    const needle = query.toLowerCase();
    const own = workspacePapers
      .filter((paper) => !needle || mentionTitle(paper.name).toLowerCase().includes(needle))
      .map((paper) => ({ id: paper.id, name: paper.name, zoteroKey: paper.zoteroKey, group: "workspace" as const }));
    const library = query.length < 2 ? [] : libraryResults
      .filter((item) => !workspacePapers.some((paper) => paper.id === item.key || paper.zoteroKey === item.key))
      .map((item) => ({ id: item.key, name: item.title, zoteroKey: item.key, group: "library" as const }));
    return [...own, ...library];
  }, [query, libraryResults, workspacePapers]);

  // The text as changed, the mentions still whole in it, and where the caret
  // goes once it is on screen
  // The caret is moved with the text, in the same update: a render that saw
  // the new text and the old caret would read a mention being typed as left
  const replaceText = (text: string, at: number) => {
    setQuestion(text);
    setRefs((current) => liveMentions(text, current));
    setCaret(at);
    pendingCaret.current = at;
  };
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const box = composerRef.current?.querySelector("textarea");
    if (!box) return;
    box.focus();
    box.setSelectionRange(at, at);
    setCaret(at);
  }, [question]);
  const startMention = (anchor: number) => {
    setMentionAt(anchor);
    setPickerIndex(0);
    setLibraryResults([]);
  };
  // The @ and the name typed after it become the mention, inline
  const pickReference = (ref: PaperReference) => {
    if (mentionAt === null) return;
    const picked = { id: ref.id, name: ref.name, zoteroKey: ref.zoteroKey };
    const next = insertMention(question, mentionAt, caret, picked);
    setMentionAt(null);
    setQuestion(next.text);
    setRefs((current) => liveMentions(next.text, [...current.filter((r) => r.id !== picked.id), picked]));
    setCaret(next.caret);
    pendingCaret.current = next.caret;
  };
  // The @ button types an @ where the caret is, starting a word if it must
  const typeAt = () => {
    const box = composerRef.current?.querySelector("textarea");
    const at = box ? box.selectionStart : question.length;
    const before = question.slice(0, at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const text = `${before}${lead}@${question.slice(box ? box.selectionEnd : at)}`;
    const anchor = at + lead.length;
    replaceText(text, anchor + 1);
    startMention(anchor);
  };

  // Images join the ones already attached, in the order given, up to the
  // most one question carries — chosen, pasted or dropped
  const attachImages = (files: File[]) => {
    const chosen = files.filter((file) => file.type.startsWith("image/"));
    if (!chosen.length) return;
    Promise.all(chosen.map((file) => new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }))).then((urls) => {
      const read = urls.filter((url): url is string => !!url);
      if (!read.length) return;
      setImages((current) => {
        const next = [...current, ...read];
        if (next.length > MAX_ATTACHED_IMAGES) latest.current.onNotice(`A question carries at most ${MAX_ATTACHED_IMAGES} images.`);
        return next.slice(0, MAX_ATTACHED_IMAGES);
      });
    });
  };
  const imageFilesOf = (data: DataTransfer | null) => {
    if (!data) return [];
    const files = Array.from(data.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length) return files;
    return Array.from(data.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  };

  const citeRef = useRef<CiteHandlers>({});
  useEffect(() => {
    citeRef.current = { paper: (page, quote) => latest.current.onCitePaper(page, quote) };
  });
  const components = useMemo<MarkdownComponents>(() => ({
    a: ({ href, children }) => <CitationAnchor href={href} cite={citeRef} knownTurns={NO_TURNS} canJumpToPaper>{children}</CitationAnchor>,
  }), []);

  // Opening the panel shows the latest of the conversation; sending brings
  // the question to the top, with the answer growing beneath it
  useLayoutEffect(() => {
    const list = listRef.current;
    if (open && list) list.scrollTop = list.scrollHeight;
  }, [open]);
  useLayoutEffect(() => {
    if (!sent) return;
    const asked = listRef.current?.querySelectorAll<HTMLElement>("[data-message-id]");
    asked?.[Math.max(0, asked.length - 2)]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [sent]);

  const chooseAgent = (model: string, effort: string | undefined) => {
    const next = { model, effort };
    setAgent(next);
    if (workspaceId) saveAgentChoice(workspaceId, next);
  };

  // Every question goes to this workspace's agent — typed in the composer,
  // or asked from the page as the Reader asks
  const ask = async (input: AgentAsk = {}) => {
    if (!workspace) return;
    const id = workspace.id;
    const fromPage = input.kind !== undefined;
    const typed = (fromPage ? input.question ?? "" : question).trim();
    // A figure captured from the page, or what is attached in the box
    const attaching = input.imageDataUrl ? [input.imageDataUrl] : fromPage ? [] : images;
    const references = fromPage ? NO_REFS : liveMentions(question, refs);
    if (!typed && !input.selectedText && !attaching.length) return;
    const controller = beginRun(id);
    if (!controller) { latest.current.onNotice("The agent is still answering."); return; }
    // The images are saved into the workspace first, and the conversation
    // keeps only where they are: see lib/workspace-attachments
    let imagePaths: string[] = [];
    if (attaching.length) {
      try {
        const response = await fetch("/api/workspaces/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: workspace.root, images: attaching }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not save the images.");
        imagePaths = data.paths;
      } catch (reason) {
        endRun(id, controller);
        latest.current.onNotice(`The images could not be saved in the workspace: ${reason instanceof Error ? reason.message : "unknown error"}. Nothing was sent.`);
        return;
      }
    }
    const passage = input.selectedText?.replace(/\s+/g, " ").trim();
    const page = input.pageNumber ? ` (p. ${input.pageNumber})` : "";
    const shown = input.kind === "explain" ? `Explain${page}:\n\n> ${passage}`
      : input.kind === "define" ? `Define${page}:\n\n> ${passage}`
      : input.kind === "figure" ? (typed || `Explain this figure${page}.`)
      : passage ? `${typed}\n\n> ${passage}${page}` : typed;
    // The chat so far, so an agent starting a session mid-conversation —
    // another provider, or one that lost its session — knows what was said
    const history = messages.filter((message) => message.content.trim()).slice(-30).map((message) => ({ role: message.role, content: message.content.slice(0, 1500) }));
    const provider = providerIdFor(agent.model);
    const assistantId = uid();
    updateRun(id, controller, (current) => ({
      ...current,
      messages: [...current.messages, { id: uid(), role: "user", content: shown, ...(imagePaths.length ? { imagePaths } : {}), ...(references.length ? { references } : {}) }, { id: assistantId, role: "assistant", content: "", tools: [] }],
    }));
    // A question asked from the page leaves whatever is being typed alone
    if (!fromPage) {
      setQuestion("");
      setImages(NO_IMAGES);
      setRefs(NO_REFS);
      setMentionAt(null);
    }
    setSent((count) => count + 1);
    const patch = (change: (message: AgentMessage) => AgentMessage) =>
      updateRun(id, controller, (current) => ({ ...current, messages: current.messages.map((message) => (message.id === assistantId ? change(message) : message)) }));
    let text = "";
    try {
      // The papers named are made readable first; one that cannot be is
      // still named, and the agent told so
      await Promise.all(references.map((ref) => prepareReference(ref).catch(() => {})));
      const response = await fetch("/api/workspaces/ask", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: workspace.root, question: typed, kind: input.kind, selected_text: passage, page_number: input.pageNumber, image_paths: imagePaths,
          // The attached papers, so the agent can draw on what was read and
          // asked about each of them in the Reader
          papers: workspace.papers.map((paper) => ({ id: paper.id, name: paper.name, zoteroKey: paper.zoteroKey })),
          references,
          history,
          context: latest.current.getContext(),
          model: agent.model,
          effort: agent.effort,
          // This provider's own session: each resumes its own conversation
          session_id: chat.sessions[provider],
          mode,
          skills: activeSkillIds,
        }),
      });
      if (!response.ok || !response.body) throw new Error((await response.text()) || "The agent did not answer.");
      await readLines(response.body, (line) => {
        const event = parseAgentEvent(line);
        if (!event) return;
        if (event.type === "system" && event.session_id) {
          const session = event.session_id;
          updateRun(id, controller, (current) => (current.sessions[provider] === session ? current : { ...current, sessions: { ...current.sessions, [provider]: session } }));
          return;
        }
        const before = text;
        const tools: AgentTool[] = [];
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text ?? "";
        if (event.type === "result" && typeof event.result === "string" && !text) text = event.result;
        if (event.type === "tool") tools.push({ name: event.name || "tool", detail: event.detail || "", status: event.status });
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "text" && typeof block.text === "string") text += block.text;
            if (block.type === "tool_use") tools.push({ name: block.name || "tool", detail: JSON.stringify(block.input || {}).slice(0, 180), status: "requested" });
          }
        }
        if (text !== before || tools.length) patch((message) => ({ ...message, content: text, tools: tools.length ? [...(message.tools || []), ...tools] : message.tools }));
      });
      // Either mode may have written something — notes in a discussion. Only
      // while this workspace is still the one on screen: the tree shows its files
      if (mounted.current) latest.current.onFilesChanged();
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        patch((message) => ({ ...message, content: `Error: ${reason instanceof Error ? reason.message : "Could not reach the agent."}` }));
      }
    } finally {
      endRun(id, controller);
    }
  };

  const quote = (text: string, page?: number, remark?: string) => {
    const quoted = `“${text.replace(/\s+/g, " ").trim()}”${page ? ` (p. ${page})` : ""}${remark ? `\n${remark}` : ""}`;
    setQuestion((current) => (current.trim() ? `${current.trimEnd()}\n\n${quoted}\n\n` : `${quoted}\n\n`));
    requestAnimationFrame(() => {
      const box = composerRef.current?.querySelector("textarea");
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    });
  };

  const revealMessage = (id: string) => {
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find((m) => m.dataset.messageId === id);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove(styles.landed);
    // Restarted on a second landing on the same message
    void el.offsetWidth;
    el.classList.add(styles.landed);
    setTimeout(() => el.classList.remove(styles.landed), 1600);
    return true;
  };

  useImperativeHandle(ref, () => ({ ask: (input) => void ask(input), quote, revealMessage }));

  const stop = useCallback(() => { if (workspaceId) stopRun(workspaceId); }, [workspaceId]);

  if (!open) return null;
  const lastId = messages[messages.length - 1]?.id;
  const modeHint = mode === "auto"
    ? "Auto: the agent implements on its own inside this workspace — edits, commands, tests"
    : "Discussion: brainstorming with the open document, the files and the papers' Reader conversations at hand · notes may be written, nothing is built";

  return (
    <aside className={styles.panel} style={{ width }} aria-label="Workspace agent">
      <header className={styles.head}>
        <button type="button" className={styles.iconButton} onClick={onCollapse} title="Hide the workspace agent" aria-label="Hide the workspace agent"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg></button>
        <p className={styles.title}>
          <strong>Agent</strong>
          <small title={documentLabel ?? undefined}>{documentLabel ? `Working with ${documentLabel}` : "Workspace context"}</small>
        </p>
        <span className={styles.picker}>
          <AgentPicker label="Workspace agent" value={agent.model} effort={agent.effort} onChange={chooseAgent} />
        </span>
        <button type="button" className={styles.iconButton} onClick={() => setExportOpen(true)} disabled={!workspace || !messages.length} title="Export this conversation as a Markdown file, to carry to another agent or machine" aria-label="Export conversation">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5V2.5M5 5.2 8 2.2l3 3M3 9.5v3.8h10V9.5" /></svg>
        </button>
      </header>

      <div ref={listRef} className={styles.messages}>
        {!messages.length && (
          <div className={styles.welcome}>
            <span className={styles.welcomeMark} aria-hidden="true">✦</span>
            <h2>Start with the decision you need to make</h2>
            <p>I can read the open document, inspect workspace files, use your active skills, and turn an idea into an experiment handoff.</p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map(([title, detail, prompt]) => (
                <button key={title} type="button" onClick={() => setQuestion(prompt)}>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => message.role === "user"
          ? <UserTurn key={message.id} message={message} root={workspace?.root ?? null} components={components} />
          : <AgentTurn key={message.id} message={message} live={streaming && message.id === lastId} components={components} />)}
      </div>

      <footer className={styles.composerArea}>
        <div
          ref={composerRef}
          className={styles.composer}
          data-dropping={dropping || undefined}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropping(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(event) => {
            setDropping(false);
            const files = imageFilesOf(event.dataTransfer);
            if (!files.length) return;
            event.preventDefault();
            attachImages(files);
          }}
        >
          {pickerOpen && (
            <div className={styles.refPicker} role="listbox" aria-label="Papers to mention">
              <p className={styles.refHint}>
                {query ? <>Papers matching “{query}”</> : workspacePapers.length ? "This workspace's papers — type to search your library" : "Type a name to search your library"}
                <span>↑↓ · Enter · Esc</span>
              </p>
              <div className={styles.refOptions}>
                {refOptions.map((option, index) => (
                  <button
                    key={`${option.group}:${option.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === pickerIndex}
                    className={styles.refOption}
                    onMouseEnter={() => setPickerIndex(index)}
                    // Keeps the caret in the box, where the mention goes
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickReference(option)}
                    title={titleOf(option.name)}
                  >
                    <span>{titleOf(option.name)}</span>
                    <small>{option.group === "workspace" ? "in this workspace" : "library"}</small>
                  </button>
                ))}
                {!refOptions.length && (
                  <p className={styles.refEmpty}>{query.length < 2 ? "Keep typing to search your Zotero library" : "No paper matches"}</p>
                )}
              </div>
            </div>
          )}
          {images.length > 0 && (
            <div className={styles.attachments} data-attached-images={images.length}>
              {images.map((src, index) => (
                <span key={index} className={styles.attachment}>
                  <img src={src} alt={`Attached image ${index + 1}`} />
                  <button type="button" onClick={() => setImages((current) => current.filter((_, i) => i !== index))} title="Remove this image" aria-label={`Remove image ${index + 1}`}>✕</button>
                </span>
              ))}
            </div>
          )}
          <MentionTextarea
            value={question}
            ranges={mentionRanges(question, refs)}
            markClassName={styles.mentionMark}
            onChange={(event) => {
              const value = event.target.value;
              const at = event.target.selectionStart ?? value.length;
              setCaret(at);
              // An @ typed at the start of a word begins a mention
              if (workspace && typedMentionStart(question, value, at)) startMention(at - 1);
              setQuestion(value);
              setRefs((current) => liveMentions(value, current));
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const files = imageFilesOf(event.clipboardData);
              if (!files.length) return;
              event.preventDefault();
              attachImages(files);
            }}
            onKeyDown={(event) => {
              const composing = event.nativeEvent.isComposing;
              // While a mention is being typed, the list has the arrows,
              // Enter and Tab, and Escape leaves the @ as plain text
              if (pickerOpen && !composing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setPickerIndex((i) => Math.min(Math.max(0, i + step), Math.max(0, refOptions.length - 1)));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const option = refOptions[pickerIndex] ?? refOptions[0];
                  if (option) pickReference(option);
                  else setMentionAt(null);
                  return;
                }
                if (event.key === "Escape") { event.preventDefault(); setMentionAt(null); return; }
              }
              // A mention goes whole; ⌥⌫ and ⌘⌫ still take a word or a line
              if ((event.key === "Backspace" || event.key === "Delete") && !composing && !event.altKey && !event.metaKey && !event.ctrlKey) {
                const box = event.currentTarget;
                if (box.selectionStart === box.selectionEnd) {
                  const next = deleteMention(question, box.selectionStart, refs, event.key);
                  if (next) { event.preventDefault(); replaceText(next.text, next.caret); return; }
                }
              }
              if (isSubmitKey(event)) { event.preventDefault(); void ask(); }
            }}
            placeholder={workspace ? "Ask about the document or workspace · @ names a paper" : "Create a workspace to talk to its agent"}
            rows={2}
            aria-label="Message the workspace agent"
          />
          <div className={styles.composerBar}>
            <label className={styles.iconButton} title={`Attach images — or paste or drop them here (up to ${MAX_ATTACHED_IMAGES})`} aria-label="Attach images" data-disabled={!workspace || undefined}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.6 9.4a1.3 1.3 0 0 0 1.8 1.8l5-5a2.6 2.6 0 0 0-3.7-3.7l-5 5a3.9 3.9 0 0 0 5.5 5.5l4.3-4.3" /></svg>
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={!workspace}
                onChange={(event) => {
                  attachImages(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => (pickerOpen ? setMentionAt(null) : typeAt())}
              disabled={!workspace}
              aria-pressed={pickerOpen}
              title="Name a paper in your question — this workspace's or any in your library (or type @)"
              aria-label="Reference a paper"
            >
              <span className={styles.at} aria-hidden="true">@</span>
            </button>
            <span role="group" aria-label="Agent mode" className={styles.modeSwitch}>
              {MODES.map(([value, label, hint]) => (
                <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} title={hint}>{label}</button>
              ))}
            </span>
            <button type="button" className={styles.skillsChip} onClick={onOpenSkills} title="Choose agent skills">
              <i aria-hidden="true">◆</i>{activeSkillIds.length ? `${activeSkillIds.length} skill${activeSkillIds.length === 1 ? "" : "s"}` : "Skills"}
            </button>
            {streaming
              ? <button type="button" className={styles.stop} onClick={stop} title="Stop the answer" aria-label="Stop the answer"><span /></button>
              : <button type="button" className={styles.send} disabled={(!question.trim() && !images.length) || !workspace} onClick={() => void ask()} title="Send (Enter)" aria-label="Send">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" /></svg>
                </button>}
          </div>
        </div>
        <small className={styles.hint}>{modeHint}</small>
      </footer>

      {workspace && (
        <ExportDialog
          open={exportOpen}
          workspace={workspace}
          messages={messages}
          model={agent.model}
          onClose={() => setExportOpen(false)}
          onExported={(result) => latest.current.onExported(result)}
        />
      )}
    </aside>
  );
}));
