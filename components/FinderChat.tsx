"use client";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { closeFinder, closedSnapshot, finderSnapshot, sendToFinder, stopFinder, subscribeFinder, type FoundItem } from "@/lib/finder-chat";
import { goToResult, KIND_LABEL, placeLabel, type Surface } from "@/lib/search-nav";
import { isSubmitKey } from "@/lib/keys";
import { GrowingTextarea } from "./GrowingTextarea";
import styles from "./search-palette.module.css";

// The agent search as a small window over the page: described, answered,
// narrowed — "not that one, the one about SM5" — as many times as it takes.
// A result goes to its place and the window stays, for the next question.
// It is dragged by its title bar to wherever it is out of the way; closing
// it forgets everything said in it (lib/finder-chat).

const WIDTH = 380;
const POSITION_KEY = "paper-reader:finder-position";

function initialPosition(): { x: number; y: number } {
  const fallback = { x: Math.max(16, window.innerWidth - WIDTH - 24), y: Math.max(16, window.innerHeight - 560 - 24) };
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "null") as { x?: number; y?: number } | null;
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") return { x: saved.x, y: saved.y };
  } catch {
    // a convenience only
  }
  return fallback;
}

// Kept on screen, however the window was resized since
const clamp = (p: { x: number; y: number }) => ({
  x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - WIDTH - 8)),
  y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - 120)),
});

export function FinderChat({ surface, reading }: { surface: Surface; reading?: { id: string; title: string } }) {
  const router = useRouter();
  const finder = useSyncExternalStore(subscribeFinder, finderSnapshot, closedSnapshot);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    if (finder.open && !position) setPosition(clamp(initialPosition()));
  }, [finder.open, position]);
  useEffect(() => {
    const onResize = () => setPosition((p) => (p ? clamp(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // The newest at the bottom, in view
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [finder.turns]);

  if (!finder.open || !position || typeof document === "undefined") return null;

  const send = () => {
    if (!draft.trim() || finder.running) return;
    void sendToFinder(draft, reading);
    setDraft("");
  };
  const go = (item: FoundItem) => goToResult(item.locator, surface, (href) => router.push(href));

  return createPortal(
    <section className={styles.finder} style={{ left: position.x, top: position.y, width: WIDTH }} role="dialog" aria-label="Find with the agent">
      <header
        className={styles.finderHead}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("button")) return;
          drag.current = { dx: e.clientX - position.x, dy: e.clientY - position.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPosition(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* a convenience only */ }
        }}
      >
        <span className={styles.spark} aria-hidden>✦</span>
        <span className={styles.finderTitle}><strong>Find with the agent</strong><small>Forgotten when you close it</small></span>
        <button type="button" onClick={closeFinder} aria-label="Close and forget this search" title="Close — everything here is forgotten">✕</button>
      </header>

      <div ref={listRef} className={styles.finderList}>
        {!finder.turns.length && (
          <p className={styles.finderEmpty}>
            Describe what you are looking for — a paper, a conversation, a concept, a note, in any words or language. Then narrow it down: “not that one, the one where I asked about SM5”.
          </p>
        )}
        {finder.turns.map((turn) =>
          turn.role === "user" ? (
            <p key={turn.id} className={styles.finderMine}>{turn.text}</p>
          ) : (
            <div key={turn.id} className={styles.finderReply} data-status={turn.status}>
              {turn.status === "running" && (
                <div className={styles.finderActivity}>
                  <strong>Looking through your library…</strong>
                  {(turn.activity.length ? turn.activity.slice(-3) : ["Starting"]).map((line, n) => <small key={n}>{line}</small>)}
                </div>
              )}
              {turn.status === "error" && <p className={styles.error}>{turn.error}</p>}
              {turn.status === "done" && (turn.reply || !turn.results.length) && (
                <p>{turn.reply || "Nothing that fits came up. Say it another way, or what else you remember about it."}</p>
              )}
              {turn.results.map((item) => {
                const place = placeLabel(item.locator);
                return (
                  <button key={item.id} type="button" className={styles.finderCard} onClick={() => go(item)} title="Go there">
                    <span className={styles.kind} data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>
                    <span className={styles.body}>
                      <strong>{item.title}</strong>
                      {item.locator.kind === "conversation" && item.locator.quote && (
                        <small className={styles.cite}><b>{item.locator.inAnswer ? "In the answer" : "You asked"}</b> “{item.locator.quote}”</small>
                      )}
                      {item.why && <em>{item.why}</em>}
                      <i>{item.where}{place ? ` · ${place}` : ""}</i>
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>

      <footer className={styles.finderInput}>
        <GrowingTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (isSubmitKey(e)) { e.preventDefault(); send(); } }}
          placeholder={finder.turns.length ? "Narrow it down, or ask something else…" : "What do you remember of it?"}
          aria-label="Tell the agent what you remember"
          autoFocus
          rows={1}
        />
        {finder.running
          ? <button type="button" onClick={stopFinder} className={styles.finderStop}>Stop</button>
          : <button type="button" onClick={send} disabled={!draft.trim()} className={styles.finderSend} aria-label="Send">↑</button>}
      </footer>
    </section>,
    document.body
  );
}
