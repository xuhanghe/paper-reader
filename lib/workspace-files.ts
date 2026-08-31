import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const IGNORED = new Set([".git", "node_modules", ".next", ".paper-reader-sessions"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type WorkspaceFile = {
  path: string;
  name: string;
  kind: "file" | "directory";
  extension?: string;
  size?: number;
};

export function expandWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export async function validateWorkspaceRoot(value: string, create = false): Promise<string> {
  if (!value?.trim()) throw new Error("Choose a working directory.");
  const root = expandWorkspacePath(value);
  if (root === path.parse(root).root || root === homedir()) {
    throw new Error("Choose a dedicated project directory, not the filesystem or home directory.");
  }
  if (create) await mkdir(root, { recursive: true });
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error("That directory does not exist.");
  return await realpath(root);
}

export async function resolveWorkspaceFile(rootValue: string, relativeValue: string): Promise<{ root: string; file: string; relative: string }> {
  const root = await validateWorkspaceRoot(rootValue);
  const relative = relativeValue.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").includes("..")) throw new Error("Invalid workspace file path.");
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("File is outside the workspace.");
  return { root, file, relative };
}

async function walk(root: string, dir: string, depth: number): Promise<WorkspaceFile[]> {
  if (depth > 3) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const result: WorkspaceFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      result.push({ path: relative, name: entry.name, kind: "directory" });
      result.push(...await walk(root, absolute, depth + 1));
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      result.push({ path: relative, name: entry.name, kind: "file", extension: path.extname(entry.name).slice(1).toLowerCase(), size: info.size });
    }
  }
  return result;
}

export async function listWorkspaceFiles(rootValue: string): Promise<WorkspaceFile[]> {
  const root = await validateWorkspaceRoot(rootValue);
  return walk(root, root, 0);
}

export async function readWorkspaceText(rootValue: string, relative: string): Promise<string> {
  const { file } = await resolveWorkspaceFile(rootValue, relative);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That path is not a file.");
  if (info.size > MAX_TEXT_BYTES) throw new Error("This file is too large to edit in the workspace.");
  return readFile(file, "utf8");
}

export async function writeWorkspaceText(rootValue: string, relative: string, content: string): Promise<void> {
  const { file } = await resolveWorkspaceFile(rootValue, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}
