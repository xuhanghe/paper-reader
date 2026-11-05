// Zotero is not reached from a test: the sessions are searched without it
import "./helpers/no-zotero.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendThread, dirFor, withdrawTurns, writeState } from "../lib/session-store.js";
import { buildSearchIndex, forgetSearchCache, landingFor, parseWorkspaces, sentencesOf } from "../lib/search-index.js";
import { catalogLine, parseFound, parseHistory, parseReply, searchPrompt } from "../lib/search-agent.js";
import { rankSearch } from "../lib/search-rank.js";

// Everything that can be found, each with where it is: a paper, its
// conversations by turn, its notes, a workspace's chat and files

const P = "__search-index-test__";
let root = "";

before(async () => {
  await writeState(P, {
    pdfName: "Pooled Testing with Dilution.pdf", pdfDataUrl: "", model: "m",
    annotations: [{
      id: "card-1", type: "text", label: "dilution effect", selectedText: "dilution lowers sensitivity", pageNumber: 4, createdAt: 1,
      messages: [
        { role: "user", content: "why does dilution matter here?", turn: 1 },
        { role: "assistant", content: "Pooling dilutes a positive sample." },
        { role: "user", content: "and for the prior?", turn: 3 },
        { role: "assistant", content: "The prior is the prevalence." },
      ],
    }],
    concepts: [{ annotationId: "card-1", label: "dilution", type: "text", takeaways: ["Dilution lowers sensitivity as pools grow"] }],
    highlights: [{ id: "h-1", text: "sensitivity drops with pool size", note: "key limitation for my DPU idea", pageNumber: 6, createdAt: 1 }],
  });
  // Turns the panel has no card for, one of them deleted
  await appendThread(P, { ts: 1, role: "user", text: "[turn 5] I selected this passage (page 9):\n\n\"adaptive designs\"\n\nExplain it: first what it means on its own.", annotationId: "lost-card" });
  await appendThread(P, { ts: 2, role: "assistant", text: "Adaptive designs pick the next pool from the last result.", annotationId: "lost-card", turn: 5 });
  await appendThread(P, { ts: 3, role: "user", text: "[turn 6] something I deleted about quokkas", annotationId: "lost-card" });
  await withdrawTurns(P, [6]);
  root = await mkdtemp(path.join(tmpdir(), "paper-reader-search-"));
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "notes", "plan.md"), "# Plan\nRun the dilution experiment on the BlueField DPU.");
  forgetSearchCache();
});
after(async () => {
  await rm(dirFor(P), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  forgetSearchCache();
});

const workspaces = () => parseWorkspaces([{
  id: "ws-1", name: "DPU Study", root,
  papers: [{ id: P, name: "Pooled Testing with Dilution.pdf" }],
  chat: [
    { id: "m1", role: "user", content: "can SM5 be offloaded to the NIC?" },
    { id: "m2", role: "assistant", content: "Not on BlueField-2; the crypto engine lacks SM4." },
  ],
}]);

describe("the index", () => {
  test("a paper, with what was worked out about it and the workspaces it is in", async () => {
    const index = await buildSearchIndex(workspaces());
    const paper = index.docs.find((d) => d.id === `paper:${P}`)!;
    assert.equal(paper.title, "Pooled Testing with Dilution");
    assert.match(paper.text, /Dilution lowers sensitivity/);
    assert.match(paper.text, /workspaces: DPU Study/);
    assert.deepEqual(paper.locator, { kind: "paper", paperId: P, title: "Pooled Testing with Dilution", zoteroKey: undefined });
  });

  test("a conversation, its questions by turn, to land on its card", async () => {
    const index = await buildSearchIndex(workspaces());
    const conv = index.docs.find((d) => d.id === `conv:${P}:card-1`)!;
    assert.deepEqual(conv.turns, [{ turn: 1, question: "why does dilution matter here?" }, { turn: 3, question: "and for the prior?" }]);
    assert.equal(conv.locator.kind === "conversation" && conv.locator.annotationId, "card-1");
    // The real library is in the index too; among this paper's own entries
    assert.equal(rankSearch(index, "prior prevalence", 200).find((r) => r.doc.id.includes(P))?.doc.id, conv.id);
  });

  test("a result in a conversation cites the sentence the words match, question or answer, and lands on its message", async () => {
    const index = await buildSearchIndex(workspaces());
    const conv = index.docs.find((d) => d.id === `conv:${P}:card-1`)!;
    const inAnswer = landingFor(conv, "prevalence");
    assert.deepEqual(inAnswer.kind === "conversation" && [inAnswer.messageIndex, inAnswer.turn, inAnswer.quote, inAnswer.inAnswer], [3, 3, "The prior is the prevalence.", true]);
    const inQuestion = landingFor(conv, "dilution matter");
    assert.deepEqual(inQuestion.kind === "conversation" && [inQuestion.messageIndex, inQuestion.quote, inQuestion.inAnswer], [0, "why does dilution matter here?", false]);
    const nothing = landingFor(conv, "quantum chromodynamics");
    assert.equal(nothing.kind === "conversation" && nothing.messageIndex, undefined, "no word in common: the conversation itself");
  });

  test("the agent's quote is taken where it is really there; its turn narrows the search", async () => {
    const index = await buildSearchIndex(workspaces());
    const conv = index.docs.find((d) => d.id === `conv:${P}:card-1`)!;
    const quoted = landingFor(conv, "", undefined, "Pooling dilutes a positive sample.");
    assert.deepEqual(quoted.kind === "conversation" && [quoted.messageIndex, quoted.inAnswer, quoted.quote], [1, true, "Pooling dilutes a positive sample."]);
    const invented = landingFor(conv, "prior prevalence", undefined, "words nobody ever wrote here");
    assert.equal(invented.kind === "conversation" && invented.quote, "The prior is the prevalence.", "an invented quote falls back to the words");
    const turnOnly = landingFor(conv, "", 3);
    assert.deepEqual(turnOnly.kind === "conversation" && [turnOnly.messageIndex, turnOnly.turn], [2, 3], "the turn named, at its question");
  });

  test("a sentence reads as it does on screen", () => {
    assert.deepEqual(sentencesOf("**MAC** 是认证标签。它不能防止 replay！See [the paper](paper:3). Then `x`."), ["MAC 是认证标签。", "它不能防止 replay！", "See the paper.", "Then x."]);
  });

  test("turns with no card go by the paper and the page asked on; a deleted turn stays deleted", async () => {
    const index = await buildSearchIndex(workspaces());
    const orphan = index.docs.find((d) => d.id === `thread:${P}:lost-card`)!;
    assert.equal(orphan.locator.kind === "conversation" && orphan.locator.page, 9);
    assert.deepEqual(orphan.turns?.map((t) => t.turn), [5]);
    assert.ok(!index.docs.some((d) => d.text.includes("quokkas")), "the deleted turn is nowhere");
  });

  test("a highlight with its note, to land on both", async () => {
    const index = await buildSearchIndex(workspaces());
    const note = index.docs.find((d) => d.id === `note:${P}:h-1`)!;
    assert.equal(note.title, "key limitation for my DPU idea");
    assert.deepEqual(note.locator, { kind: "note", paperId: P, title: "Pooled Testing with Dilution", zoteroKey: undefined, noteId: "h-1", page: 6, text: "sensitivity drops with pool size" });
  });

  test("a workspace's chat and its files, from what the client sends", async () => {
    const index = await buildSearchIndex(workspaces());
    const [hit] = rankSearch(index, "SM5 offloaded");
    assert.deepEqual(hit.doc.locator, { kind: "workspace-chat", workspaceId: "ws-1", workspaceName: "DPU Study", messageId: "m1" });
    assert.match(hit.doc.text, /lacks SM4/, "the answer is searched with its question");
    const file = index.docs.find((d) => d.id === "wsfile:ws-1:notes/plan.md")!;
    assert.match(file.text, /dilution experiment/);
    assert.deepEqual(file.locator, { kind: "workspace-file", workspaceId: "ws-1", workspaceName: "DPU Study", path: "notes/plan.md" });
  });

  test("what the client sends is checked: nothing without an id and a folder", () => {
    assert.deepEqual(parseWorkspaces("nope"), []);
    assert.deepEqual(parseWorkspaces([{ name: "no id" }, { id: "x" }]), []);
    assert.equal(parseWorkspaces([{ id: "x", root: "/r", chat: [{ id: 1, role: "user", content: "a" }, { id: "ok", role: "user", content: "b" }] }])[0].chat!.length, 1);
  });
});

describe("what the agent is given and what it answers", () => {
  test("the catalog line has the id, the place, and the turns to name", async () => {
    const index = await buildSearchIndex(workspaces());
    const line = JSON.parse(catalogLine(index.docs.find((d) => d.id === `conv:${P}:card-1`)!));
    assert.equal(line.id, `conv:${P}:card-1`);
    assert.equal(line.page, 4);
    assert.deepEqual(line.turns, ["[turn 1] why does dilution matter here?", "[turn 3] and for the prior?"]);
  });

  test("the prompt carries the memory, the catalog, the shortlist and the folders", () => {
    const prompt = searchPrompt("那篇讲 dilution 的", "/tmp/catalog.jsonl", [], ["/w/one"]);
    assert.match(prompt, /«那篇讲 dilution 的»/);
    assert.match(prompt, /\/tmp\/catalog\.jsonl/);
    assert.match(prompt, /the workspace folders: \/w\/one/);
    assert.match(prompt, /Never make up an id/);
  });

  test("a follow-up is sent with the search so far, and the reply is read out of the answer", () => {
    const history = parseHistory([
      { role: "user", text: "讲 DPU 加密的那篇" },
      { role: "agent", text: "两篇都可能", found: [{ id: "paper:A", title: "SCALE" }, { id: 7 }] },
      { role: "system", text: "dropped" },
    ]);
    assert.equal(history.length, 2);
    assert.deepEqual(history[1].found, [{ id: "paper:A", title: "SCALE" }]);
    const prompt = searchPrompt("不是这个", "/tmp/c.jsonl", [], [], { id: "R1", title: "Reading It" }, history);
    assert.match(prompt, /Earlier in this search[\s\S]*I said: 讲 DPU 加密的那篇[\s\S]*You answered: 两篇都可能; found SCALE \[paper:A\]/);
    assert.match(prompt, /I am reading “Reading It” \(paper id R1\)/);
    assert.equal(parseReply('ok {"reply": "是这篇", "results": []}'), "是这篇");
    assert.equal(parseReply("no json"), undefined);
  });

  test("only ids in the index come back, and a turn or page only where it is real", async () => {
    const index = await buildSearchIndex(workspaces());
    const byId = new Map(index.docs.map((d) => [d.id, d]));
    const answer = `Thinking… {"results": [
      {"id": "conv:${P}:card-1", "why": "你问过 prior", "turn": 3},
      {"id": "conv:${P}:card-1", "why": "duplicate"},
      {"id": "paper:${P}", "why": "the paper", "page": 4, "quote": "dilution lowers sensitivity"},
      {"id": "paper:MADE-UP", "why": "invented"},
      {"id": "thread:${P}:lost-card", "why": "a turn that is not there", "turn": 99}
    ]}`;
    const found = parseFound(answer, byId);
    assert.deepEqual(found.map((f) => f.id), [`conv:${P}:card-1`, `paper:${P}`, `thread:${P}:lost-card`]);
    assert.deepEqual(found[0].locator.kind === "conversation" && [found[0].locator.turn, found[0].locator.messageIndex], [3, 2], "the turn named, and where its question is in the card");
    assert.deepEqual(found[1].locator.kind === "paper" && [found[1].locator.page, found[1].locator.quote], [4, "dilution lowers sensitivity"]);
    assert.equal(found[2].locator.kind === "conversation" && found[2].locator.turn, undefined, "turn 99 is not in it");
    assert.deepEqual(parseFound("no json here", byId), []);
  });
});
