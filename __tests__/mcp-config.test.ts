import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { zoteroMcpServer, codexMcpArgs, opencodeMcpConfig } from "../lib/mcp-config.js";

// process.execPath always exists, so it stands in for an installed zotero-mcp
const REAL_BIN = process.execPath;

beforeEach(() => {
  process.env.ZOTERO_MCP_BIN = REAL_BIN;
  process.env.ZOTERO_API_KEY = "test-key";
  delete process.env.ZOTERO_LIBRARY_ID;
});

describe("zoteroMcpServer", () => {
  test("runs the binary's serve subcommand", () => {
    // without it the CLI prints usage and no MCP server ever starts
    assert.deepEqual(zoteroMcpServer()?.args, ["serve"]);
  });

  test("passes the local-library env through", () => {
    assert.deepEqual(zoteroMcpServer()?.env, {
      ZOTERO_LOCAL: "true",
      ZOTERO_LIBRARY_ID: "0",
      ZOTERO_API_KEY: "test-key",
    });
  });

  test("omits the API key when none is configured", () => {
    delete process.env.ZOTERO_API_KEY;
    assert.equal("ZOTERO_API_KEY" in (zoteroMcpServer()?.env ?? {}), false);
  });

  test("is absent when the binary isn't installed, so providers spawn unchanged", () => {
    process.env.ZOTERO_MCP_BIN = "/nonexistent/zotero-mcp";
    assert.equal(zoteroMcpServer(), null);
    assert.deepEqual(codexMcpArgs(), []);
    assert.deepEqual(opencodeMcpConfig(), {});
  });
});

describe("codexMcpArgs", () => {
  test("renders dotted-path config overrides", () => {
    const args = codexMcpArgs();
    const pairs = args.filter((_, i) => i % 2 === 1);
    assert.deepEqual(
      args.filter((_, i) => i % 2 === 0),
      new Array(pairs.length).fill("-c")
    );
    assert.ok(pairs.includes(`mcp_servers.zotero.command="${REAL_BIN}"`));
    assert.ok(pairs.includes(`mcp_servers.zotero.args=["serve"]`), `got ${pairs.join(" ")}`);
    assert.ok(pairs.includes(`mcp_servers.zotero.env.ZOTERO_LOCAL="true"`));
  });
});

describe("opencodeMcpConfig", () => {
  test("renders a local MCP entry with the command as an argv array", () => {
    const cfg = opencodeMcpConfig() as { mcp: Record<string, Record<string, unknown>> };
    assert.deepEqual(cfg.mcp.zotero.command, [REAL_BIN, "serve"]);
    assert.equal(cfg.mcp.zotero.type, "local");
    assert.equal(cfg.mcp.zotero.enabled, true);
  });
});
