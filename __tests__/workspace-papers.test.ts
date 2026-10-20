import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { appendThread, dirFor, writePaperText, writeState } from "../lib/session-store.js";
import { describeWorkspacePapers, parsePaperRefs } from "../lib/workspace-papers.js";

// The Workspace agent works across the papers attached to a workspace. What
// was read and asked about each of them lives in the paper's Reader session;
// the agent is told where that is and what shape it has, or, without file
// tools, gets the gist inline.

const READ = "__ws-papers-read__";
const UNREAD = "__ws-papers-unread__";

before(async () => {
  await writePaperText(READ, "Alpha", "[page 1]\nPooled testing of samples.\n[page 2]\nA Bayesian framework.");
  await writeState(READ, {
    pdfName: "Alpha.pdf", pdfDataUrl: "", zoteroKey: "ALPHA123", model: "m",
    annotations: [
      { id: "c1", type: "text", label: "pooled samples", selectedText: "pooled samples contain few positives", pageNumber: 1, messages: [{ role: "assistant", content: "Pooling means…" }], createdAt: 1 },
      { id: "c2", type: "text", label: "Bayesian framework", selectedText: "a Bayesian framework", pageNumber: 2, messages: [{ role: "assistant", content: "A prior is updated…" }], createdAt: 2 },
    ],
    concepts: [
      { annotationId: "c1", label: "pooled samples", type: "text", takeaways: ["Pooling dilutes a positive sample across the pool", "False negatives rise with pool size"] },
      { annotationId: "c2", label: "Bayesian framework", type: "text", takeaways: ["The prior is the prevalence estimate"] },
    ],
  });
  await appendThread(READ, { ts: 1, role: "user", text: "[turn 1] I selected this passage (page 1): \"pooled samples contain few positives\" Explain it.", kind: "explain", annotationId: "c1" });
  await appendThread(READ, { ts: 2, role: "assistant", text: "Pooling means several samples are tested as one.", annotationId: "c1" });
  await appendThread(READ, { ts: 3, role: "user", text: "[turn 2] About this passage (page 2): \"a Bayesian framework\" My question: what is the prior?", kind: "question", annotationId: "c2" });
  await appendThread(READ, { ts: 4, role: "assistant", text: "The prior is the prevalence estimate before testing.", annotationId: "c2" });
});
after(async () => {
  await rm(dirFor(READ), { recursive: true, force: true });
  await rm(dirFor(UNREAD), { recursive: true, force: true });
});

const REFS = [
  { id: READ, name: "Alpha.pdf", zoteroKey: "ALPHA123" },
  { id: UNREAD, name: "Beta.pdf", zoteroKey: "BETA456" },
];

describe("what the workspace agent is told about the papers", () => {
  test("an agent with file tools gets each read paper's folder and what its files hold", async () => {
    const text = await describeWorkspacePapers(REFS, { agentic: true });
    assert.ok(text.includes(`"Alpha" (Zotero key ALPHA123): ${dirFor(READ)}`), "the folder is named");
    assert.ok(text.includes("paper.md — the full text"), "the text file");
    assert.ok(text.includes("thread.jsonl — my 2 questions"), "the conversation, counted");
    assert.ok(text.includes("state.json — the 2 conversation cards"), "the cards");
    assert.ok(text.includes("• Pooling dilutes a positive sample across the pool"), "the takeaways");
    assert.ok(text.includes("• The prior is the prevalence estimate"), "from every conversation");
    assert.ok(text.includes("read those files with your file tools".toLowerCase().slice(0, 10)) || /Read those files with your file tools/.test(text), "told to read them");
  });

  test("a paper never opened in the Reader is said to be that, not invented", async () => {
    const text = await describeWorkspacePapers(REFS, { agentic: true });
    assert.ok(text.includes(`"Beta" (Zotero key BETA456): not opened in the Reader yet`));
    assert.ok(!text.includes(dirFor(UNREAD)), "no folder for it");
  });

  test("an agent without file tools gets the conversation inline instead of paths", async () => {
    const text = await describeWorkspacePapers(REFS, { agentic: false });
    assert.ok(!text.includes(dirFor(READ)), "a path is no use without tools");
    assert.ok(text.includes("2 questions asked in the Reader"));
    assert.ok(text.includes("• Pooling dilutes a positive sample across the pool"));
    assert.ok(text.includes("Assistant: The prior is the prevalence estimate before testing."), "the answers are there");
    assert.ok(text.includes("Me: [turn 2] About this passage"), "and the questions");
  });

  test("no papers, nothing said", async () => {
    assert.equal(await describeWorkspacePapers([], { agentic: true }), "");
  });
});

describe("the papers a request names", () => {
  test("only well-formed references count, and the name falls back to the id", () => {
    assert.deepEqual(parsePaperRefs([{ id: "A1", name: "One.pdf", zoteroKey: "A1" }, { id: "" }, { name: "no id" }, { id: "B2" }, "junk"]), [
      { id: "A1", name: "One.pdf", zoteroKey: "A1" },
      { id: "B2", name: "B2", zoteroKey: undefined },
    ]);
  });
  test("anything but a list is no papers", () => {
    assert.deepEqual(parsePaperRefs(undefined), []);
    assert.deepEqual(parsePaperRefs("A1"), []);
  });
});
