import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  beginRun,
  chatSnapshot,
  endRun,
  forgetChat,
  legacySessionProvider,
  loadAgentChoice,
  loadAgentMode,
  parseChat,
  saveAgentChoice,
  saveAgentMode,
  stopRun,
  subscribeChat,
  updateChat,
  updateRun,
} from "../lib/workspace-chat.js";

// A workspace's conversation: its messages, a session per provider, and an
// answer that keeps streaming into it while another workspace is on screen.

// The store reads window lazily, so a shim set up after the import is seen
const store = new Map<string, string>();
let writes = 0;
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { writes++; store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};
const saved = (id: string) => JSON.parse(store.get(`paper-reader:workspace-chat:${id}`) ?? "null");
const say = (text: string, role: "user" | "assistant" = "user") => ({ id: `m-${text}`, role, content: text });

describe("workspace chat", () => {
  let n = 0;
  let ws = "";
  beforeEach(() => {
    store.clear();
    writes = 0;
    ws = `ws-${++n}`;
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => mock.timers.reset());

  test("a chat saved with one session id keeps it, under the provider that made it", () => {
    assert.equal(legacySessionProvider("5f0c2a9e-1111-4c4c-8888-123456789abc"), "claude");
    assert.equal(legacySessionProvider("paper-reader-codex-v1:thread-9"), "codex");
    assert.equal(legacySessionProvider("ses_7f3a"), "opencode");
    const chat = parseChat({ messages: [say("hi"), { id: 1, role: "user", content: "broken" }, say("there", "assistant")], session: "paper-reader-codex-v1:t" });
    assert.deepEqual(chat.sessions, { codex: "paper-reader-codex-v1:t" });
    assert.deepEqual(chat.messages.map((m) => m.content), ["hi", "there"]);
    // Sessions kept per provider win over a stray legacy one, and only known providers count
    assert.deepEqual(parseChat({ messages: [], sessions: { claude: "c1", bogus: "x" }, session: "ses_1" }).sessions, { claude: "c1" });
    assert.deepEqual(parseChat(null), { messages: [], sessions: {} });
  });

  test("a change with nothing streaming is written at once", () => {
    updateChat(ws, (chat) => ({ ...chat, messages: [say("hello")] }));
    assert.deepEqual(saved(ws).messages.map((m: { content: string }) => m.content), ["hello"]);
  });

  test("while an answer streams, the conversation is written at most once a second, and at once when it ends", () => {
    const run = beginRun(ws)!;
    for (let i = 0; i < 50; i++) updateRun(ws, run, (chat) => ({ ...chat, messages: [say(`word ${i}`, "assistant")] }));
    assert.equal(writes, 0, "fifty words, no write yet");
    mock.timers.tick(1000);
    assert.equal(writes, 1);
    assert.equal(saved(ws).messages[0].content, "word 49");
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("the end", "assistant")] }));
    endRun(ws, run);
    assert.equal(saved(ws).messages[0].content, "the end");
    assert.equal(chatSnapshot(ws).streaming, false);
  });

  test("one answer at a time per workspace, each workspace on its own", () => {
    const run = beginRun(ws)!;
    assert.ok(run);
    assert.equal(beginRun(ws), null);
    const other = beginRun(`${ws}-other`);
    assert.ok(other);
    endRun(ws, run);
    endRun(`${ws}-other`, other!);
    assert.ok(beginRun(ws));
  });

  test("a stopped answer keeps what arrived and takes nothing more", () => {
    const run = beginRun(ws)!;
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("partial", "assistant")] }));
    stopRun(ws);
    assert.equal(run.signal.aborted, true);
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("after the stop", "assistant")] }));
    endRun(ws, run);
    assert.equal(saved(ws).messages[0].content, "partial");
  });

  test("an answer keeps landing in its workspace with nothing on screen, and is let go once written", () => {
    const listener = () => {};
    const unsubscribe = subscribeChat(ws, listener);
    const run = beginRun(ws)!;
    unsubscribe(); // switched to another workspace mid-answer
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("still coming", "assistant")] }));
    endRun(ws, run);
    assert.equal(saved(ws).messages[0].content, "still coming");
    // Read back from storage, as a fresh view would
    assert.equal(chatSnapshot(ws).chat.messages[0].content, "still coming");
  });

  test("removing a workspace stops its answer and forgets its chat, agent and mode", () => {
    saveAgentChoice(ws, { model: "codex:gpt-5.5", effort: "high" });
    saveAgentMode(ws, "auto");
    const run = beginRun(ws)!;
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("x")] }));
    forgetChat(ws);
    assert.equal(run.signal.aborted, true);
    updateRun(ws, run, (chat) => ({ ...chat, messages: [say("resurrected")] }));
    endRun(ws, run);
    assert.equal(store.has(`paper-reader:workspace-chat:${ws}`), false);
    assert.equal(store.has(`paper-reader:workspace-agent:v1:${ws}`), false);
    assert.equal(loadAgentMode(ws), "discussion");
  });

  test("a workspace's agent is its own; a new one starts on the last chosen anywhere", () => {
    assert.deepEqual(loadAgentChoice(ws), { model: "claude:sonnet", effort: "high" });
    saveAgentChoice(ws, { model: "codex:gpt-5.5", effort: "minimal" });
    saveAgentChoice(`${ws}-b`, { model: "claude:opus", effort: "max" });
    assert.deepEqual(loadAgentChoice(ws), { model: "codex:gpt-5.5", effort: "minimal" });
    assert.deepEqual(loadAgentChoice(`${ws}-new`), { model: "claude:opus", effort: "max" });
    // A full model id saved before reads the current way
    store.set(`paper-reader:workspace-agent:v1:${ws}`, JSON.stringify({ model: "claude-sonnet-4-6" }));
    assert.deepEqual(loadAgentChoice(ws), { model: "claude:claude-sonnet-4-6", effort: undefined });
  });
});
