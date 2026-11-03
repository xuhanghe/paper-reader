import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATTACHMENTS_DIR, readAttachments, saveAttachments } from "../lib/workspace-attachments.js";
import { listWorkspaceFiles } from "../lib/workspace-files.js";
import { buildConversationExport } from "../lib/conversation-export.js";

// The workspace agent's images are kept in the workspace, not in the browser's
// few megabytes of storage, where a full store loses the conversation since.

const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64");
const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 2]).toString("base64");

describe("images attached to a workspace question", () => {
  let root = "";
  before(async () => { root = await mkdtemp(path.join(tmpdir(), "paper-reader-attach-")); });
  after(() => rm(root, { recursive: true, force: true }));

  test("are saved in the workspace's hidden attachments folder, each its own file, typed by its name", async () => {
    const paths = await saveAttachments(root, [PNG, JPEG, "data:text/plain;base64,aGk="]);
    assert.equal(paths.length, 2, "what is not an image is not saved");
    assert.ok(paths.every((p) => p.startsWith(`${ATTACHMENTS_DIR}/`)));
    assert.match(paths[0], /\.png$/);
    assert.match(paths[1], /\.jpg$/);
    assert.notEqual(paths[0], paths[1]);
    assert.deepEqual([...await readFile(path.join(root, paths[1]))], [0xff, 0xd8, 0xff, 2]);
  });

  test("are read back for the model, in order, as typed data URLs", async () => {
    const paths = await saveAttachments(root, [JPEG, PNG]);
    const read = await readAttachments(root, paths);
    assert.deepEqual(read.map((a) => a.path), paths);
    assert.deepEqual(read.map((a) => a.mime), ["image/jpeg", "image/png"]);
    assert.equal(read[1].dataUrl, PNG);
    assert.ok(path.isAbsolute(read[0].file), "Codex is pointed at the file itself");
  });

  test("a path from the request reaches nothing but that folder", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "plot.png"), Buffer.from([0x89, 0x50]));
    await writeFile(path.join(path.dirname(root), "outside.png"), Buffer.from([0x89, 0x50])).catch(() => {});
    const read = await readAttachments(root, [
      "notes/plot.png",
      `${ATTACHMENTS_DIR}/../../notes/plot.png`,
      `${ATTACHMENTS_DIR}/../../../outside.png`,
      "/etc/hosts",
      `${ATTACHMENTS_DIR}/missing.png`,
      42,
    ]);
    assert.deepEqual(read, []);
    assert.deepEqual(await readAttachments(root, "not a list"), []);
  });

  test("the folder stays out of the file tree, and so out of the agent's file list", async () => {
    await writeFile(path.join(root, "idea.md"), "# idea");
    const files = await listWorkspaceFiles(root);
    assert.ok(files.some((f) => f.path === "idea.md"));
    assert.ok(!files.some((f) => f.path.startsWith(".paper-reader")));
  });
});

describe("an exported conversation", () => {
  test("says where a question's images are", () => {
    const md = buildConversationExport({
      workspace: { name: "W", root: "/w" },
      exportedAt: new Date(2026, 10, 3, 12, 0),
      messages: [
        { role: "user", content: "compare", images: [`${ATTACHMENTS_DIR}/a.png`, `${ATTACHMENTS_DIR}/b.jpg`] },
        { role: "user", content: "older", hasImage: true },
      ],
    });
    assert.match(md, /_\(2 images were attached, saved in the workspace: `\.paper-reader\/attachments\/a\.png`, `\.paper-reader\/attachments\/b\.jpg`\)_/);
    assert.match(md, /_\(a figure was attached\)_/);
  });
});
