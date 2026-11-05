"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { goToResult, KIND_LABEL, placeLabel, workspacesForSearch, type Locator, type Surface } from "@/lib/search-nav";
import { openFinder } from "@/lib/finder-chat";
import { FinderChat } from "./FinderChat";
import styles from "./search-palette.module.css";

// One box, on both surfaces, for finding anything again: a paper, a
// conversation about one, a concept, a note, a workspace chat or file. What
// is typed is matched by word at once — the paper on screen's own
// conversations and concepts first — and a result goes to the place itself.
// What words cannot find, an agent can: "Not here?" opens it in a small chat
// of its own (FinderChat) that can be asked again and again.

type Result = { id: string; kind: Locator["kind"]; title: string; where: string; snippet?: string; here?: boolean; locator: Locator };

// reading: the paper on screen, whose own conversations and concepts come first
export function SearchPalette({ surface, reading }: { surface: Surface; reading?: { id: string; title: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searched, setSearched] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    if (open) requestAnimationFrame(() => inputRef.current?.select());
  }, [open]);

  // Matched by word as it is typed, a moment after the last key
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setResults([]);
      setSearched("");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, paperId: reading?.id, workspaces: workspacesForSearch() }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (res.ok) {
          setResults(data.results ?? []);
          setSearched(q);
        }
      } catch {
        // a newer query took over, or the server is away
      }
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open, reading?.id]);

  // This paper's own conversations and concepts, then the rest of the library
  const rows = useMemo(() => [...results.filter((r) => r.here), ...results.filter((r) => !r.here)], [results]);
  useEffect(() => setSelected(0), [rows]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = useCallback((result: Result) => {
    setOpen(false);
    goToResult(result.locator, surface, (href) => router.push(href));
  }, [surface, router]);

  // The agent, in its own window: what was typed is its first message
  const askAgent = useCallback(() => {
    setOpen(false);
    openFinder(query.trim() || undefined, reading);
  }, [query, reading]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => Math.min(i + 1, rows.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      // ⌘Enter, or Enter with nothing to go to, asks the agent
      if (e.metaKey || e.ctrlKey || !rows[selected]) askAgent();
      else choose(rows[selected]);
    }
  };

  const nothing = !!searched && searched === query.trim() && rows.length === 0;

  return (
    <>
      <button type="button" className="pr-capability-button" onClick={() => setOpen(true)} title="Find a paper, conversation, concept or note (⌘K)">
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
                placeholder={reading ? `Find in “${reading.title}” and everywhere else…` : "Find a paper, a conversation, a concept, a note…"}
                aria-label="Search"
              />
              <button type="button" className={styles.agentButton} onClick={askAgent} title="Describe it to an agent that reads your library, and ask again until it is found (⌘Enter)">
                <span aria-hidden>✦</span> Not here? Ask the agent <kbd>⌘↵</kbd>
              </button>
            </div>
            <div ref={listRef} className={styles.list} role="listbox">
              {rows.map((result, index) => {
                const heading = index === 0 || rows[index - 1].here !== result.here
                  ? result.here ? `In this paper · ${reading?.title ?? ""}` : reading ? "Elsewhere in your library" : null
                  : null;
                const place = placeLabel(result.locator);
                return [
                  heading && <p key={`h:${result.here ? 1 : 0}`} className={styles.heading}>{heading}</p>,
                  <button
                    key={result.id}
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
                      {result.locator.kind === "conversation" && result.locator.quote ? (
                        <small className={styles.cite}><b>{result.locator.inAnswer ? "In the answer" : "You asked"}</b> “{result.locator.quote}”</small>
                      ) : result.snippet && result.snippet !== result.title && <small>{result.snippet}</small>}
                      <i>{result.here ? "This paper" : result.where}{place ? ` · ${place}` : ""}</i>
                    </span>
                  </button>,
                ];
              })}
              {nothing && (
                <button type="button" className={`${styles.row} ${styles.nothing}`} onClick={askAgent}>
                  <span className={styles.spark} aria-hidden>✦</span>
                  <span className={styles.body}>
                    <strong>No word of it matches. Describe it to the agent instead</strong>
                    <small>It reads your papers, conversations, notes and workspaces, and you can keep asking · Enter</small>
                  </span>
                </button>
              )}
              {!query.trim() && (
                <p className={styles.empty}>
                  {reading ? "This paper's conversations and concepts come first, then the rest of your library. " : ""}↑↓ to choose · Enter to go there · ⌘Enter to ask the agent · Esc to close
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      <FinderChat surface={surface} reading={reading} />
    </>
  );
}
