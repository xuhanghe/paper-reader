import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEnvLine, candidateBinPaths, detectCli, isWritableSetting, readKeyResponse } from "../lib/doctor.js";

describe("candidateBinPaths", () => {
  test("covers where these CLIs actually install", () => {
    const paths = candidateBinPaths("codex", "/home/u");
    assert.ok(paths.includes("/home/u/.local/bin/codex"));
    assert.ok(paths.includes("/opt/homebrew/bin/codex"));
    assert.ok(paths.includes("/usr/local/bin/codex"));
  });
});

describe("readKeyResponse", () => {
  test("a write-enabled key is usable", () => {
    const report = readKeyResponse(200, {
      username: "ada", userID: 42, access: { user: { library: true, write: true } },
    });
    assert.equal(report.valid, true);
    assert.equal(report.canWrite, true);
    assert.equal(report.username, "ada");
    assert.equal(report.userId, "42");
    assert.equal(report.problem, null);
  });

  test("a read-only key is valid but flagged — highlights would silently not sync", () => {
    const report = readKeyResponse(200, { username: "ada", access: { user: { library: true, write: false } } });
    assert.equal(report.valid, true);
    assert.equal(report.canWrite, false);
    assert.match(report.problem ?? "", /read-only/);
  });

  test("404 means the key is wrong, not that zotero.org is down", () => {
    const report = readKeyResponse(404, null);
    assert.equal(report.valid, false);
    assert.match(report.problem ?? "", /doesn't recognise/);
  });

  test("an unexpected status is reported as a check failure", () => {
    assert.match(readKeyResponse(500, null).problem ?? "", /HTTP 500/);
  });
});

describe("applyEnvLine", () => {
  test("replaces an existing value in place", () => {
    const out = applyEnvLine("A=1\nZOTERO_API_KEY=old\nB=2\n", "ZOTERO_API_KEY", "new");
    assert.equal(out, "A=1\nZOTERO_API_KEY=new\nB=2\n");
  });

  test("appends when absent, without eating the previous line", () => {
    assert.equal(applyEnvLine("A=1", "CODEX_BIN", "/bin/x"), "A=1\nCODEX_BIN=/bin/x\n");
  });

  test("writes into an empty file", () => {
    assert.equal(applyEnvLine("", "CLAUDE_BIN", "/bin/c"), "CLAUDE_BIN=/bin/c\n");
  });

  test("leaves comments and unrelated keys alone", () => {
    const before = "# notes\nOTHER=keep\n";
    assert.equal(applyEnvLine(before, "CODEX_BIN", "/bin/x"), "# notes\nOTHER=keep\nCODEX_BIN=/bin/x\n");
  });
});

describe("isWritableSetting", () => {
  test("accepts only the settings the UI can offer", () => {
    assert.equal(isWritableSetting("ZOTERO_API_KEY"), true);
    assert.equal(isWritableSetting("CLAUDE_BIN"), true);
    assert.equal(isWritableSetting("PATH"), false);
    assert.equal(isWritableSetting(null), false);
  });
});

describe("detectCli", () => {
  let dir = "";
  const savedPath = process.env.PATH;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "doctor-"));
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    delete process.env.CODEX_BIN;
    await rm(dir, { recursive: true, force: true });
  });

  test("reports a CLI that is nowhere as missing", async () => {
    process.env.PATH = dir; // empty dir — nothing resolvable
    const report = await detectCli("codex", dir); // and an isolated home to probe
    assert.equal(report.found, false);
    assert.equal(report.version, null);
    assert.equal(report.source, null);
  });

  test("finds a CLI the server's PATH can reach", async () => {
    const bin = path.join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\necho 'codex-cli 1.2.3'\n");
    await chmod(bin, 0o755);
    process.env.PATH = dir;
    const report = await detectCli("codex");
    assert.equal(report.found, true);
    assert.equal(report.source, "path");
    assert.equal(report.path, bin);
    assert.equal(report.version, "codex-cli 1.2.3");
  });

  test("an explicit CODEX_BIN is reported as coming from the env", async () => {
    const bin = path.join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\necho ok\n");
    await chmod(bin, 0o755);
    process.env.PATH = "";
    process.env.CODEX_BIN = bin;
    const report = await detectCli("codex");
    assert.equal(report.source, "env");
    assert.equal(report.path, bin);
  });

  test("CODEX_BIN pointing nowhere is called out rather than silently ignored", async () => {
    process.env.PATH = "";
    process.env.CODEX_BIN = path.join(dir, "not-there");
    const report = await detectCli("codex", dir);
    assert.equal(report.found, false);
    assert.match(report.note ?? "", /CODEX_BIN is set/);
  });

  test("still reports a CLI whose version probe fails — presence is the signal", async () => {
    const bin = path.join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\nexit 1\n"); // like zotero-mcp's argparse on --version
    await chmod(bin, 0o755);
    process.env.PATH = dir;
    const report = await detectCli("codex");
    assert.equal(report.found, true);
    assert.equal(report.version, null);
  });
});
