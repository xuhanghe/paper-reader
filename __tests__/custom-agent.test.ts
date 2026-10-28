import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { customAgentStream, type CustomConfig } from "../lib/providers.js";

// A model behind an API reads with tools that run here: it is sent their
// definitions, asks for one instead of answering, gets back what it returned,
// and answers — in OpenAI's format and in Anthropic's. An endpoint that takes
// no tools is asked again the old way.

type Seen = { url: string; body: Record<string, unknown> };
let server: http.Server;
let base = "";
const seen: Seen[] = [];
// What the endpoint answers each request with, in order
let replies: { status?: number; body: string }[] = [];

const sse = (...events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) });
      const reply = replies.shift() ?? { body: sse() };
      res.writeHead(reply.status ?? 200, { "Content-Type": reply.status ? "application/json" : "text/event-stream" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function drain(stream: ReadableStream): Promise<{ type?: string; detail?: string; delta?: { text?: string } }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ran: { name: string; args: unknown }[] = [];
const tools = {
  specs: [{ name: "read_paper", description: "Read pages", parameters: { type: "object", properties: { from_page: { type: "integer" } } } }],
  run: async (name: string, args: unknown) => {
    ran.push({ name, args });
    return { text: "[page 4]\nOvS offloads rules to the eSwitch.", images: ["data:image/jpeg;base64,AAAA"], activity: "Reading page 4" };
  },
};
const messages = [{ role: "system", content: "You read a paper." }, { role: "user", content: "[turn 2] what does OvS offload?" }];

describe("a model that reads with tools", () => {
  test("OpenAI format: a call, run here, its result sent back, then the answer", async () => {
    seen.length = 0; ran.length = 0;
    replies = [
      { body: sse(
        { choices: [{ delta: { content: "Let me check. " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_paper", arguments: '{"from_' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'page": 4}' } }] } }] },
      ) },
      { body: sse({ choices: [{ delta: { content: "It offloads flow rules." } }] }) },
    ];
    const cfg: CustomConfig = { baseUrl: base, apiKey: "k", model: "m", format: "openai", vision: true };
    const events = await drain(customAgentStream(cfg, messages, tools, async () => messages));
    assert.deepEqual(ran, [{ name: "read_paper", args: { from_page: 4 } }]);
    assert.deepEqual(events.map((e) => e.type === "tool" ? `tool:${e.detail}` : e.delta?.text), ["Let me check. ", "tool:Reading page 4", "It offloads flow rules."]);
    assert.equal(seen.length, 2);
    assert.equal((seen[0].body.tools as { function: { name: string } }[])[0].function.name, "read_paper");
    const second = seen[1].body.messages as { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[];
    assert.deepEqual(second.slice(2).map((m) => m.role), ["assistant", "tool", "user"]);
    assert.deepEqual(second[2].tool_calls, [{ id: "call_1", type: "function", function: { name: "read_paper", arguments: '{"from_page": 4}' } }]);
    assert.equal(second[3].tool_call_id, "call_1");
    assert.match(JSON.stringify(second[4].content), /data:image\/jpeg;base64,AAAA/);
  });

  test("Anthropic format: tool_use with its input streamed in pieces, a tool_result carrying the page image", async () => {
    seen.length = 0; ran.length = 0;
    replies = [
      { body: sse(
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_paper", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"from_page":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: " 4}" } },
      ) },
      { body: sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Flow rules." } }) },
    ];
    const cfg: CustomConfig = { baseUrl: base, apiKey: "k", model: "m", format: "anthropic", vision: true };
    const events = await drain(customAgentStream(cfg, messages, tools, async () => messages));
    assert.deepEqual(ran, [{ name: "read_paper", args: { from_page: 4 } }]);
    assert.equal(events.at(-1)?.delta?.text, "Flow rules.");
    assert.equal(seen[0].url, "/v1/messages");
    assert.equal(seen[0].body.system, "You read a paper.");
    assert.equal((seen[0].body.tools as { input_schema: unknown }[])[0].input_schema !== undefined, true);
    const second = seen[1].body.messages as { role: string; content: { type: string; tool_use_id?: string; content?: { type: string }[] }[] }[];
    assert.equal(second.at(-2)?.content[0].type, "tool_use");
    const result = second.at(-1)!.content[0];
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "toolu_1");
    assert.deepEqual(result.content?.map((c) => c.type), ["text", "image"]);
  });

  test("an endpoint that takes no tools is asked again the old way, with what the fallback builds", async () => {
    seen.length = 0;
    replies = [
      { status: 404, body: JSON.stringify({ error: { message: "No endpoints found that support tool use" } }) },
      { body: sse({ choices: [{ delta: { content: "Answered without tools." } }] }) },
    ];
    const cfg: CustomConfig = { baseUrl: base, apiKey: "k", model: "m", format: "openai" };
    const fallback = [{ role: "system", content: "The paper's text inline." }, messages[1]];
    const events = await drain(customAgentStream(cfg, messages, tools, async () => fallback));
    assert.equal(events.at(-1)?.delta?.text, "Answered without tools.");
    assert.equal(seen[1].body.tools, undefined);
    assert.equal((seen[1].body.messages as { content: string }[])[0].content, "The paper's text inline.");
  });

  test("any other failure is reported, not retried", async () => {
    seen.length = 0;
    replies = [{ status: 401, body: JSON.stringify({ error: { message: "bad key" } }) }];
    const cfg: CustomConfig = { baseUrl: base, apiKey: "k", model: "m", format: "openai" };
    const events = await drain(customAgentStream(cfg, messages, tools, async () => messages));
    assert.match(events[0].delta?.text ?? "", /^Error: custom API responded with 401/);
    assert.equal(seen.length, 1);
  });
});
