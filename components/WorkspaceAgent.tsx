"use client";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentPicker } from "./AgentPicker";
import { GrowingTextarea } from "./GrowingTextarea";
import { CitationAnchor, MarkdownAnswer, type CiteHandlers, type MarkdownComponents } from "./MarkdownAnswer";
import { ExportDialog } from "./WorkspaceDialogs";
import { loadModelCatalog } from "@/hooks/useModelCatalog";
import { parseAgentEvent } from "@/lib/agent-events";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { isSubmitKey } from "@/lib/keys";
import { migrateLegacyCustomApi } from "@/lib/legacy-custom-api";
import { providerIdFor } from "@/lib/model-spec";
import { readLines } from "@/lib/ndjson";
import type { SelectionIntent } from "@/lib/prompts";
import { uid } from "@/lib/uid";
import { beginRun, chatSnapshot, endRun, loadAgentChoice, loadAgentMode, saveAgentChoice, saveAgentMode, stopRun, subscribeChat, updateRun, type AgentChoice, type AgentMessage, type AgentTool } from "@/lib/workspace-chat";
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

const UserTurn = memo(function UserTurn({ message, components }: { message: AgentMessage; components: MarkdownComponents }) {
  return (
    <article className={styles.user} data-message-id={message.id}>
      {message.imageDataUrl && <img className={styles.figure} src={message.imageDataUrl} alt="Captured figure" />}
      <MarkdownAnswer content={message.content} components={components} />
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
  const latestDraft = useRef(question);
  useEffect(() => {
    if (!draftKey) return;
    latestDraft.current = question;
    const timer = setTimeout(() => saveDraft(draftKey, { text: question }), 300);
    return () => clearTimeout(timer);
  }, [draftKey, question]);
  useEffect(() => () => {
    if (draftKey) saveDraft(draftKey, { text: latestDraft.current });
  }, [draftKey]);

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
    if (!typed && !input.selectedText && !input.imageDataUrl) return;
    const controller = beginRun(id);
    if (!controller) { latest.current.onNotice("The agent is still answering."); return; }
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
      messages: [...current.messages, { id: uid(), role: "user", content: shown, imageDataUrl: input.imageDataUrl }, { id: assistantId, role: "assistant", content: "", tools: [] }],
    }));
    // A question asked from the page leaves whatever is being typed alone
    if (!fromPage) setQuestion("");
    setSent((count) => count + 1);
    const patch = (change: (message: AgentMessage) => AgentMessage) =>
      updateRun(id, controller, (current) => ({ ...current, messages: current.messages.map((message) => (message.id === assistantId ? change(message) : message)) }));
    let text = "";
    try {
      const response = await fetch("/api/workspaces/ask", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: workspace.root, question: typed, kind: input.kind, selected_text: passage, page_number: input.pageNumber, image_base64: input.imageDataUrl,
          // The attached papers, so the agent can draw on what was read and
          // asked about each of them in the Reader
          papers: workspace.papers.map((paper) => ({ id: paper.id, name: paper.name, zoteroKey: paper.zoteroKey })),
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

  useImperativeHandle(ref, () => ({ ask: (input) => void ask(input), quote }));

  const stop = useCallback(() => { if (workspaceId) stopRun(workspaceId); }, [workspaceId]);

  if (!open) return null;
  const lastId = messages[messages.length - 1]?.id;
  const modeHint = mode === "auto"
    ? "Auto: the agent implements on its own inside this workspace — edits, commands, tests"
    : "Discussion: brainstorming with the open document, the files and the papers' Reader conversations at hand · notes may be written, nothing is built";

  return (
    <aside className={styles.panel} style={{ width }} aria-label="Workspace agent">
      <header className={styles.head}>
        <button type="button" className={styles.iconButton} onClick={onCollapse} title="Hide the workspace agent" aria-label="Hide the workspace agent">›</button>
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
          ? <UserTurn key={message.id} message={message} components={components} />
          : <AgentTurn key={message.id} message={message} live={streaming && message.id === lastId} components={components} />)}
      </div>

      <footer className={styles.composerArea}>
        <div ref={composerRef} className={styles.composer}>
          <GrowingTextarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (isSubmitKey(event)) { event.preventDefault(); void ask(); } }}
            placeholder={workspace ? "Ask about the open document or workspace…" : "Create a workspace to talk to its agent"}
            rows={2}
            aria-label="Message the workspace agent"
          />
          <div className={styles.composerBar}>
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
              : <button type="button" className={styles.send} disabled={!question.trim() || !workspace} onClick={() => void ask()} title="Send (Enter)" aria-label="Send">
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
