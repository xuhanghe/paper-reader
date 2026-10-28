// Keeping the Codex CLI current, so the models it lists stay current.
//
// OpenAI lists a model only to Codex clients new enough to use it. An outdated
// `codex` therefore keeps offering last season's models — while the copy inside
// the ChatGPT app, which updates with the app, already offers the new ones — and
// nothing says why. So whenever the catalog asks Codex for its models it also
// asks npm which version is current, and when the install is one `codex update`
// knows how to update (its standalone installer, npm/bun/pnpm, a Homebrew cask)
// that runs in the background; once it is done the catalog asks the new build.
//
// Copies Paper Reader doesn't own — the one inside ChatGPT.app, an editor
// extension's — are never touched: they update with their app, and the picker
// only says a newer Codex is out. PAPER_READER_CODEX_AUTO_UPDATE=0 turns the
// updating off and keeps the telling.

import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

export type CodexUpdate = {
  // "outdated": a newer Codex is out, but this copy isn't updated from here
  state: "running" | "failed" | "outdated";
  from: string;
  to: string;
  // Whether `codex update` can update this copy
  updatable: boolean;
  detail?: string;
};

const LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const LATEST_TTL_MS = 30 * 60_000;
const LATEST_FAILED_TTL_MS = 5 * 60_000;
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

// ── Versions and installs ────────────────────────────────────────────────

/** The version in a `--version` line: "codex-cli 0.165.0" → "0.165.0", pre-release kept. */
export function parseVersion(line: string | null | undefined): string | undefined {
  return line?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
}

/** Semver order: by number, and a pre-release before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf("-");
    const core = dash < 0 ? v : v.slice(0, dash);
    return { nums: core.split(".").map(Number), pre: dash < 0 ? "" : v.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return Math.sign(x.pre.localeCompare(y.pre, undefined, { numeric: true }));
}

// Where `codex update` has an updater: the standalone installer's packages
// (under CODEX_HOME), a global npm/bun/pnpm package, a Homebrew cask
const SELF_UPDATING = [/\/packages\/standalone\//, /\/node_modules\/@openai\/codex\//, /\/Caskroom\/codex\//];

/** Whether the Codex at this resolved path is one `codex update` updates. */
export function selfUpdatable(resolvedPath: string): boolean {
  const p = resolvedPath.replace(/\\/g, "/");
  return SELF_UPDATING.some((re) => re.test(p));
}

/**
 * The environment `codex update` runs in: the user's own. Never the CODEX_HOME
 * Paper Reader gives its questions — the standalone installer keeps its
 * packages there — and without the npm_* variables `npm run dev` sets, which
 * would point a global npm install at this project.
 */
export function updateEnvironment(env: Env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_/i.test(key))) as NodeJS.ProcessEnv;
}

// ── The updater ──────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export type UpdaterDeps = {
  latest: () => Promise<string | undefined>;
  resolve: (bin: string) => Promise<string>;
  runUpdate: (bin: string) => Promise<void>;
  versionOf: (bin: string) => Promise<string | null>;
  env: () => Env;
  now: () => number;
};

type Holder = {
  latest?: { version?: string; at: number };
  running?: Promise<void>;
  status?: CodexUpdate;
  failed?: { to: string; at: number };
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export function createCodexUpdater(deps: UpdaterDeps, holder: Holder = {}) {
  const latest = async (force: boolean) => {
    const cached = holder.latest;
    const ttl = cached?.version ? LATEST_TTL_MS : LATEST_FAILED_TTL_MS;
    if (!force && cached && deps.now() - cached.at < ttl) return cached.version;
    const version = parseVersion(await deps.latest().catch(() => undefined));
    holder.latest = { version, at: deps.now() };
    return version;
  };

  /**
   * Compares this Codex with the newest release and, when it is behind and can
   * update itself, starts `codex update` — without waiting for it. `onUpdated`
   * runs once that has finished either way. `retry` is someone asking again:
   * it looks the release up afresh and retries an update that failed.
   */
  async function keepCurrent(cli: { path: string; version: string | null }, onUpdated: () => void, retry = false): Promise<void> {
    if (holder.running) return;
    const from = parseVersion(cli.version);
    const to = await latest(retry);
    if (!from || !to) return;
    if (compareVersions(to, from) <= 0) {
      // Up to date, however it got there
      holder.status = undefined;
      holder.failed = undefined;
      return;
    }
    if (holder.running) return;
    const resolved = await deps.resolve(cli.path).catch(() => cli.path);
    if (!selfUpdatable(resolved)) {
      holder.status = { state: "outdated", from, to, updatable: false, detail: "This copy of Codex came with another app and updates with it." };
      return;
    }
    if (deps.env().PAPER_READER_CODEX_AUTO_UPDATE?.trim() === "0") {
      holder.status = { state: "outdated", from, to, updatable: true, detail: "Automatic updates are off (PAPER_READER_CODEX_AUTO_UPDATE=0)." };
      return;
    }
    const failed = holder.failed;
    if (!retry && failed?.to === to && deps.now() - failed.at < RETRY_AFTER_MS) return;

    holder.status = { state: "running", from, to, updatable: true };
    holder.running = (async () => {
      try {
        await deps.runUpdate(cli.path);
        const after = parseVersion(await deps.versionOf(cli.path));
        if (!after || compareVersions(after, to) < 0) {
          throw new Error(`\`codex update\` finished, but Codex still reports ${after ?? "no version"}.`);
        }
        holder.status = undefined;
        holder.failed = undefined;
      } catch (error) {
        holder.failed = { to, at: deps.now() };
        holder.status = { state: "failed", from, to, updatable: true, detail: reason(error) };
      } finally {
        holder.running = undefined;
        onUpdated();
      }
    })();
  }

  return {
    keepCurrent,
    /** What is happening to Codex now, when anything is. */
    status: (): CodexUpdate | undefined => holder.status,
    /** The update in progress, for whoever needs to wait on it. */
    running: () => holder.running,
  };
}

// ── The real thing ───────────────────────────────────────────────────────

const lastLine = (output: string) => output.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";

function runCodexUpdate(bin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ["update"], { env: updateEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("`codex update` took too long and was stopped."));
    }, UPDATE_TIMEOUT_MS);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(lastLine(output) || `\`codex update\` exited (${code}).`));
    });
  });
}

const run = promisify(execFile);

const updater = createCodexUpdater(
  {
    latest: async () => {
      const res = await fetch(LATEST_URL, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : undefined;
    },
    resolve: (bin) => realpath(bin),
    runUpdate: runCodexUpdate,
    versionOf: async (bin) => (await run(bin, ["--version"], { timeout: 8000, windowsHide: true })).stdout,
    env: () => process.env,
    now: () => Date.now(),
  },
  // One updater per server, however many times the module is loaded
  ((globalThis as { __paperReaderCodexUpdate?: Holder }).__paperReaderCodexUpdate ??= {})
);

export const keepCodexCurrent = updater.keepCurrent;
export const codexUpdateStatus = updater.status;
