import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mirrors the stream-parsing logic in app/page.tsx so we can test it independently
function parseStreamChunk(chunk: string): string {
  let accumulated = "";
  const lines = chunk.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        accumulated += event.delta.text;
      } else if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") accumulated += block.text;
        }
      } else if (event.type === "result" && event.result && !accumulated) {
        accumulated = typeof event.result === "string" ? event.result : "";
      }
    } catch {
      // non-JSON line, skip
    }
  }
  return accumulated;
}

describe("stream chunk parser", () => {
  test("extracts text from content_block_delta events", () => {
    const chunk = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    });
    assert.equal(parseStreamChunk(chunk), "Hello");
  });

  test("concatenates multiple delta events", () => {
    const chunk = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } }),
    ].join("\n");
    assert.equal(parseStreamChunk(chunk), "Hello world");
  });

  test("extracts text from assistant message content blocks", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Explained." }] },
    });
    assert.equal(parseStreamChunk(chunk), "Explained.");
  });

  test("falls back to result field when no delta or assistant events", () => {
    const chunk = JSON.stringify({ type: "result", result: "Final answer" });
    assert.equal(parseStreamChunk(chunk), "Final answer");
  });

  test("silently skips non-JSON lines", () => {
    const chunk = "not json at all\n" + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } });
    assert.equal(parseStreamChunk(chunk), "ok");
  });

  test("returns empty string for unknown event types", () => {
    const chunk = JSON.stringify({ type: "ping" });
    assert.equal(parseStreamChunk(chunk), "");
  });

  test("ignores non-text content blocks in assistant messages", () => {
    const chunk = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x" }, { type: "text", text: "readable" }] },
    });
    assert.equal(parseStreamChunk(chunk), "readable");
  });
});
