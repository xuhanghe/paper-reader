import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, parseJsonLine, readLines } from "../lib/ndjson.js";
import { parseAgentEvent } from "../lib/agent-events.js";

// Every stream in the app is newline-delimited JSON, and a chunk ends wherever
// it ends: in the middle of a line, or of a character.

describe("ndjson", () => {
  test("a line split across chunks arrives whole, once", () => {
    const lines: string[] = [];
    const split = createLineSplitter((line) => lines.push(line));
    split.push('{"type":"content_block_delta","delta":{"text":"Hel');
    split.push('lo"}}\n\n{"type":"res');
    split.push('ult"}');
    assert.deepEqual(lines, ['{"type":"content_block_delta","delta":{"text":"Hello"}}']);
    split.end();
    assert.deepEqual(lines.at(-1), '{"type":"result"}');
  });

  test("a character split across byte chunks is decoded whole", async () => {
    const bytes = new TextEncoder().encode('{"text":"中文 ✓"}\n');
    // Cut inside the three bytes of 中
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const lines: string[] = [];
    await readLines(stream, (line) => lines.push(line));
    assert.deepEqual(lines.map((line) => (parseJsonLine(line) as { text: string }).text), ["中文 ✓"]);
  });

  test("only objects are events", () => {
    assert.deepEqual(parseAgentEvent('{"type":"system","session_id":"s1"}'), { type: "system", session_id: "s1" });
    assert.equal(parseAgentEvent("[1,2]"), null);
    assert.equal(parseAgentEvent('"text"'), null);
    assert.equal(parseAgentEvent("{not json"), null);
  });
});
