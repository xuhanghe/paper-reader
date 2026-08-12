import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// The Zotero MCP server, handed to every CLI provider per invocation.
//
// It is deliberately not read from the user's global CLI configs: the entry in
// ~/.claude.json is scoped to a different project directory, codex has no
// zotero entry, and opencode has no MCP servers at all — so relying on those
// meant no provider could actually see the library. Everything here is derived
// from .env.local instead, which keeps the credentials in one place and leaves
// the user's own tool configuration untouched.

const SERVER_NAME = "zotero";
// zotero-mcp installs to ~/.local/bin, which is usually absent from the PATH a
// Next.js server inherits from a desktop session — resolve it ourselves.
const DEFAULT_BIN = path.join(homedir(), ".local", "bin", "zotero-mcp");

export type McpServer = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

// The configured Zotero MCP server, or null when it isn't usable. Callers treat
// null as "spawn exactly as before" — the MCP is additive, never a hard
// dependency, so a missing binary can't stop the reader from answering.
export function zoteroMcpServer(): McpServer | null {
  const bin = process.env.ZOTERO_MCP_BIN || DEFAULT_BIN;
  if (!existsSync(bin)) return null;
  const env: Record<string, string> = {
    ZOTERO_LOCAL: "true",
    ZOTERO_LIBRARY_ID: process.env.ZOTERO_LIBRARY_ID || "0",
  };
  if (process.env.ZOTERO_API_KEY) env.ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
  // `serve` is the stdio-server subcommand; without it the binary prints usage
  return { name: SERVER_NAME, command: bin, args: ["serve"], env };
}

// ── Per-provider rendering ──────────────────────────────────────────

// Claude reads MCP servers from JSON files passed with --mcp-config. The file
// is written once per boot rather than per request; --strict-mcp-config then
// keeps the user's own (differently scoped) servers out of the picture, so the
// reader behaves the same regardless of what else is configured.
let claudeConfigPath: string | null = null;

export function claudeMcpArgs(): string[] {
  const server = zoteroMcpServer();
  if (!server) return [];
  if (!claudeConfigPath) {
    const dir = path.join(tmpdir(), "paper-reader-mcp");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude-mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [server.name]: { command: server.command, args: server.args, env: server.env },
        },
      }),
      { mode: 0o600 } // contains the Zotero API key
    );
    claudeConfigPath = file;
  }
  return ["--mcp-config", claudeConfigPath, "--strict-mcp-config"];
}

// Codex takes dotted-path overrides of its TOML config, the same mechanism
// already used for model_reasoning_effort.
export function codexMcpArgs(): string[] {
  const server = zoteroMcpServer();
  if (!server) return [];
  const base = `mcp_servers.${server.name}`;
  const argList = server.args.map((a) => `"${a}"`).join(",");
  const args = ["-c", `${base}.command="${server.command}"`, "-c", `${base}.args=[${argList}]`];
  for (const [key, value] of Object.entries(server.env)) {
    args.push("-c", `${base}.env.${key}="${value}"`);
  }
  return args;
}

// opencode reads a project-level opencode.json from its working directory, so
// the server gets one written into its scratch dir — no edit to the user's
// ~/.config/opencode/opencode.jsonc.
export function opencodeMcpConfig(): Record<string, unknown> {
  const server = zoteroMcpServer();
  if (!server) return {};
  return {
    mcp: {
      [server.name]: {
        type: "local",
        command: [server.command, ...server.args],
        environment: server.env,
        enabled: true,
      },
    },
  };
}
