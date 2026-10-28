import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { conversationsOf, overviewSection, recentExchanges } from "../lib/endpoint-context.js";
import type { ThreadEntry } from "../lib/session-store.js";

// What a third-party model is told with each question: the paper's
// conversations and what each worked out, which one is being asked in, and
// that one's latest exchanges — the one just before the question above all.

const state = {
  annotations: [
    { id: "fig-1111-aaaa", type: "image", label: "Figure", pageNumber: 6, messages: [{ role: "assistant", content: "Figure 4(b) shows latency." }], createdAt: 0 },
    { id: "ovs-2222-bbbb", type: "text", label: "OvS", selectedText: "OvS-DPDK (HW offload)", pageNumber: 4, messages: [{ role: "user", content: "是不是OvS在userspace？" }, { role: "assistant", content: "对。" }, { role: "user", content: "test" }, { role: "assistant", content: "" }], createdAt: 1 },
    { id: "gen-3333-cccc", type: "text", label: "general", messages: [{ role: "user", content: "What is a DPU?" }, { role: "assistant", content: "A data processing unit." }], createdAt: 2 },
  ],
  concepts: [{ annotationId: "fig-1111-aaaa", label: "Figure", type: "image", takeaways: ["Latency converges past 8 KB", "The inset zooms in on small sizes"] }],
};

describe("the paper's conversations", () => {
  test("each with what it is about, how far it went, and its notes — or its first question when it has none yet", () => {
    const list = conversationsOf(state, "ovs-2222-bbbb");
    assert.deepEqual(list.map((c) => [c.handle, c.about, c.exchanges, c.current]), [
      ["fig1111a", "page 6, a figure I captured", 1, false],
      ["ovs2222b", 'page 4, the passage "OvS-DPDK (HW offload)"', 1, true],
      ["gen3333c", "a question about the paper", 1, false],
    ]);
    assert.deepEqual(list[0].notes, ["Latency converges past 8 KB", "The inset zooms in on small sizes"]);
    assert.deepEqual(list[1].notes, ["first asked: 是不是OvS在userspace？"]);
  });

  test("listed with the one asked in first and marked, and the ids kept to the model", () => {
    const text = overviewSection(conversationsOf(state, "ovs-2222-bbbb"), { tools: true });
    const lines = text.split("\n");
    assert.match(lines[1], /^▶ \[ovs2222b\] page 4, the passage "OvS-DPDK \(HW offload\)" — 1 exchange \(the one I am asking in now\)$/);
    assert.ok(text.includes("    · Latency converges past 8 KB"));
    assert.match(text, /read_conversation with it/);
    assert.match(text, /never write one to me/);
    assert.equal(overviewSection([], { tools: true }), "");
  });
});

describe("the conversation's latest exchanges", () => {
  const e = (role: "user" | "assistant", text: string): ThreadEntry => ({ ts: 0, role, text });
  const thread = [e("user", "q1"), e("assistant", "a".repeat(50)), e("user", "q2"), e("assistant", "b".repeat(50)), e("user", "q3"), e("assistant", "c".repeat(50))];

  test("as many as fit, newest first, whole exchanges only", () => {
    assert.deepEqual(recentExchanges(thread, 110).map((x) => x.text[0]), ["q", "b", "q", "c"]);
  });

  test("never fewer than the last one, however long", () => {
    assert.deepEqual(recentExchanges(thread, 1).map((x) => x.text), ["q3", "c".repeat(50)]);
  });

  test("a conversation that began with an answer counts that as its first exchange", () => {
    const explained = [e("assistant", "explained"), e("user", "why?"), e("assistant", "because")];
    assert.deepEqual(recentExchanges(explained, 1000).map((x) => x.text), ["explained", "why?", "because"]);
    assert.deepEqual(recentExchanges([], 1000), []);
  });
});
