import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unwrapPartials } from "../lib/claude-stream.js";

// The claude CLI writes an answer twice: once as `stream_event` wrappers while
// it is being written, and again as a finished `assistant` message. The panel
// only ever read the finished one — so an answer stopped halfway came back
// empty, even though the model had written most of it. These shapes are copied
// from a real `--include-partial-messages` run.

const encoder = new TextEncoder();
const line = (o: unknown) => JSON.stringify(o) + "\n";

const delta = (text: string, index = 1) =>
  line({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    session_id: "s1",
  });
const thinking = (text: string) =>
  line({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } },
  });
const assistant = (...content: unknown[]) =>
  line({ type: "assistant", message: { id: "msg_1", role: "assistant", content } });

// Feed the transform as one or more network chunks and read what comes out
async function run(chunks: string[]): Promise<Record<string, unknown>[]> {
  const source = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
  const out: Record<string, unknown>[] = [];
  const decoder = new TextDecoder();
  let carry = "";
  const reader = unwrapPartials(source).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value as BufferSource, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop()!;
    for (const l of lines) if (l.trim()) out.push(JSON.parse(l));
  }
  return out;
}

// What the panel accumulates from a stream, exactly as app/page.tsx does
const answerFrom = (events: Record<string, unknown>[]) => {
  let text = "";
  for (const ev of events) {
    const e = ev as { type?: string; delta?: { type?: string; text?: string }; message?: { content?: { type?: string; text?: string }[] } };
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text;
    else if (e.type === "assistant" && e.message?.content) {
      for (const b of e.message.content) if (b.type === "text") text += b.text;
    }
  }
  return text;
};

describe("claude partial-message normalising", () => {
  test("text becomes deltas the panel can show while it is still being written", async () => {
    const events = await run([delta("hello "), delta("there")]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["content_block_delta", "content_block_delta"]
    );
    assert.equal(answerFrom(events), "hello there");
  });

  test("the finished message does not repeat what the deltas already said", async () => {
    // The bug this guards: counted twice, every answer arrives doubled
    const events = await run([delta("hello there friend"), assistant({ type: "text", text: "hello there friend" })]);
    assert.equal(answerFrom(events), "hello there friend");
  });

  test("a stop halfway keeps the half that arrived", async () => {
    // No `assistant` event is ever sent — the model was interrupted
    const events = await run([delta("好，问题 1 上一轮"), delta("已经答过了")]);
    assert.equal(answerFrom(events), "好，问题 1 上一轮已经答过了");
  });

  test("a CLI that reports no partials still comes through whole", async () => {
    // Nothing was streamed, so nothing can be a duplicate — the finished
    // message has to survive, or older CLIs answer with silence
    const events = await run([assistant({ type: "text", text: "the whole answer" })]);
    assert.equal(answerFrom(events), "the whole answer");
  });

  test("reasoning is not mistaken for the answer", async () => {
    const events = await run([thinking("the user wants"), delta("the answer")]);
    assert.equal(answerFrom(events), "the answer");
  });

  test("tool use survives — only text the reader has already seen is dropped", async () => {
    const events = await run([
      delta("looking that up"),
      assistant({ type: "text", text: "looking that up" }, { type: "tool_use", id: "t1", name: "zotero" }),
    ]);
    const kept = events.filter((e) => e.type === "assistant");
    assert.equal(kept.length, 1);
    assert.deepEqual((kept[0] as { message: { content: { type: string }[] } }).message.content.map((b) => b.type), ["tool_use"]);
  });

  test("the session id still reaches the client, or the paper conversation forks", async () => {
    const events = await run([line({ type: "system", subtype: "init", session_id: "abc" }), delta("hi")]);
    assert.equal(events[0].session_id, "abc");
  });

  test("a delta split across two network chunks is not lost", async () => {
    const whole = delta("split me");
    const events = await run([whole.slice(0, 30), whole.slice(30)]);
    assert.equal(answerFrom(events), "split me");
  });

  test("a second message starts its own duplicate check", async () => {
    // `streamed` resets per message; without that a repeated phrase in a later
    // message would look like a duplicate and vanish
    const events = await run([
      delta("first"),
      assistant({ type: "text", text: "first" }),
      line({ type: "stream_event", event: { type: "message_start" } }),
      assistant({ type: "text", text: "first" }),
    ]);
    assert.equal(answerFrom(events), "firstfirst");
  });
});
