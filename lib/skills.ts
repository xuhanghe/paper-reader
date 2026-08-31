import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type InstalledSkill = {
  id: string;
  name: string;
  description: string;
  source: "project" | "personal" | "system";
  path: string;
};

const SEARCH_ROOTS: Array<{ root: string; source: InstalledSkill["source"] }> = [
  { root: path.join(process.cwd(), ".agents", "skills"), source: "project" },
  { root: path.join(process.cwd(), ".codex", "skills"), source: "project" },
  { root: path.join(homedir(), ".agents", "skills"), source: "personal" },
  { root: path.join(homedir(), ".codex", "skills"), source: "system" },
  { root: path.join(homedir(), ".codex", "plugins", "cache"), source: "system" },
];

async function skillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 7) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const direct = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (direct) return [path.join(root, direct.name)];
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && (!entry.name.startsWith(".") || entry.name === ".system"))
        .map((entry) => skillFiles(path.join(root, entry.name), depth + 1))
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function frontmatter(raw: string): { name?: string; description?: string } {
  const block = /^---\s*\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block);
    if (!match) return undefined;
    const first = match[1].trim();
    if ([">", ">-", "|", "|-"].includes(first)) {
      const rest = block.slice(match.index + match[0].length).split("\n");
      const lines: string[] = [];
      for (const line of rest) {
        if (lines.length === 0 && !line.trim()) continue;
        if (!/^\s+/.test(line)) break;
        lines.push(line.trim());
      }
      return lines.filter(Boolean).join(first.startsWith("|") ? "\n" : " ");
    }
    return first?.replace(/^['"]|['"]$/g, "");
  };
  return { name: value("name"), description: value("description") };
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const found: InstalledSkill[] = [];
  for (const { root, source } of SEARCH_ROOTS) {
    for (const file of await skillFiles(root)) {
      try {
        const raw = await readFile(file, "utf8");
        const meta = frontmatter(raw);
        const folder = path.basename(path.dirname(file));
        const name = meta.name || folder;
        found.push({
          id: `${source}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name,
          description: meta.description || "Installed agent workflow",
          source,
          path: file,
        });
      } catch {
        // A malformed skill should not hide the rest of the catalog.
      }
    }
  }

  const unique = new Map<string, InstalledSkill>();
  for (const skill of found) {
    const key = skill.name.toLowerCase();
    if (!unique.has(key)) unique.set(key, skill);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function selectedSkillPaths(ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string").slice(0, 12));
  if (!wanted.size) return [];
  return (await listInstalledSkills()).filter((skill) => wanted.has(skill.id)).map((skill) => skill.path);
}
