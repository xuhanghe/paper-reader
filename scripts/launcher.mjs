// What the launcher (scripts/start.mjs) decides before it starts anything:
// whether the reader is already running, and where Zotero is and how to start
// it. Kept apart from start.mjs so it can be tested without starting either.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The reader already serving from this folder: `next dev` keeps a lock with
 * its process and URL while it runs. A shortcut clicked a second time opens
 * that rather than starting another server, which `next dev` would refuse.
 */
export function runningServer(root, alive = processAlive) {
  try {
    const lock = JSON.parse(readFileSync(join(root, ".next", "dev", "lock"), "utf8"));
    if (typeof lock.appUrl !== "string" || !Number.isInteger(lock.pid)) return null;
    return alive(lock.pid) ? lock.appUrl : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, and someone else's to signal
    return error?.code === "EPERM";
  }
}

// Where Zotero installs itself — the places the setup assistant looks too
// (lib/onboarding.ts, detectZoteroApp)
/** @param {string} [platform] @param {Record<string, string | undefined>} [env] @param {string} [home] */
export function zoteroCandidates(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return ["/Applications/Zotero.app", join(home, "Applications", "Zotero.app")];
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean).map((base) => join(base, "Zotero", "zotero.exe"));
  }
  return [];
}

/** How to start Zotero found at `app`: on macOS behind the browser, not in front of it. */
export function zoteroLaunch(app, platform = process.platform) {
  return platform === "darwin" ? ["open", ["-g", "-a", app]] : [app, []];
}

export async function zoteroRunning(platform = process.platform) {
  try {
    if (platform === "win32") {
      const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq zotero.exe", "/NH"], { timeout: 5000, windowsHide: true });
      return /zotero\.exe/i.test(stdout);
    }
    await run("pgrep", ["-x", "zotero"], { timeout: 5000 });
    return true; // pgrep exits 1 when nothing matches, which rejects
  } catch {
    return false;
  }
}

/**
 * Starts Zotero when it is installed and not already running. Says what it
 * did, in a line for the launcher's console.
 */
export async function startZotero(platform = process.platform) {
  const app = zoteroCandidates(platform).find((candidate) => existsSync(candidate));
  if (!app) return platform === "darwin" || platform === "win32" ? "Zotero isn't installed — the setup assistant in the reader will help." : null;
  if (await zoteroRunning(platform)) return null;
  const [cmd, args] = zoteroLaunch(app, platform);
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return "Starting Zotero…";
}
