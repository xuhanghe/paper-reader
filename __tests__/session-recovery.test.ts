import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { appendThread, dirFor, writeState } from "../lib/session-store.js";
import {
  askGist, chatHistorySection, earlierConversation, earlierConversationSection, entriesBefore, freshStartOnLostSession,
  indexThread, LOST_SESSION, parseChatHistory, showsProgress, threadPathFor,
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
