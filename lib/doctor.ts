// Setup diagnostics: what the reader needs, and whether this machine has it.
//
// Two failures dominate first-run confusion, and neither surfaces anywhere
// useful today. Zotero's local API is off until a checkbox is ticked, and the
// zotero.org key that highlight sync needs is a separate thing entirely — easy
// to create without write access, which fails silently later. And a provider
// CLI can be perfectly installed yet invisible to the server: `npm run dev`
// launched from a GUI or an IDE terminal inherits a PATH without the user's
// shell additions, so a real `codex` in ~/.local/bin simply is not found.
//
// Detection therefore never trusts PATH alone — when a lookup fails it probes
// the places these tools actually install to, so the report can say "installed
// at X, but the server can't see it" instead of "not installed".

import { execFile } from "node:child_process";
import { access, chmod, constants, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { claudeBin, codexBin, opencodeBin } from "@/lib/bin";
import { ZOTERO_BASE, CONNECTOR_BASE, webApiKey } from "@/lib/zotero-server";

const run = promisify(execFile);

export type CliId = "claude" | "codex" | "opencode" | "zotero-mcp";

export type CliReport = {
  id: CliId;
  label: string;
  required: boolean;
  found: boolean;
  /** Absolute path when we resolved one, else the bare name we tried */
  path: string;
  version: string | null;
  /** How it was found — "probed" means installed but off the server's PATH */
  source: "env" | "path" | "probed" | null;
  envVar: string;
  install: string;
  note: string | null;
};

// Where these CLIs actually land. Kept ordered by likelihood so the first hit
// is the one a user would most expect.
export function candidateBinPaths(name: string, home?: string): string[] {
  const base = home ?? homedir();
  const dirs = [
    path.join(base, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(base, ".bun", "bin"),
    path.join(base, ".deno", "bin"),
    path.join(base, ".volta", "bin"),
    path.join(base, ".npm-global", "bin"),
    path.join(base, "Library", "pnpm"),
    path.join(base, ".cargo", "bin"),
    "/usr/bin",
  ];
  return dirs.map((dir) => path.join(dir, name));
}

// Not every tool speaks `--version` (zotero-mcp uses a `version` subcommand),
// so the argv is per-tool and a failure here is never taken as "not installed"
// — presence of the executable is what we are actually detecting.
async function versionOf(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(bin, args, { timeout: 8000, windowsHide: true });
    return stdout.trim().split("\n")[0].slice(0, 80) || null;
  } catch {
    return null;
  }
}

// A bare command name has to be resolved before it can be stat'd. Mirrors
// what spawn() would do, so a hit here means the server really can run it.
async function resolveOnPath(name: string): Promise<string | null> {
  if (name.includes("/")) return (await isExecutable(name)) ? name : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const CLI_META: Record<CliId, { label: string; envVar: string; install: string; required: boolean; versionArgs: string[] }> = {
  claude: {
    versionArgs: ["--version"],
    label: "Claude Code",
    envVar: "CLAUDE_BIN",
    install: "npm install -g @anthropic-ai/claude-code",
    required: false,
  },
  codex: {
    versionArgs: ["--version"],
    label: "Codex",
    envVar: "CODEX_BIN",
    install: "npm install -g @openai/codex",
    required: false,
  },
  opencode: {
    versionArgs: ["--version"],
    label: "OpenCode",
    envVar: "OPENCODE_BIN",
    install: "brew install sst/tap/opencode",
    required: false,
  },
  "zotero-mcp": {
    // argparse subcommand, not a flag — `--version` exits nonzero here
    versionArgs: ["version"],
    label: "Zotero MCP",
    envVar: "ZOTERO_MCP_BIN",
    install: "uv tool install zotero-mcp",
    required: false,
  },
};

// `home` is injectable so tests can point the install-location probe at a
// temp directory — otherwise a machine that really has these CLIs installed
// can never exercise the not-found branch.
export async function detectCli(id: CliId, home?: string): Promise<CliReport> {
  const meta = CLI_META[id];
  const configured =
    id === "claude" ? claudeBin()
    : id === "codex" ? codexBin()
    : id === "opencode" ? opencodeBin()
    : process.env.ZOTERO_MCP_BIN?.trim() || "zotero-mcp";
  const fromEnv = !!process.env[meta.envVar]?.trim();

  const describe = (
    found: boolean, binPath: string, version: string | null,
    source: CliReport["source"], note: string | null
  ): CliReport => ({
    id, label: meta.label, required: meta.required, found, path: binPath,
    version, source, envVar: meta.envVar, install: meta.install, note,
  });

  // Whatever is configured (or the bare name on PATH) gets first say
  const resolved = await resolveOnPath(configured);
  if (resolved) {
    return describe(true, resolved, await versionOf(resolved, meta.versionArgs), fromEnv ? "env" : "path", null);
  }

  // Not runnable from here — look where it would have been installed
  for (const candidate of candidateBinPaths(id, home)) {
    if (!(await isExecutable(candidate))) continue;
    // Two different causes reach here, and blaming the wrong one sends the
    // user to fix something that isn't broken
    return describe(
      true, candidate, await versionOf(candidate, meta.versionArgs), "probed",
      fromEnv
        ? `${meta.envVar} points somewhere unusable, but a working copy is installed here.`
        : `Installed, but not on the PATH this server inherited. Save ${meta.envVar} so it can be spawned.`
    );
  }

  return describe(false, configured, null, null,
    fromEnv ? `${meta.envVar} is set but nothing runnable is there.` : null);
}

export type ZoteroLocalReport = {
  reachable: boolean;
  /** Zotero answers on its port but the local API is switched off */
  runningButApiOff: boolean;
  url: string;
};

export async function detectZoteroLocal(): Promise<ZoteroLocalReport> {
  const ping = async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  };
  const reachable = await ping(`${ZOTERO_BASE}/collections?limit=1`);
  // The connector endpoint stays up even when "allow other applications" is
  // off, so it separates "Zotero isn't running" from "the API is disabled"
  const connector = reachable ? true : await ping(`${CONNECTOR_BASE}/connector/ping`);
  return { reachable, runningButApiOff: !reachable && connector, url: ZOTERO_BASE };
}

export type ZoteroKeyReport = {
  configured: boolean;
  valid: boolean;
  canWrite: boolean;
  username: string | null;
  userId: string | null;
  problem: string | null;
};

// Pure interpretation of api.zotero.org's key response, split out so the
// rules are testable without a network round trip.
export function readKeyResponse(status: number, body: unknown): ZoteroKeyReport {
  if (status === 404 || status === 403) {
    return { configured: true, valid: false, canWrite: false, username: null, userId: null,
      problem: "Zotero doesn't recognise this key. It may have been deleted or mistyped." };
  }
  if (status !== 200 || !body || typeof body !== "object") {
    return { configured: true, valid: false, canWrite: false, username: null, userId: null,
      problem: `Couldn't check the key with zotero.org (HTTP ${status}).` };
  }
  const data = body as { username?: string; userID?: number | string; access?: { user?: { library?: boolean; write?: boolean } } };
  const user = data.access?.user ?? {};
  const canWrite = user.write === true && user.library === true;
  return {
    configured: true,
    valid: true,
    canWrite,
    username: data.username ?? null,
    userId: data.userID != null ? String(data.userID) : null,
    problem: canWrite ? null
      : "This key is read-only. Highlights will stay in the session instead of syncing — edit the key on zotero.org and allow library write access.",
  };
}

export async function detectZoteroKey(): Promise<ZoteroKeyReport> {
  const key = webApiKey();
  if (!key) {
    return { configured: false, valid: false, canWrite: false, username: null, userId: null, problem: null };
  }
  try {
    const res = await fetch(`https://api.zotero.org/keys/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return readKeyResponse(res.status, body);
  } catch {
    return { configured: true, valid: false, canWrite: false, username: null, userId: null,
      problem: "Couldn't reach zotero.org to check the key — offline?" };
  }
}

// ── writing settings back to .env.local ───────────────────────────────────

export const WRITABLE_SETTINGS = ["ZOTERO_API_KEY", "CLAUDE_BIN", "CODEX_BIN", "OPENCODE_BIN", "ZOTERO_MCP_BIN"] as const;
export type WritableSetting = (typeof WRITABLE_SETTINGS)[number];

export function isWritableSetting(name: unknown): name is WritableSetting {
  return typeof name === "string" && (WRITABLE_SETTINGS as readonly string[]).includes(name);
}

// Replace the line if the variable is already there, otherwise append. Other
// lines and comments are preserved — this file is the user's, not ours.
export function applyEnvLine(existing: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(existing)) return existing.replace(pattern, line);
  const separator = existing.length && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${separator}${line}\n`;
}

export async function saveSetting(name: WritableSetting, value: string): Promise<void> {
  const file = path.join(process.cwd(), ".env.local");
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, applyEnvLine(existing, name, value), { mode: 0o600 });
  // writeFile's mode only applies when it creates the file, so an existing
  // .env.local would keep whatever permissions it had — and this one holds an
  // API key. Set them explicitly.
  await chmod(file, 0o600).catch(() => {});
}
