// Paper Reader talks to Codex only through the documented non-interactive
// `codex exec` interface. Keep the CLI's mutable state separate from the
// desktop app: two independently updated Codex builds must never take turns
// writing private caches that the other one then has to parse.

import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SHARED_ENTRIES = ["auth.json", "skills", "plugins", "AGENTS.md"] as const;
const SESSION_PREFIX = "paper-reader-codex-v1:";

function pathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function paperReaderCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const configured = env.PAPER_READER_CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Paper Reader", "codex");
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "Paper Reader", "codex");
  }
  return path.join(env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"), "paper-reader", "codex");
}

/**
 * Build the environment for a headless Codex child.
 *
 * CODEX_HOME is a public Codex setting. The isolated home owns caches, logs,
 * and Paper Reader sessions. Authentication and installed capabilities are
 * linked from the user's normal Codex home, so this does not copy credentials
 * into the repository and does not depend on any cache file or cache schema.
 */
export function prepareCodexEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): NodeJS.ProcessEnv {
  const sourceHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const runtimeHome = paperReaderCodexHome(env, platform, home);
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });

  if (path.resolve(sourceHome) !== path.resolve(runtimeHome)) {
    for (const name of SHARED_ENTRIES) {
      const source = path.join(sourceHome, name);
      const target = path.join(runtimeHome, name);
      if (!existsSync(source) || pathExists(target)) continue;
      const type = name === "skills" || name === "plugins"
        ? (platform === "win32" ? "junction" : "dir")
        : "file";
      symlinkSync(source, target, type);
    }
  }

  return { ...env, CODEX_HOME: runtimeHome };
}

// Session ids stored before Paper Reader got its isolated CODEX_HOME point at
// a different state store and cannot be resumed there. Tag ids created by this
// runtime so old conversations start one fresh headless session, then resume
// normally without inspecting Codex's private session files.
export function encodeCodexSessionId(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

export function decodeCodexSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(SESSION_PREFIX)) return undefined;
  const id = value.slice(SESSION_PREFIX.length).trim();
  return id || undefined;
}
