import { HOME } from "@/lib/home";
import { access, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const IGNORED = new Set([".git", "node_modules", ".next", ".paper-reader-sessions"]);
const BROAD_HOME_DIRECTORIES = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
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

export async function validateWorkspaceTrashTarget(value: string, confirmation: string): Promise<string> {
  const root = await validateWorkspaceRoot(value);
  const confirmed = expandWorkspacePath(confirmation);
  if (confirmed !== root) throw new Error("The confirmed directory does not match this workspace.");

  const appRoot = await realpath(HOME);
  if (root === appRoot || appRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("Paper Reader cannot move its own project directory or a parent directory to Trash.");
  }

  const homeRelative = path.relative(homedir(), root);
  if (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)) {
    const parts = homeRelative.split(path.sep).filter(Boolean);
    if (parts.length === 1 && BROAD_HOME_DIRECTORIES.has(parts[0])) throw new Error("Choose a dedicated project folder, not a broad home folder such as Desktop or Documents.");
  } else {
    const parts = root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean);
    if (parts.length < 3) throw new Error("This directory is too broad to move to Trash from Paper Reader.");
  }
  return root;
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
  for (const entry of entries.sort((a, b) => {
    const kindOrder = Number(b.isDirectory()) - Number(a.isDirectory());
    return kindOrder || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  })) {
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

export async function createWorkspaceDirectory(rootValue: string, relative: string): Promise<string> {
  const { file, relative: safeRelative } = await resolveWorkspaceFile(rootValue, relative);
  if (await access(file).then(() => true).catch(() => false)) {
    throw new Error(`“${safeRelative}” already exists in this workspace.`);
  }
  await mkdir(file, { recursive: true });
  return safeRelative;
}

export async function moveWorkspaceFile(rootValue: string, fromRelative: string, toDirectoryRelative = ""): Promise<string> {
  const root = await validateWorkspaceRoot(rootValue);
  const { file: source, relative: from } = await resolveWorkspaceFile(root, fromRelative);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error("Only files can be moved in the workspace explorer.");

  const targetDirectory = toDirectoryRelative
    ? (await resolveWorkspaceFile(root, toDirectoryRelative)).file
    : root;
  const targetInfo = await stat(targetDirectory).catch(() => null);
  if (!targetInfo?.isDirectory()) throw new Error("The drop target is not a directory.");

  const destination = path.join(targetDirectory, path.basename(source));
  const relative = path.relative(root, destination).split(path.sep).join("/");
  if (relative === from) return relative;
  if (await access(destination).then(() => true).catch(() => false)) {
    throw new Error(`A file named “${path.basename(source)}” already exists in that directory.`);
  }

  await rename(source, destination);
  return relative;
}
