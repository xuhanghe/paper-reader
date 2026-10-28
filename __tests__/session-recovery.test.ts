import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendThread, conversationTurns, countAsks, deleteFromThread, dirFor, furthestPageAsked, lastTurn, readFigureDataUrl, readThread, readWithdrawn, withdrawTurns, withoutWithdrawn, writeState, type ThreadEntry,
} from "../lib/session-store.js";
import {
  askGist, chatHistorySection, earlierConversation, earlierConversationSection, entriesBefore, freshStartOnLostSession,
  indexThread, LOST_SESSION, parseChatHistory, replayForEndpoint, showsProgress, threadPathFor,
} from "../lib/session-recovery.js";

// A provider that has lost its transcript of a paper's conversation gets a
// fresh session seeded from the app's own record: where the thread file is,
// what is in it, and what was worked out; the agent reads the turns it needs.

const ID = "__recovery-test__";
const marker = (n: number, text: string) => `[turn ${n}] ${text}`;
const explain = (n: number, page: number, quote: string) => marker(n, `I selected this passage (page ${page}):\n\n"${quote}"\n\nExplain it: first what it means on its own.\n\nAnswer in English, matching the passage.\n\nWhere you draw on the paper, link the words themselves.`);
const question = (n: number, page: number, quote: string, q: string) => marker(n, `About this passage (page ${page}):\n\n"${quote}"\n\nMy question: ${q}\n\nI am at page ${page} of the paper. Stand on what comes before.\n\nWhere you draw on the paper, link the words themselves.`);

before(async () => {
  await writeState(ID, { pdfName: "Recovery.pdf", pdfDataUrl: "", zoteroKey: "RECOV1", model: "m", annotations: [], highlights: [],
    concepts: [{ annotationId: "c1", label: "pooled samples", type: "text", takeaways: ["Pooling dilutes a positive across the pool", "Error rises with pool size"] }] });
  await appendThread(ID, { ts: 1, role: "user", text: explain(1, 3, "pooled samples contain few positives"), kind: "explain", annotationId: "c1" });
  await appendThread(ID, { ts: 2, role: "assistant", text: "Pooling means several samples are tested as one.", annotationId: "c1" });
  await appendThread(ID, { ts: 3, role: "user", text: question(2, 5, "a Bayesian framework", "why a prior at all?"), kind: "question", annotationId: "c2" });
  await appendThread(ID, { ts: 4, role: "assistant", text: "The prior carries the prevalence estimate.", annotationId: "c2" });
  await appendThread(ID, { ts: 5, role: "user", text: marker(3, "and if the prior is wrong?\n\nLive web search is available."), kind: "followup", annotationId: "c2" });
  await appendThread(ID, { ts: 6, role: "assistant", text: "Then the posterior is off by as much.", annotationId: "c2" });
});
after(() => rm(dirFor(ID), { recursive: true, force: true }));

describe("what each ask was about", () => {
  test("a passage, a question about one, a figure, a follow-up, a general question with quotes", () => {
    assert.deepEqual(askGist(explain(1, 3, "pooled samples contain few positives")), { page: 3, gist: '"pooled samples contain few positives"' });
    assert.deepEqual(askGist(question(2, 5, "a Bayesian framework", "why a prior at all?")), { page: 5, gist: 'why a prior at all? — on "a Bayesian framework"' });
    assert.deepEqual(askGist("[turn 4] I captured the attached figure from the paper. My question: what is on the x axis?"), { gist: "a captured figure — what is on the x axis?" });
    assert.deepEqual(askGist(marker(5, "and if the prior is wrong?\n\nLive web search is available.")), { gist: "and if the prior is wrong?" });
    assert.deepEqual(askGist("[turn 6] Passages I selected from the paper, labelled so I can refer to them:\n\n[1] from the paper, page 3\n> pooled samples\n\nDo [1] and the abstract agree?\n\nWhere you draw on the paper, link the words."), { gist: "Do [1] and the abstract agree?" });
  });

  test("nor is the line naming the question a follow-up continues", () => {
    assert.equal(askGist("[turn 58] test\n\nThis follows on from my question in [turn 49] (OvS… — on \"x\"), in the same conversation — not from the question I asked just before this one.\n\nI am at page 4 of the paper.").gist, "test");
  });

  test("the words directing the answer are not the question", () => {
    assert.equal(askGist("[turn 7] This replaces my question in [turn 6]: I have rewritten it. Answer this version on its own terms.\n\nwhat changed?\n\nAnswer in English, matching my question — not the language of the passage.").gist, "what changed?");
  });
});

