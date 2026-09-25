// A trace of what the Ask panel does to its own scroll position, and of the
// underline rules the reader paints, written to a file on the machine the app
// runs on. Off unless asked for: open the app with ?trace=1 once (it stays on
// for that browser until ?trace=0). Every line carries the build stamp of the
// code that wrote it, so a report from a browser can be matched against the
// code it actually ran — a stale script and a live bug look the same from a
// screenshot, and not from this.

export const PANEL_BUILD = "2026-09-25.1";

type Entry = Record<string, unknown> & { t: number; what: string; build: string };

const FLAG = "paper-reader:trace";
let enabled: boolean | null = null;
const queue: Entry[] = [];
let timer = 0;
let started = 0;

function decide(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const wanted = new URLSearchParams(window.location.search).get("trace");
    if (wanted === "1") localStorage.setItem(FLAG, "1");
    if (wanted === "0") localStorage.removeItem(FLAG);
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function traceEnabled(): boolean {
  if (enabled === null) enabled = decide();
  return enabled;
}

function flush() {
  timer = 0;
  const batch = queue.splice(0);
  if (batch.length === 0) return;
  try {
    fetch("/api/dev/trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // a lost trace line is never worth an error in the reader
  }
}

// Records one event. `t` is milliseconds since the trace started in this
// page, so the order and spacing of events is exact even across a flush.
export function trace(what: string, data: Record<string, unknown> = {}): void {
  if (!traceEnabled()) return;
  if (!started) {
    started = Date.now();
    queue.push({ t: 0, build: PANEL_BUILD, what: "trace-started", ua: navigator.userAgent, href: window.location.href, at: new Date(started).toISOString() });
  }
  queue.push({ t: Date.now() - started, build: PANEL_BUILD, what, ...data });
  if (!timer) timer = window.setTimeout(flush, 400);
}

// Describes an element for the log: tag, conversation, first words.
export function describeForTrace(el: Element | null | undefined): string {
  if (!el) return "(none)";
  const conv = (el as HTMLElement).dataset?.annotationId;
  const closestConv = conv ?? (el.closest("[data-annotation-id]") as HTMLElement | null)?.dataset.annotationId;
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `<${el.tagName.toLowerCase()}${closestConv ? ` conv=${closestConv.slice(0, 8)}` : ""}> "${text}"`;
}
