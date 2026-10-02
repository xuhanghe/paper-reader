// First-run setup, automated as far as a local app can take it.
//
// lib/doctor.ts says what is missing; this module does something about it.
// It finds Zotero itself (the application, its profile, whether its local API
// is switched on, which zotero.org account it syncs with), starts Zotero,
// flips the local-API setting in its profile and restarts it, tells whether a
// coding-agent CLI is signed in, installs one, and opens a terminal on the
// sign-in command a browser login needs. The parsing lives in pure functions
// so the shapes of the files and command outputs are tested without a Zotero
// or a CLI on the machine running the tests.

import { execFile, spawn } from "node:child_process";
import { access, constants, copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { candidateBinPaths, resolveOnPath, type CliId } from "@/lib/doctor";

const run = promisify(execFile);

export type Platform = "mac" | "linux" | "windows" | "other";

export function currentPlatform(): Platform {
  const p = osPlatform();
  return p === "darwin" ? "mac" : p === "linux" ? "linux" : p === "win32" ? "windows" : "other";
}

export const ZOTERO_DOWNLOAD_URL = "https://www.zotero.org/download/";
export const ZOTERO_NEW_KEY_URL = "https://www.zotero.org/settings/keys/new";

// ── Zotero's profile ──────────────────────────────────────────────────────

export type ZoteroProfile = { name: string; path: string; isRelative: boolean; isDefault: boolean };

// profiles.ini is Mozilla's: [ProfileN] sections with Name, Path, IsRelative
// and Default. Sections that are not profiles ([General]) are skipped.
export function parseProfilesIni(text: string): ZoteroProfile[] {
  const profiles: ZoteroProfile[] = [];
  let current: Partial<ZoteroProfile> | null = null;
  const flush = () => {
    if (current?.path) {
      profiles.push({ name: current.name ?? "", path: current.path, isRelative: current.isRelative ?? true, isDefault: current.isDefault ?? false });
    }
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flush();
      current = /^\[Profile\d+\]$/.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "Name") current.name = value;
    else if (key === "Path") current.path = value;
    else if (key === "IsRelative") current.isRelative = value === "1";
    else if (key === "Default") current.isDefault = value === "1";
  }
  flush();
  return profiles;
}

export function pickProfile(profiles: ZoteroProfile[]): ZoteroProfile | null {
  return profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;
}

export function zoteroSupportDir(platform: Platform = currentPlatform(), home: string = homedir()): string | null {
  if (platform === "mac") return path.join(home, "Library", "Application Support", "Zotero");
  if (platform === "linux") return path.join(home, ".zotero", "zotero");
  if (platform === "windows") return process.env.APPDATA ? path.join(process.env.APPDATA, "Zotero", "Zotero") : null;
  return null;
}

// ── prefs.js ──────────────────────────────────────────────────────────────

export const PREF_LOCAL_API = "extensions.zotero.httpServer.localAPI.enabled";
export const PREF_HTTP_SERVER = "extensions.zotero.httpServer.enabled";
export const PREF_SYNC_USERNAME = "extensions.zotero.sync.server.username";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The value of one user_pref line, typed the way prefs.js writes it
export function readPref(prefs: string, name: string): string | number | boolean | null {
  const match = prefs.match(new RegExp(`^user_pref\\("${escapeRegExp(name)}",\\s*(.+?)\\);\\s*$`, "m"));
  if (!match) return null;
  const literal = match[1].trim();
  if (literal === "true") return true;
  if (literal === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(literal)) return Number(literal);
  if (literal.startsWith('"') && literal.endsWith('"')) {
    try { return JSON.parse(literal) as string; } catch { return literal.slice(1, -1); }
  }
  return literal;
}