describe("the index of a thread", () => {
  test("numbers questions by their marker, and by count where there is none", () => {
    const index = indexThread([
      { ts: 1, role: "user", text: "old question without a marker" },
      { ts: 2, role: "assistant", text: "a" },
      { ts: 3, role: "user", text: marker(5, "a later one") },
    ]);
    assert.deepEqual(index.map((e) => [e.turn, e.gist]), [[1, "old question without a marker"], [5, "a later one"]]);
  });

  test("the current question, already appended, is not earlier", () => {
    const entries = [
      { ts: 1, role: "user" as const, text: marker(1, "one") }, { ts: 2, role: "assistant" as const, text: "a1" },
      { ts: 3, role: "user" as const, text: marker(2, "two") },
    ];
    assert.deepEqual(entriesBefore(entries, 2).map((e) => e.text), [marker(1, "one"), "a1"]);
  });
});

describe("the seed for a fresh session", () => {
  test("an agent with file tools is pointed at the thread file, told how to read it, and given the questions and takeaways", async () => {
    const earlier = await earlierConversation(ID, { beforeTurn: 4 });
    assert.ok(earlier);
    const text = earlierConversationSection(earlier!, { agentic: true });
    assert.ok(text.includes(threadPathFor(ID)), "the file");
    assert.ok(/read that file first/.test(text) && /grep works/.test(text), "how to use it");
    assert.ok(text.includes("• Pooling dilutes a positive across the pool"), "the takeaways");
    assert.ok(text.includes('[turn 1] (page 3) "pooled samples contain few positives"'));
    assert.ok(text.includes('[turn 2] (page 5) why a prior at all? — on "a Bayesian framework"'));
    assert.ok(text.includes("[turn 3] and if the prior is wrong?"));
    assert.ok(!text.includes("You: Pooling means"), "no replay for an agent that can read the file");
  });

  test("an agent without file tools gets the recent part inline instead", async () => {
    const earlier = await earlierConversation(ID, { beforeTurn: 4 });
    const text = earlierConversationSection(earlier!, { agentic: false });
    assert.ok(!text.includes(threadPathFor(ID)), "a path is no use");
    assert.ok(text.includes("You: Pooling means several samples are tested as one."));
    assert.ok(text.includes("Me: [turn 3] and if the prior is wrong?"), "directives stripped from my side, the marker kept");
  });

  test("a paper never talked about has no seed", async () => {
    assert.equal(await earlierConversation("__recovery-none__", { beforeTurn: 1 }), null);
  });
});

