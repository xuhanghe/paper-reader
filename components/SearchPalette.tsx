"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readLines } from "@/lib/ndjson";
import { goToResult, workspacesForSearch, type Locator, type Surface } from "@/lib/search-nav";
import styles from "./search-palette.module.css";

// One box, on both surfaces, for finding anything again: a paper, a
// conversation about one, a note, a workspace chat or file. What is typed is
// matched by word at once; Enter on the first row asks a one-shot agent to
// find it from the memory as described (lib/search-agent). Choosing a result
// goes to the place itself — the page, the turn, the note, the message.

type Kind = Locator["kind"];
type Result = { id: string; kind: Kind; title: string; where: string; snippet?: string; why?: string; locator: Locator };
type AgentState =
  | { status: "idle" }
  | { status: "running"; activity: string[] }
  | { status: "done"; results: Result[] }
  | { status: "error"; message: string };

const KIND_LABEL: Record<Kind, string> = {
  paper: "Paper",
  conversation: "Conversation",
  note: "Note",
  "workspace-chat": "Workspace chat",
  "workspace-file": "File",
};

function placeLabel(loc: Locator): string | null {
  if (loc.kind === "conversation" && loc.turn) return `turn ${loc.turn}`;
  if ((loc.kind === "paper" || loc.kind === "note" || loc.kind === "conversation") && loc.page) return `p. ${loc.page}`;
  return null;
}

export function SearchPalette({ surface }: { surface: Surface }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState<Result[]>([]);
  const [agent, setAgent] = useState<AgentState>({ status: "idle" });
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const agentAbort = useRef<AbortController | null>(null);
  // The query the agent last answered, so its results are not shown under another
  const [askedFor, setAskedFor] = useState("");

  // ⌘K / Ctrl+K anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      agentAbort.current?.abort();
      return;
    }
    requestAnimationFrame(() => inputRef.current?.select());
  }, [open]);

  // Matched by word as it is typed, a moment after the last key
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setQuick([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, workspaces: workspacesForSearch() }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (res.ok) setQuick(data.results ?? []);
      } catch {
        // a newer query took over, or the server is away
      }
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);

  const agentResults = agent.status === "done" && askedFor === query.trim() ? agent.results : [];
  // The rows, in the order the arrows move through them: asking first, then
  // what the agent found, then what matched by word
  const rows = useMemo(() => {
    const found = new Set(agentResults.map((r) => r.id));
    return [
      ...(query.trim() ? [{ type: "ask" as const }] : []),
      ...agentResults.map((r) => ({ type: "found" as const, result: r })),
      ...quick.filter((r) => !found.has(r.id)).map((r) => ({ type: "quick" as const, result: r })),
    ];
  }, [query, agentResults, quick]);

  // The selection starts on asking, and on the best find once there is one
  useEffect(() => setSelected(0), [query]);
  useEffect(() => { if (agentResults.length) setSelected(1); }, [agentResults.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const ask = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    agentAbort.current?.abort();
    const controller = new AbortController();
    agentAbort.current = controller;
    setAskedFor(q);
    setAgent({ status: "running", activity: [] });
    try {
      const res = await fetch("/api/search/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, workspaces: workspacesForSearch() }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || "The search did not start.");
      let finished = false;
      await readLines(res.body, (line) => {
        let event: { type?: string; text?: string; results?: Result[]; message?: string };
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "activity" && event.text) {
          setAgent((s) => (s.status === "running" ? { status: "running", activity: [...s.activity, event.text!].slice(-4) } : s));
        } else if (event.type === "results") {
          finished = true;
          setAgent({ status: "done", results: event.results ?? [] });
        } else if (event.type === "error") {
          finished = true;
          setAgent({ status: "error", message: event.message || "The search failed." });
        }
      });
      if (!finished) setAgent({ status: "error", message: "The search ended without an answer." });
    } catch (error) {
      if (controller.signal.aborted) return;
      setAgent({ status: "error", message: error instanceof Error ? error.message : "The search failed." });
    }
  }, [query]);

  const choose = useCallback((result: Result) => {
    setOpen(false);
    goToResult(result.locator, surface, (href) => router.push(href));
  }, [surface, router]);

  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.type === "ask") void ask();
    else choose(row.result);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => Math.min(i + 1, rows.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      // ⌘Enter always asks, wherever the selection is
      if (e.metaKey || e.ctrlKey) void ask();
      else activate(selected);
    }
  };

  const running = agent.status === "running";
  const resultRow = (result: Result, index: number, found: boolean) => {
    const place = placeLabel(result.locator);
    return (
      <button
        key={`${found ? "f" : "q"}:${result.id}`}
        type="button"
        data-row={index}
        className={styles.row}
        aria-selected={index === selected}
        onMouseEnter={() => setSelected(index)}
        onClick={() => choose(result)}
      >
        <span className={styles.kind} data-kind={result.kind}>{KIND_LABEL[result.kind]}</span>
        <span className={styles.body}>
          <strong>{result.title}</strong>
          {result.why ? <em>{result.why}</em> : result.snippet && result.snippet !== result.title ? <small>{result.snippet}</small> : null}
          <i>{result.where}{place ? ` · ${place}` : ""}</i>
        </span>
      </button>
    );
  };

  return (
    <>
      <button type="button" className="pr-capability-button" onClick={() => setOpen(true)} title="Find a paper, conversation or note — from what you remember (⌘K)">
        <i aria-hidden>⌕</i><span>Search</span><kbd className={styles.kbd}>⌘K</kbd>
      </button>
      {open && (
        <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className={styles.panel} role="dialog" aria-label="Search the library">
            <div className={styles.field}>
              <span aria-hidden>⌕</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Describe what you remember — a paper, a conversation, a note…"
                aria-label="What you remember"
              />
              {running && <button type="button" className={styles.stop} onClick={() => { agentAbort.current?.abort(); setAgent({ status: "idle" }); }}>Stop</button>}
            </div>
            <div ref={listRef} className={styles.list} role="listbox">
              {rows.map((row, index) => {
                if (row.type === "ask") {
                  return (
                    <button key="ask" type="button" data-row={index} className={`${styles.row} ${styles.ask}`} aria-selected={index === selected} onMouseEnter={() => setSelected(index)} onClick={() => void ask()}>
                      <span className={styles.spark} aria-hidden>✦</span>
                      <span className={styles.body}>
                        <strong>{running ? "Looking through your library…" : "Find it from what you remember"}</strong>
                        {running ? (
                          <span className={styles.activity}>{(agent.activity.length ? agent.activity : ["Starting"]).map((line, n, all) => <small key={n} data-latest={n === all.length - 1 || undefined}>{line}</small>)}</span>
                        ) : agent.status === "done" && askedFor === query.trim() && !agent.results.length ? (
                          <small>Nothing that fits came up. Try saying it another way, or what else you remember about it.</small>
                        ) : agent.status === "error" ? (
                          <small className={styles.error}>{agent.message}</small>
                        ) : (
                          <small>An agent reads your papers, conversations, notes and workspaces for it · Enter</small>
                        )}
                      </span>
                    </button>
                  );
                }
                // Each group says what it is where it begins
                const previous = rows[index - 1];
                const heading = previous?.type !== row.type ? (row.type === "found" ? "Found from what you remember" : "Matching words") : null;
                return [
                  heading && <p key={`h:${row.type}`} className={styles.heading}>{heading}</p>,
                  resultRow(row.result, index, row.type === "found"),
                ];
              })}
              {!query.trim() && <p className={styles.empty}>Type what you remember of it, in any words or language. ↑↓ to choose · Enter to go there · Esc to close</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
