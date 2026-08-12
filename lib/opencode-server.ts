import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { opencodeMcpConfig } from "./mcp-config";

// Lifecycle for the headless `opencode serve` process.
//
// opencode is used over HTTP rather than by spawning `opencode run` per
// question: the CLI was observed to hang indefinitely on a trivial prompt,
// which would leave a question spinning forever behind a stuck child. A
// long-lived server means one process to look after instead, so this file
// exists to guarantee it is started once and always cleaned up.

// A fixed default port is deliberate: it lets a later boot recognise and adopt
// a server left behind by a hard-killed dev server, instead of spawning a
// second one on a fresh random port every time.
const DEFAULT_PORT = 4599;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 1500;
const KILL_GRACE_MS = 2000;
const IDLE_MS = Number(process.env.OPENCODE_IDLE_MS) || 15 * 60_000;

type State = {
  // null when we adopted a server someone else started — we never kill those
  proc: ChildProcess | null;
  baseUrl: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type Holder = { state: State | null; starting: Promise<string> | null; hooked: boolean };

// Kept on globalThis, not in module scope: Next.js re-evaluates modules on hot
// reload, and a module-scoped singleton would leak one server per reload.
const holder: Holder = ((globalThis as { __paperReaderOpencode?: Holder }).__paperReaderOpencode ??= {
  state: null,
  starting: null,
  hooked: false,
});

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/app`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not find a free port"))));
    });
  });
}

// opencode reads a project config from its working directory, so the Zotero MCP
// is handed over here rather than by editing the user's ~/.config/opencode.
function prepareWorkdir(): string {
  const dir = path.join(tmpdir(), "paper-reader-opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...opencodeMcpConfig() }, null, 2),
    { mode: 0o600 } // may contain the Zotero API key
  );
  return dir;
}

function clearIdle(state: State) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

// Push the idle shutdown out; called on every use
function touch() {
  const state = holder.state;
  if (!state) return;
  clearIdle(state);
  if (!state.proc) return; // an adopted server isn't ours to stop
  state.idleTimer = setTimeout(() => {
    void shutdown();
  }, IDLE_MS);
  state.idleTimer.unref?.();
}

function killProcess(proc: ChildProcess) {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone
  }
}

// Synchronous teardown for process exit, where promises never resolve
function shutdownSync() {
  const state = holder.state;
  holder.state = null;
  if (!state) return;
  clearIdle(state);
  if (state.proc) killProcess(state.proc);
}

export async function shutdown(): Promise<void> {
  const state = holder.state;
  holder.state = null;
  if (!state) return;
  clearIdle(state);
  const proc = state.proc;
  if (!proc || proc.exitCode !== null) return;
  killProcess(proc);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, KILL_GRACE_MS);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function registerExitHooks() {
  if (holder.hooked) return;
  holder.hooked = true;
  // `once` and no process.exit() here: other shutdown handlers (Next's own)
  // still get to run — we only make sure our child doesn't outlive us.
  process.once("exit", shutdownSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, shutdownSync);
  }
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

async function choosePort(): Promise<{ port: number; adopt: boolean }> {
  const preferred = Number(process.env.OPENCODE_PORT) || DEFAULT_PORT;
  const preferredUrl = `http://127.0.0.1:${preferred}`;
  if (await isHealthy(preferredUrl)) return { port: preferred, adopt: true };
  // Not answering: free means we can take it, occupied means something else
  // holds it and we go elsewhere rather than fighting over it.
  if (await isPortFree(preferred)) return { port: preferred, adopt: false };
  return { port: await freePort(), adopt: false };
}

async function start(): Promise<string> {
  const { port, adopt } = await choosePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  if (adopt) {
    holder.state = { proc: null, baseUrl, idleTimer: null };
    touch();
    return baseUrl;
  }

  const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: prepareWorkdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (d: Buffer) => console.error("[opencode serve]", d.toString().slice(0, 400)));
  proc.on("error", (err) => console.error("[opencode spawn error]", err));
  proc.on("exit", (code, signal) => {
    console.error(`[opencode serve] exited (code ${code}, signal ${signal})`);
    // Drop the singleton so the next request starts a fresh one
    if (holder.state?.proc === proc) {
      clearIdle(holder.state);
      holder.state = null;
    }
  });

  holder.state = { proc, baseUrl, idleTimer: null };
  registerExitHooks();

  if (!(await waitForHealthy(baseUrl, READY_TIMEOUT_MS))) {
    await shutdown();
    throw new Error(`opencode server did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }
  touch();
  return baseUrl;
}

// The server's base URL, starting or adopting one if needed. Concurrent callers
// share a single start.
export async function ensureServer(): Promise<string> {
  const current = holder.state;
  if (current) {
    if (await isHealthy(current.baseUrl)) {
      touch();
      return current.baseUrl;
    }
    await shutdown(); // died or wedged — replace it
  }
  holder.starting ??= start().finally(() => {
    holder.starting = null;
  });
  return holder.starting;
}