// Which entries a deleted turn takes with it: its question and its answer
describe("withdrawn turns", () => {
  const u = (turn: number | null, text: string, annotationId: string): ThreadEntry =>
    ({ ts: 0, role: "user", text: turn === null ? text : marker(turn, text), annotationId });
  const a = (text: string, annotationId: string, turn?: number): ThreadEntry =>
    ({ ts: 0, role: "assistant", text, annotationId, ...(turn ? { turn } : {}) });
  const texts = (entries: ThreadEntry[]) => entries.map((e) => e.text.replace(/^\[turn \d+\] /, ""));

  test("a question goes with its answer: the one naming its turn, or else the next in its conversation", () => {
    const entries = [u(1, "one", "A"), a("a1", "A"), u(2, "two", "B"), a("a2", "B"), u(3, "three", "A"), a("a3", "A", 3)];
    assert.deepEqual(texts(withoutWithdrawn(entries, [2])), ["one", "a1", "three", "a3"]);
    assert.deepEqual(texts(withoutWithdrawn(entries, [3])), ["one", "a1", "two", "a2"]);
    assert.equal(withoutWithdrawn(entries, []), entries);
  });

  test("an answer arriving after another conversation's question is still its own", () => {
    const entries = [u(2, "two", "B"), u(3, "three", "A"), a("a3", "A"), a("a2", "B")];
    assert.deepEqual(texts(withoutWithdrawn(entries, [2])), ["three", "a3"]);
    const tagged = [u(2, "two", "A"), u(3, "three", "A"), a("a2", "A", 2), a("a3", "A", 3)];
    assert.deepEqual(texts(withoutWithdrawn(tagged, [2])), ["three", "a3"]);
  });

  test("a question whose answer never came takes no later answer with it", () => {
    const entries = [u(2, "two", "B"), u(4, "four", "B"), a("a4", "B")];
    assert.deepEqual(texts(withoutWithdrawn(entries, [2])), ["four", "a4"]);
  });

  test("questions from before the markers are numbered by count", () => {
    const entries = [u(null, "first", "A"), a("a1", "A"), u(null, "second", "A"), a("a2", "A")];
    assert.deepEqual(texts(withoutWithdrawn(entries, [2])), ["first", "a1"]);
  });
});

