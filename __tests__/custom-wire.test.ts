import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { customStream, customComplete } from "../lib/providers.js";

// Exercises both wire formats against a stand-in endpoint: what we send is
// asserted on the server side, what we parse is asserted on the client side.

type Captured = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
let server: Server;
let baseUrl = "";
let captured: Captured | null = null;

const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}',
  'data: {"choices":[{"delta":{"content":"lo"}}]}',
  'data: [DONE]',
  "",
].join("\n\n");

const ANTHROPIC_SSE = [
  'data: {"type":"message_start","message":{"id":"msg_1"}}',
  'data: {"type":"content_block_start","index":0}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ignored"}}',
  'data: {"type":"message_stop"}',
  "",
].join("\n\n");

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = {
        path: req.url || "",
        headers: req.headers as Record<string, string>,
        body: JSON.parse(raw || "{}"),
      };
      const anthropic = (req.url || "").includes("/messages");
      const streaming = captured.body.stream === true;
      if (streaming) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(anthropic ? ANTHROPIC_SSE : OPENAI_SSE);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          anthropic
            ? JSON.stringify({ content: [{ type: "text", text: "Hello" }] })
            : JSON.stringify({ choices: [{ message: { content: "Hello" } }] })
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function collect(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "content_block_delta") out += event.delta.text;
    }
  }
  return out;
}

describe("custom provider — OpenAI format", () => {
  const cfg = { baseUrl: "", apiKey: "sk-test", model: "gpt-5.2", format: "openai" as const };

  test("posts to /chat/completions with a bearer token and streams deltas", async () => {
    const text = await collect(customStream({ ...cfg, baseUrl }, [{ role: "user", content: "hi" }]));
    assert.equal(text, "Hello");
    assert.equal(captured?.path, "/chat/completions");
    assert.equal(captured?.headers.authorization, "Bearer sk-test");
    assert.equal(captured?.body.model, "gpt-5.2");
    assert.equal(captured?.body.max_tokens, undefined, "max_tokens is Anthropic-only");
  });

  test("reads a non-streamed reply", async () => {
    assert.equal(await customComplete({ ...cfg, baseUrl }, [{ role: "user", content: "hi" }]), "Hello");
  });
});

describe("custom provider — Anthropic format", () => {
  const cfg = { baseUrl: "", apiKey: "sk-ant", model: "claude-sonnet-4-6", format: "anthropic" as const };

  test("posts to /v1/messages with x-api-key, a system field and max_tokens", async () => {
    const text = await collect(
      customStream({ ...cfg, baseUrl }, [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ])
    );
    assert.equal(text, "Hello", "thinking_delta events are ignored");
    assert.equal(captured?.path, "/v1/messages");
    assert.equal(captured?.headers["x-api-key"], "sk-ant");
    assert.equal(captured?.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured?.headers.authorization, undefined);
    assert.equal(captured?.body.system, "be brief");
    assert.deepEqual(captured?.body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(captured?.body.max_tokens, 8192, "a default is always sent — Anthropic 400s without one");
  });

  test("honours a configured max_tokens", async () => {
    await collect(customStream({ ...cfg, baseUrl, maxTokens: 2048 }, [{ role: "user", content: "hi" }]));
    assert.equal(captured?.body.max_tokens, 2048);
  });

  test("does not double the /v1 when the base URL already has it", async () => {
    await collect(customStream({ ...cfg, baseUrl: `${baseUrl}/v1` }, [{ role: "user", content: "hi" }]));
    assert.equal(captured?.path, "/v1/messages");
  });

  test("reads a non-streamed reply", async () => {
    assert.equal(await customComplete({ ...cfg, baseUrl }, [{ role: "user", content: "hi" }]), "Hello");
  });

  test("surfaces an HTTP error as readable text rather than an empty answer", async () => {
    const text = await collect(customStream({ ...cfg, baseUrl: "http://127.0.0.1:1" }, [{ role: "user", content: "hi" }]));
    assert.match(text, /^Error:/);
  });
});
