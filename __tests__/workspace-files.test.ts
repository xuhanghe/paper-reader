import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceDirectory, listWorkspaceFiles, moveWorkspaceFile, readWorkspaceText, resolveWorkspaceFile, validateWorkspaceRoot, validateWorkspaceTrashTarget, writeWorkspaceText } from "../lib/workspace-files";

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

  test("lists directories before files at each explorer level", async () => {
    await writeWorkspaceText(root, "z-root.md", "root");
    await writeWorkspaceText(root, "alpha/note.md", "nested");
    const files = await listWorkspaceFiles(root);
    assert.ok(files.findIndex((entry) => entry.path === "alpha") < files.findIndex((entry) => entry.path === "z-root.md"));
  });

  test("creates an empty directory inside the fixed workspace", async () => {
    assert.equal(await createWorkspaceDirectory(root, "experiments/results"), "experiments/results");
    assert.ok((await listWorkspaceFiles(root)).some((entry) => entry.path === "experiments/results" && entry.kind === "directory"));
    await assert.rejects(() => createWorkspaceDirectory(root, "../outside"), /Invalid workspace file path/);
  });

  test("moves a file into a directory without leaving the fixed root", async () => {
    await writeWorkspaceText(root, "move-me.md", "move");
    await writeWorkspaceText(root, "destination/keep.md", "keep");
    assert.equal(await moveWorkspaceFile(root, "move-me.md", "destination"), "destination/move-me.md");
    assert.equal(await readWorkspaceText(root, "destination/move-me.md"), "move");
    await assert.rejects(() => readWorkspaceText(root, "move-me.md"));
    await assert.rejects(() => moveWorkspaceFile(root, "destination/move-me.md", "../outside"), /Invalid workspace file path/);
  });

  test("never resolves a file outside the fixed root", async () => {
    await assert.rejects(() => resolveWorkspaceFile(root, "../outside.md"), /Invalid workspace file path/);
  });

  test("rejects roots that are too broad for an agent", async () => {
    await assert.rejects(() => validateWorkspaceRoot(path.parse(root).root), /dedicated project directory/);
    await assert.rejects(() => validateWorkspaceRoot(homedir()), /dedicated project directory/);
  });

  test("requires the exact canonical directory before offering a Trash operation", async () => {
    assert.equal(await validateWorkspaceTrashTarget(root, await realpath(root)), await realpath(root));
    await assert.rejects(() => validateWorkspaceTrashTarget(root, `${root}-different`), /does not match/);
  });

  test("never allows Paper Reader to trash itself", async () => {
    await assert.rejects(() => validateWorkspaceTrashTarget(process.cwd(), process.cwd()), /own project directory/);
  });
});