// A question deleted in the panel is deleted from the thread too, as though
// never asked; the model is told nothing
describe("deleted turns on disk", () => {
  const W = "__withdrawn-test__";
  const RACE = "__withdrawn-race-test__";
  const LEGACY = "__withdrawn-legacy-test__";
  const CARD = "__withdrawn-card-test__";
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const fileLines = async (id: string) => (await readFile(threadPathFor(id), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as ThreadEntry);
  before(async () => {
    await writeState(W, { pdfName: "Withdrawn.pdf", pdfDataUrl: "", model: "m", annotations: [], highlights: [], concepts: [] });
    await mkdir(path.join(dirFor(W), "figures"), { recursive: true });
    await writeFile(path.join(dirFor(W), "figures", "fig-2.png"), PNG);
    await writeFile(path.join(dirFor(W), "figures", "fig-3.png"), PNG);
    await appendThread(W, { ts: 1, role: "user", text: marker(1, "what is pooling?"), kind: "followup", annotationId: "c1" });
    await appendThread(W, { ts: 2, role: "assistant", text: "Pooling tests samples as one.", annotationId: "c1", turn: 1 });
    await appendThread(W, { ts: 3, role: "user", text: marker(2, "test"), kind: "followup", annotationId: "c1", imageFile: "figures/fig-2.png" });
    await appendThread(W, { ts: 4, role: "assistant", text: "A test answer.", annotationId: "c1", turn: 2 });
    await appendThread(W, { ts: 5, role: "user", text: marker(3, "and the prior?"), kind: "followup", annotationId: "c1", imageFile: "figures/fig-3.png" });
    await appendThread(W, { ts: 6, role: "assistant", text: "The prior carries prevalence.", annotationId: "c1", turn: 3 });
    await withdrawTurns(W, [2]);
  });
  after(async () => {
    for (const id of [W, RACE, LEGACY, CARD]) await rm(dirFor(id), { recursive: true, force: true });
  });

  test("the question, its answer and the figure only it used are gone from the file", async () => {
    assert.deepEqual((await fileLines(W)).map((e) => e.text), [marker(1, "what is pooling?"), "Pooling tests samples as one.", marker(3, "and the prior?"), "The prior carries prevalence."]);
    assert.deepEqual(await readdir(path.join(dirFor(W), "figures")), ["fig-3.png"]);
    assert.equal(await countAsks(W), 2);
  });

  test("its number is never given out again, and an answer arriving for it later is dropped", async () => {
    await appendThread(W, { ts: 7, role: "assistant", text: "Late answer to the deleted one.", annotationId: "c1", turn: 2 });
    assert.ok(!(await fileLines(W)).some((e) => e.text.startsWith("Late answer")));
    await withdrawTurns(W, [3]);
    assert.equal(await lastTurn(W), 3, "the deleted last turn still counts");
    assert.deepEqual(await readdir(path.join(dirFor(W), "figures")), []);
  });

  test("a rewrite deleted takes the question it replaced with it", async () => {
    await appendThread(RACE, { ts: 1, role: "user", text: marker(1, "keep"), annotationId: "a" });
    await appendThread(RACE, { ts: 2, role: "assistant", text: "kept", annotationId: "a", turn: 1 });
    await appendThread(RACE, { ts: 3, role: "user", text: marker(2, "d"), annotationId: "b" });
    await appendThread(RACE, { ts: 4, role: "user", text: marker(3, "This replaces my question in [turn 2]: I have rewritten it. Answer this version.\n\nwhat is d?"), annotationId: "b" });
    await appendThread(RACE, { ts: 5, role: "assistant", text: "d is …", annotationId: "b", turn: 3 });
    await withdrawTurns(RACE, [3]);
    assert.deepEqual((await fileLines(RACE)).map((e) => e.text), [marker(1, "keep"), "kept"]);
    assert.deepEqual(await readWithdrawn(RACE), [2, 3]);
  });

  test("a card goes by its id: all of it, what has no number too, and whatever of it arrives later", async () => {
    await appendThread(CARD, { ts: 1, role: "user", text: marker(1, "keep this"), annotationId: "keep" });
    await appendThread(CARD, { ts: 2, role: "assistant", text: "kept", annotationId: "keep", turn: 1 });
    await appendThread(CARD, { ts: 3, role: "user", text: marker(2, "explain"), annotationId: "card" });
    await appendThread(CARD, { ts: 4, role: "assistant", text: "an answer from before answers were numbered", annotationId: "card" });
    await appendThread(CARD, { ts: 5, role: "user", text: marker(3, "still being asked"), annotationId: "card" });
    await deleteFromThread(CARD, { conversation: "card" });
    assert.deepEqual((await fileLines(CARD)).map((e) => e.text), [marker(1, "keep this"), "kept"]);
    await appendThread(CARD, { ts: 6, role: "assistant", text: "the in-flight answer, arriving late", annotationId: "card" });
    assert.equal((await fileLines(CARD)).length, 2, "nothing of a deleted card is appended later");
    assert.equal(await lastTurn(CARD), 3);
  });

  test("an edit deletes its conversation from the edited turn on, a question there not yet numbered in the panel too", async () => {
    await appendThread(CARD, { ts: 7, role: "user", text: marker(4, "first"), annotationId: "edit" });
    await appendThread(CARD, { ts: 8, role: "assistant", text: "a4", annotationId: "edit", turn: 4 });
    await appendThread(CARD, { ts: 9, role: "user", text: marker(5, "to be edited"), annotationId: "edit" });
    await appendThread(CARD, { ts: 10, role: "assistant", text: "a5", annotationId: "edit", turn: 5 });
    await appendThread(CARD, { ts: 11, role: "user", text: marker(6, "elsewhere"), annotationId: "keep" });
    await appendThread(CARD, { ts: 12, role: "user", text: marker(7, "asked after, its number not back yet"), annotationId: "edit" });
    await deleteFromThread(CARD, { turns: [5], conversation: "edit", fromTurn: 5 });
    assert.deepEqual((await fileLines(CARD)).map((e) => e.text), [marker(1, "keep this"), "kept", marker(4, "first"), "a4", marker(6, "elsewhere")]);
    // Editing is not deleting the card: the conversation goes on
    await appendThread(CARD, { ts: 13, role: "user", text: marker(8, "the new version"), annotationId: "edit" });
    assert.equal((await fileLines(CARD)).at(-1)?.text, marker(8, "the new version"));
  });

  test("two deletions landing together both count, and a damaged list is read for what is sound in it", async () => {
    await Promise.all([withdrawTurns(RACE, [1]), withdrawTurns(RACE, [3]), withdrawTurns(RACE, [1])]);
    assert.deepEqual(await readWithdrawn(RACE), [1, 2, 3]);
    await writeFile(path.join(dirFor(RACE), "withdrawn.json"), JSON.stringify({ turns: [2, "x", -1, 2.5, 2], told: { s: [1] } }));
    assert.deepEqual(await readWithdrawn(RACE), [2]);
    await writeFile(path.join(dirFor(RACE), "withdrawn.json"), "{ not json");
    assert.deepEqual(await readWithdrawn(RACE), []);
  });

  test("a turn only listed as deleted, from before deleting rewrote the thread, is skipped until the next deletion clears it", async () => {
    await appendThread(LEGACY, { ts: 1, role: "user", text: marker(1, "one"), annotationId: "a" });
    await appendThread(LEGACY, { ts: 2, role: "assistant", text: "a1", annotationId: "a" });
    await appendThread(LEGACY, { ts: 3, role: "user", text: marker(2, "two"), annotationId: "a" });
    await appendThread(LEGACY, { ts: 4, role: "assistant", text: "a2", annotationId: "a" });
    await writeFile(path.join(dirFor(LEGACY), "withdrawn.json"), JSON.stringify({ turns: [1], told: {} }));
    assert.deepEqual((await readThread(LEGACY)).map((e) => e.text), [marker(2, "two"), "a2"]);
    const earlier = await earlierConversation(LEGACY, { beforeTurn: 3 });
    assert.deepEqual(earlier?.index.map((e) => e.turn), [2]);
    assert.ok(!/delet/i.test(earlierConversationSection(earlier!, { agentic: true })), "the agent is told nothing");
    await withdrawTurns(LEGACY, [2]);
    assert.equal((await readFile(threadPathFor(LEGACY), "utf8")).trim(), "", "both are gone from the file now");
  });
});

// A custom endpoint is sent the thread with every question. It has no file
// tools, so a figure goes as the image itself or is said in words — never as
// a path it cannot open.
describe("the thread sent to a custom endpoint", () => {
  const q = (turn: number, text: string, annotationId: string, imageFile?: string): ThreadEntry =>
    ({ ts: turn, role: "user", text: marker(turn, text), annotationId, ...(imageFile ? { imageFile } : {}) });
  const ans = (text: string, annotationId: string): ThreadEntry => ({ ts: 0, role: "assistant", text, annotationId });
  const thread = [
    q(1, "figure one", "A", "figures/f1.png"), ans("about f1", "A"),
    q(2, "figure two", "B", "figures/f2.png"), ans("about f2", "B"),
    q(3, "figure three", "C", "figures/f3.png"), ans("about f3", "C"),
    q(4, "figure four", "D", "figures/f4.png"), ans("about f4", "D"),
    q(5, "plain", "B"), ans("plain answer", "B"),
  ];
  const readFigure = async (ref: string) => (ref.includes("f3") ? null : `data:image/png;base64,${path.basename(ref)}`);
  const images = (messages: { content: unknown }[]) =>
    messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").map((p) => p.image_url.url) : []));

  test("a model that reads images sees the figures themselves: its own conversation's first, then the newest, a few at most", async () => {
    const messages = await replayForEndpoint(thread, { vision: true, annotationId: "A", readFigure, max: 2 });
    assert.deepEqual(images(messages), ["data:image/png;base64,f1.png", "data:image/png;base64,f4.png"]);
    assert.ok(String(messages[2].content).startsWith("(I attached a figure to this message."), "one past the cap is said in words");
    assert.ok(String(messages[4].content).startsWith("(I attached a figure"), "one that could not be read is said in words");
    assert.equal(messages[8].content, marker(5, "plain"));
    assert.ok(!JSON.stringify(messages).includes("figures/"), "no path is ever sent");
  });

  test("a text-only model is told of each figure in words, and sent no image", async () => {
    const messages = await replayForEndpoint(thread, { vision: false, annotationId: "A", readFigure });
    assert.deepEqual(images(messages), []);
    assert.equal(messages.filter((m) => String(m.content).startsWith("(I attached a figure")).length, 4);
    assert.ok(!JSON.stringify(messages).includes("figures/"));
  });

  test("a figure is typed by its bytes, whatever its name, and only inside the paper's own folder", async () => {
    const F = "__figure-type-test__";
    await mkdir(path.join(dirFor(F), "figures"), { recursive: true });
    await writeFile(path.join(dirFor(F), "figures", "fig-1.png"), Buffer.from("ffd8ffe000104a464946", "hex"));
    await writeFile(path.join(dirFor(F), "figures", "fig-2.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    try {
      assert.match((await readFigureDataUrl(F, "figures/fig-1.png")) ?? "", /^data:image\/jpeg;base64,/);
      assert.match((await readFigureDataUrl(F, "figures/fig-2.png")) ?? "", /^data:image\/png;base64,/);
      assert.equal(await readFigureDataUrl(F, "../__recovery-test__/state.json"), null);
      assert.equal(await readFigureDataUrl(F, "figures/missing.png"), null);
    } finally {
      await rm(dirFor(F), { recursive: true, force: true });
    }
  });
});

// A paper's conversations share one thread, in time order
describe("a conversation among others in the thread", () => {
  const T = "__conversation-test__";
  before(async () => {
    await appendThread(T, { ts: 1, role: "user", text: marker(1, "the OvS question"), annotationId: "ovs" });
    await appendThread(T, { ts: 2, role: "assistant", text: "about OvS", annotationId: "ovs", turn: 1 });
    for (let n = 2; n <= 6; n++) {
      await appendThread(T, { ts: n * 10, role: "user", text: marker(n, `figure question ${n}`), annotationId: "fig" });
      await appendThread(T, { ts: n * 10 + 1, role: "assistant", text: `about figure ${n}`, annotationId: "fig", turn: n });
    }
  });
  after(() => rm(dirFor(T), { recursive: true, force: true }));

  test("knows its own last question, and that another conversation was asked in since", async () => {
    assert.deepEqual(await conversationTurns(T, "ovs"), { previous: { turn: 1, text: marker(1, "the OvS question") }, latest: 6 });
    assert.equal((await conversationTurns(T, "fig")).previous?.turn, 6);
    assert.deepEqual(await conversationTurns(T, "new"), { previous: undefined, latest: 6 });
  });
});

// Looking back at page 2 after asking about page 6 has not unread pages 3–6
describe("the furthest page asked about", () => {
  const P = "__furthest-test__";
  after(() => rm(dirFor(P), { recursive: true, force: true }));

  test("read off where each ask said the reader was, and the passages' pages; a deleted question no longer counts", async () => {
    assert.equal(await furthestPageAsked(P), undefined);
    await appendThread(P, { ts: 1, role: "user", text: marker(1, 'About this passage (page 4):\n\n"OvS"\n\nMy question: why?\n\nI am at page 4 of the paper.'), annotationId: "a" });
    await appendThread(P, { ts: 2, role: "user", text: marker(2, "Figure 4(b)?\n\nI am at page 6 of the paper."), annotationId: "b" });
    await appendThread(P, { ts: 3, role: "user", text: marker(3, "and this?\n\nI am looking at page 2 of the paper now, and have read up to page 6, the furthest I have asked about."), annotationId: "a" });
    assert.equal(await furthestPageAsked(P), 6);
    await withdrawTurns(P, [2, 3]);
    assert.equal(await furthestPageAsked(P), 4);
  });
});

describe("the workspace chat as a seed", () => {
  test("recent turns only, capped, as a record", () => {
    const history = parseChatHistory([{ role: "user", content: "first" }, { role: "assistant", content: "" }, { role: "assistant", content: "x".repeat(5000) }, { role: "junk", content: "no" }, { role: "user", content: "last" }]);
    assert.deepEqual(history.map((t) => [t.role, t.content.length]), [["user", 5], ["assistant", 1500], ["user", 4]]);
    assert.ok(chatHistorySection(history).startsWith("Earlier in this chat."));
    assert.ok(chatHistorySection(history).endsWith("Me: last"));
    assert.equal(chatHistorySection([]), "");
  });
});

describe("telling a lost session", () => {
  test("by each provider's own sign", () => {
    assert.ok(LOST_SESSION.claude('{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0}', "No conversation found with session ID: x"));
    assert.ok(LOST_SESSION.claude("", "No conversation found with session ID: x"));
    assert.ok(!LOST_SESSION.claude('{"type":"result","subtype":"success","num_turns":3}', ""));
    assert.ok(LOST_SESSION.codex('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Error: Codex exited with code 1 before returning an answer. Error: thread/resume: thread/resume failed: no rollout found for thread id x"}}'));
    assert.ok(!LOST_SESSION.codex('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Error: Codex exited with code 1. rate limited"}}'));
    assert.ok(LOST_SESSION.opencode('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Error: opencode responded with 404. session not found"}}'));
  });

  test("progress is an answer or a tool, never an announcement or an error line", () => {
    assert.ok(!showsProgress('{"type":"system","subtype":"init","session_id":"s"}\n'));
    assert.ok(showsProgress('{"type":"system","session_id":"s"}\n{"type":"assistant","message":{"content":[]}}\n'));
    assert.ok(showsProgress('{"type":"stream_event","event":{"type":"content_block_delta"}}\n'));
    assert.ok(showsProgress('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Pooling"}}\n'));
    assert.ok(!showsProgress('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Error: Codex exited"}}\n'));
    assert.ok(!showsProgress('{"type":"result","subtype":"error_during_execution"}\n'));
  });
});

const enc = new TextEncoder();
const lines = (...items: string[]) => new ReadableStream({ start(c) { for (const item of items) c.enqueue(enc.encode(item + "\n")); c.close(); } });
const drain = async (stream: ReadableStream) => { const out: string[] = []; const reader = stream.getReader(); const dec = new TextDecoder(); while (true) { const { done, value } = await reader.read(); if (done) break; out.push(dec.decode(value)); } return out.join(""); };

describe("a fresh start on a lost session", () => {
  test("a resumed run that answers passes through untouched, and the fresh run is never started", async () => {
    let freshStarted = 0;
    const out = await drain(freshStartOnLostSession(
      lines('{"type":"system","subtype":"init","session_id":"old"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"Pooling"}]}}', '{"type":"result","subtype":"success"}'),
      async () => { freshStarted += 1; return lines("never"); },
      () => true,
    ));
    assert.equal(freshStarted, 0);
    assert.ok(out.includes('"session_id":"old"') && out.includes("Pooling") && out.endsWith('"success"}\n'));
  });

  test("a resumed run that only reports the lost session is replaced by the fresh run, which the reader never sees fail", async () => {
    let done = 0;
    const out = await drain(freshStartOnLostSession(
      lines('{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0}'),
      async () => lines('{"type":"system","subtype":"init","session_id":"new"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"From the record: …"}]}}'),
      (output) => LOST_SESSION.claude(output, "No conversation found with session ID: old"),
      () => { done += 1; },
    ));
    assert.ok(!out.includes("error_during_execution"), "the failed start is held back");
    assert.ok(out.includes('"session_id":"new"'), "the new session id reaches the reader");
    assert.ok(out.includes("From the record"));
    assert.equal(done, 1);
  });

  test("any other failure is shown as it was", async () => {
    const out = await drain(freshStartOnLostSession(
      lines('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Error: Codex exited with code 1. rate limited"}}'),
      async () => lines("never"),
      LOST_SESSION.codex,
    ));
    assert.ok(out.includes("rate limited") && !out.includes("never"));
  });
});