// The same file with these prefs set: a line is replaced where it exists and
// appended where it does not; everything else is left exactly as Zotero wrote it
export function withPrefs(prefs: string, values: Record<string, string | number | boolean>): string {
  let out = prefs;
  for (const [name, value] of Object.entries(values)) {
    const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
    const line = `user_pref("${name}", ${literal});`;
    const pattern = new RegExp(`^user_pref\\("${escapeRegExp(name)}",.*\\);\\s*$`, "m");
    if (pattern.test(out)) out = out.replace(pattern, line);
    else out = `${out}${out.length && !out.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  return out;
}

export type ZoteroPrefsReport = {
  /** Zotero has a profile on this machine (it has been started at least once) */
  profileFound: boolean;
  prefsFile: string | null;
  /** null when there is no profile to read */
  localApiEnabled: boolean | null;
  /** The zotero.org account the desktop app syncs with, if it syncs */
  syncUsername: string | null;
};

export async function zoteroPrefsReport(platform: Platform = currentPlatform(), home: string = homedir()): Promise<ZoteroPrefsReport> {
  const none: ZoteroPrefsReport = { profileFound: false, prefsFile: null, localApiEnabled: null, syncUsername: null };
  const dir = zoteroSupportDir(platform, home);
  if (!dir) return none;
  const ini = await readFile(path.join(dir, "profiles.ini"), "utf8").catch(() => null);
  if (!ini) return none;
  const profile = pickProfile(parseProfilesIni(ini));
  if (!profile) return none;
  const profileDir = profile.isRelative ? path.join(dir, profile.path) : profile.path;
  const prefsFile = path.join(profileDir, "prefs.js");
  const prefs = await readFile(prefsFile, "utf8").catch(() => null);
  if (prefs === null) return { ...none, profileFound: true, prefsFile };
  const username = readPref(prefs, PREF_SYNC_USERNAME);
  return {
    profileFound: true,
    prefsFile,
    localApiEnabled: readPref(prefs, PREF_LOCAL_API) === true,
    syncUsername: typeof username === "string" && username ? username : null,
  };
}

// ── The application ───────────────────────────────────────────────────────

export type ZoteroAppReport = {
  platform: Platform;
  /** null on a platform this cannot look for it on */
  installed: boolean | null;
  path: string | null;
  version: string | null;
  running: boolean;
  downloadUrl: string;
};

async function exists(file: string): Promise<boolean> {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

async function macAppVersion(app: string): Promise<string | null> {
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents", "Info.plist")], { timeout: 5000 });
    const info = JSON.parse(stdout) as { CFBundleShortVersionString?: string };
    return info.CFBundleShortVersionString ?? null;
  } catch {
    return null;
  }
}

export async function zoteroProcessRunning(platform: Platform = currentPlatform()): Promise<boolean> {
  try {
    if (platform === "windows") {
      const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq zotero.exe"], { timeout: 5000, windowsHide: true });
      return /zotero\.exe/i.test(stdout);
    }
    await run("pgrep", ["-x", "zotero"], { timeout: 5000 });
    return true; // pgrep exits 1 when nothing matches, which rejects
  } catch {
    return false;
  }
}

export async function detectZoteroApp(platform: Platform = currentPlatform(), home: string = homedir()): Promise<ZoteroAppReport> {
  let found: string | null = null;
  let version: string | null = null;
  if (platform === "mac") {
    for (const candidate of ["/Applications/Zotero.app", path.join(home, "Applications", "Zotero.app")]) {
      if (await exists(candidate)) { found = candidate; version = await macAppVersion(candidate); break; }
    }
  } else if (platform === "linux") {
    found = await resolveOnPath("zotero");
    if (!found) {
      for (const candidate of [path.join(home, "Zotero_linux-x86_64", "zotero"), "/opt/zotero/zotero", "/usr/lib/zotero/zotero", "/usr/local/bin/zotero"]) {
        if (await exists(candidate)) { found = candidate; break; }
      }
    }
  } else if (platform === "windows") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      const candidate = path.join(base, "Zotero", "zotero.exe");
      if (await exists(candidate)) { found = candidate; break; }
    }
  }
  return {
    platform,
    installed: platform === "other" ? null : found !== null,
    path: found,
    version,
    running: await zoteroProcessRunning(platform),
    downloadUrl: ZOTERO_DOWNLOAD_URL,
  };
}

export async function launchZotero(app: ZoteroAppReport): Promise<void> {
  if (app.platform === "mac") {
    await run("open", ["-a", app.path ?? "Zotero"], { timeout: 10000 });
    return;
  }
  if (!app.path) throw new Error("Zotero's executable was not found.");
  const child = spawn(app.path, [], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function quitZotero(platform: Platform = currentPlatform()): Promise<void> {
  if (platform === "mac") {
    await run("osascript", ["-e", 'tell application "Zotero" to quit'], { timeout: 10000 });
  } else if (platform === "windows") {
    await run("taskkill", ["/IM", "zotero.exe"], { timeout: 10000, windowsHide: true });
  } else {
    await run("pkill", ["-TERM", "-x", "zotero"], { timeout: 10000 });
  }
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return check();
}

export type EnableLocalApiResult = { ok: boolean; steps: string[]; problem: string | null };

// Zotero reads prefs.js when it starts and rewrites it when it quits, so the
// setting is changed only while it is closed: quit, edit, start, wait for the
// API to answer. The file is backed up first; it is the user's, not ours.
export async function enableLocalApi(apiAnswers: () => Promise<boolean>): Promise<EnableLocalApiResult> {
  const steps: string[] = [];
  if (await apiAnswers()) return { ok: true, steps: ["Zotero's local API already answers."], problem: null };
  const app = await detectZoteroApp();
  if (app.installed === false) {
    return { ok: false, steps, problem: "Zotero isn't installed on this machine." };
  }
  const prefs = await zoteroPrefsReport();
  if (!prefs.prefsFile) {
    return { ok: false, steps, problem: "Zotero has no profile yet. Start it once, let it finish opening, then try again." };
  }
  if (await zoteroProcessRunning(app.platform)) {
    steps.push("Asked Zotero to quit");
    try { await quitZotero(app.platform); } catch { /* reported below when it stays up */ }
    const gone = await waitUntil(async () => !(await zoteroProcessRunning(app.platform)), 25000);
    if (!gone) {
      return { ok: false, steps, problem: "Zotero didn't quit — it may be asking you something. Close it yourself, then try again." };
    }
    steps.push("Zotero closed");
  }
  const existing = await readFile(prefs.prefsFile, "utf8").catch(() => "");
  await copyFile(prefs.prefsFile, `${prefs.prefsFile}.paper-reader.bak`).catch(() => {});
  await writeFile(prefs.prefsFile, withPrefs(existing, { [PREF_HTTP_SERVER]: true, [PREF_LOCAL_API]: true }));
  steps.push("Switched the local API on in Zotero's settings");
  try {
    await launchZotero(app);
    steps.push("Started Zotero");
  } catch {
    return { ok: false, steps, problem: "The setting is saved, but Zotero couldn't be started from here. Start it yourself and re-check." };
  }
  if (!(await waitUntil(apiAnswers, 45000, 1000))) {
    return { ok: false, steps, problem: "Zotero is starting, but its local API hasn't answered yet. Give it a moment and re-check." };
  }
  steps.push("The local API answers");
  return { ok: true, steps, problem: null };
}

// ── Coding-agent CLIs: signed in? ─────────────────────────────────────────

export type CliAuth = {
  /** null when the tool has no way to tell */
  loggedIn: boolean | null;
  account: string | null;
};

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// `claude auth status` prints JSON; older builds print prose
export function parseClaudeAuth(stdout: string): CliAuth {
  try {
    const data = JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
    return { loggedIn: data.loggedIn === true, account: data.email ?? null };
  } catch {
    const text = stripAnsi(stdout);
    if (/not logged in|logged out/i.test(text)) return { loggedIn: false, account: null };
    if (/logged in/i.test(text)) return { loggedIn: true, account: text.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null };
    return { loggedIn: null, account: null };
  }
}

// `codex login status`: "Logged in using ChatGPT" or "Not logged in"
export function parseCodexLogin(output: string): CliAuth {
  const text = stripAnsi(output);
  if (/not logged in/i.test(text)) return { loggedIn: false, account: null };
  if (/logged in/i.test(text)) return { loggedIn: true, account: text.match(/logged in (?:using|as|with) (.+)/i)?.[1]?.trim() ?? null };
  return { loggedIn: null, account: null };
}

// `opencode auth list`: one "●" line per provider with stored credentials
export function parseOpencodeAuth(output: string): CliAuth {
  const providers = stripAnsi(output).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("●")).map((l) => l.replace(/^●\s*/, "").replace(/\s+(api|oauth)\s*$/i, "").trim());
  if (providers.length === 0) return { loggedIn: false, account: null };
  return { loggedIn: true, account: providers.join(", ") };
}

const AUTH_ARGS: Record<CliId, string[] | null> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
  opencode: ["auth", "list"],
  "zotero-mcp": null,
};

export async function cliAuth(id: CliId, bin: string): Promise<CliAuth> {
  const args = AUTH_ARGS[id];
  if (!args) return { loggedIn: null, account: null };
  let output = "";
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 15000, windowsHide: true, env: withUserPath() });
    output = `${stdout}\n${stderr}`;
  } catch (e) {
    // "not logged in" is often a non-zero exit with the answer on stdout
    const err = e as { stdout?: string; stderr?: string };
    output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    if (!output.trim()) return { loggedIn: null, account: null };
  }
  if (id === "claude") return parseClaudeAuth(output.trim());
  if (id === "codex") return parseCodexLogin(output);
  return parseOpencodeAuth(output);
}

export const LOGIN_COMMANDS: Record<CliId, string[] | null> = {
  claude: ["auth", "login"],
  codex: ["login"],
  opencode: ["auth", "login"],
  "zotero-mcp": null,
};

// ── Installing a CLI ──────────────────────────────────────────────────────

export type InstallerTool = "npm" | "uv" | "brew";
export type Installer = { tool: InstallerTool; args: string[]; display: string };

export const INSTALLERS: Record<CliId, Installer> = {
  claude: { tool: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"], display: "npm install -g @anthropic-ai/claude-code" },
  codex: { tool: "npm", args: ["install", "-g", "@openai/codex"], display: "npm install -g @openai/codex" },
  opencode: { tool: "brew", args: ["install", "sst/tap/opencode"], display: "brew install sst/tap/opencode" },
  "zotero-mcp": { tool: "uv", args: ["tool", "install", "zotero-mcp"], display: "uv tool install zotero-mcp" },
};

// The server's PATH is often the bare one a desktop session hands out; the
// user's tools live in the places doctor.ts already knows to look
export function withUserPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): NodeJS.ProcessEnv {
  const extra = candidateBinPaths("x", home).map((p) => path.dirname(p));
  const current = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...current, ...extra.filter((d) => !current.includes(d))];
  return { ...env, PATH: merged.join(path.delimiter) };
}

export async function findTool(name: string, home: string = homedir()): Promise<string | null> {
  const onPath = await resolveOnPath(name);
  if (onPath) return onPath;
  for (const candidate of candidateBinPaths(name, home)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export type InstallResult = { ok: boolean; command: string; output: string; problem: string | null };

export async function installCli(id: CliId): Promise<InstallResult> {
  const installer = INSTALLERS[id];
  const tool = await findTool(installer.tool);
  if (!tool) {
    const need = installer.tool === "npm" ? "Node.js (which brings npm)" : installer.tool === "uv" ? "uv (astral.sh/uv)" : "Homebrew (brew.sh)";
    return { ok: false, command: installer.display, output: "", problem: `This install needs ${need}, which isn't on this machine.` };
  }
  const tail = (s: string) => s.trim().split(/\r?\n/).slice(-12).join("\n");
  try {
    const { stdout, stderr } = await run(tool, installer.args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: withUserPath() });
    return { ok: true, command: installer.display, output: tail(`${stdout}\n${stderr}`), problem: null };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`) || (err.message ?? "");
    const permission = /EACCES|permission denied/i.test(output);
    return {
      ok: false,
      command: installer.display,
      output,
      problem: permission
        ? "The install needs permissions this server doesn't have. Run the command in your own terminal."
        : "The install didn't finish. The last lines of its output are below.",
    };
  }
}

// ── A terminal, for the sign-ins only a browser can finish ────────────────

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function loginCommandLine(bin: string, id: CliId): string | null {
  const args = LOGIN_COMMANDS[id];
  if (!args) return null;
  return [bin, ...args].map(shellQuote).join(" ");
}

// Opens the user's terminal on a command. The login flows of these CLIs open
// a browser and wait for it, which a server process cannot stand in for.
export async function openTerminalWith(command: string, platform: Platform = currentPlatform()): Promise<boolean> {
  try {
    if (platform === "mac") {
      await run("osascript", [
        "-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`,
        "-e", 'tell application "Terminal" to activate',
      ], { timeout: 10000 });
      return true;
    }
    if (platform === "linux") {
      const script = `${command}; exec "$SHELL"`;
      for (const [term, args] of [
        ["x-terminal-emulator", ["-e", "bash", "-c", script]],
        ["gnome-terminal", ["--", "bash", "-c", script]],
        ["konsole", ["-e", "bash", "-c", script]],
        ["xterm", ["-e", "bash", "-c", script]],
      ] as const) {
        const found = await resolveOnPath(term);
        if (!found) continue;
        const child = spawn(found, [...args], { detached: true, stdio: "ignore" });
        child.unref();
        return true;
      }
      return false;
    }
    if (platform === "windows") {
      const child = spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", command], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
