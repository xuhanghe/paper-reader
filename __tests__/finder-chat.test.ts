import { dom } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { closeFinder, finderSnapshot, openFinder, sendToFinder, subscribeFinder } from "../lib/finder-chat.js";

// The agent search as a conversation: each message carries what was said and
// found before it; closing forgets all of it

const g = globalThis as Record<string, unknown>;
g.localStorage = dom.window.localStorage;
const sent: Record<string, unknown>[] = [];
g.fetch = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  sent.push(body);
  const n = sent.length;
  const lines = [
    { type: "activity", text: `Searching ${n}` },
    { type: "results", reply: n === 1 ? "两篇都可能" : "是这篇", results: [{ id: `paper:P${n}`, kind: "paper", title: `Paper ${n}`, where: `Paper ${n}`, locator: { kind: "paper", paperId: `P${n}`, title: `Paper ${n}` } }] },
  ];
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200 });
};

describe("the agent search as a conversation", () => {
  test("a follow-up carries what was said and found before it", async () => {
    closeFinder();
    openFinder();
    assert.equal(finderSnapshot().open, true);
    await sendToFinder("讲 DPU 加密的那篇", { id: "R1", title: "Reading" });
    await sendToFinder("不是这个，是讲 SM5 的", { id: "R1", title: "Reading" });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].paperId, "R1", "the paper being read goes along");
    assert.deepEqual(sent[1].history, [
      { role: "user", text: "讲 DPU 加密的那篇" },
      { role: "agent", text: "两篇都可能", found: [{ id: "paper:P1", title: "Paper 1" }] },
    ]);
    const turns = finderSnapshot().turns;
    assert.deepEqual(turns.map((t) => t.role), ["user", "agent", "user", "agent"]);
    const last = turns[3];
    assert.ok(last.role === "agent" && last.status === "done" && last.reply === "是这篇" && last.results[0].id === "paper:P2");
  });

  test("closing forgets everything said", () => {
    let told = 0;
    const stop = subscribeFinder(() => { told += 1; });
    closeFinder();
    stop();
    assert.deepEqual(finderSnapshot(), { open: false, turns: [], running: false });
    assert.ok(told > 0, "the window is told to go");
  });
});
