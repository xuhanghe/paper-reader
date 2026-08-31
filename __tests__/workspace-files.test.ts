import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { listWorkspaceFiles, readWorkspaceText, resolveWorkspaceFile, validateWorkspaceRoot, writeWorkspaceText } from "../lib/workspace-files";

let root = "";
before(async () => { root = await mkdtemp(path.join(tmpdir(), "paper-reader-workspace-test-")); });
after(() => rm(root, { recursive: true, force: true }));

describe("fixed workspace filesystem scope", () => {
  test("canonicalizes the directory selected at creation", async () => {
    assert.equal(await validateWorkspaceRoot(root), await realpath(root));
  });

  test("creates, lists, reads, and updates a workspace file", async () => {
    await writeWorkspaceText(root, "notes/idea.md", "# First\n");
    assert.equal(await readWorkspaceText(root, "notes/idea.md"), "# First\n");
    assert.ok((await listWorkspaceFiles(root)).some((file) => file.path === "notes/idea.md"));
    await writeWorkspaceText(root, "notes/idea.md", "# Revised\n");
    assert.equal(await readWorkspaceText(root, "notes/idea.md"), "# Revised\n");
  });

  test("never resolves a file outside the fixed root", async () => {
    await assert.rejects(() => resolveWorkspaceFile(root, "../outside.md"), /Invalid workspace file path/);
  });

  test("rejects roots that are too broad for an agent", async () => {
    await assert.rejects(() => validateWorkspaceRoot(path.parse(root).root), /dedicated project directory/);
    await assert.rejects(() => validateWorkspaceRoot(homedir()), /dedicated project directory/);
  });
});
