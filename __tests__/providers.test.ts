import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCustomConfig, toAnthropicMessages } from "../lib/providers.js";
import { providerIdFor } from "../lib/provider-id.js";

describe("providerIdFor", () => {
  test("maps each sentinel to its backend", () => {
    assert.equal(providerIdFor("codex"), "codex");
    assert.equal(providerIdFor("custom"), "custom");
    assert.equal(providerIdFor("opencode"), "opencode");
  });

  test("anything else runs on claude", () => {
    assert.equal(providerIdFor("claude-sonnet-4-6"), "claude");
    assert.equal(providerIdFor(undefined), "claude");
    assert.equal(providerIdFor(""), "claude");
  });
});

describe("parseCustomConfig", () => {
  const base = { baseUrl: "https://api.example.com/v1/", model: "gpt-5.2" };

  test("defaults to the OpenAI format for configs saved before formats existed", () => {
    assert.equal(parseCustomConfig(base)?.format, "openai");
  });

  test("accepts anthropic and rejects anything else", () => {
    assert.equal(parseCustomConfig({ ...base, format: "anthropic" })?.format, "anthropic");
    assert.equal(parseCustomConfig({ ...base, format: "gemini" })?.format, "openai");
  });

  test("strips trailing slashes from the base URL", () => {
    assert.equal(parseCustomConfig(base)?.baseUrl, "https://api.example.com/v1");
  });

  test("keeps only a positive whole maxTokens", () => {
    assert.equal(parseCustomConfig({ ...base, maxTokens: 4096 })?.maxTokens, 4096);
    assert.equal(parseCustomConfig({ ...base, maxTokens: 0 })?.maxTokens, undefined);
    assert.equal(parseCustomConfig({ ...base, maxTokens: -5 })?.maxTokens, undefined);
    assert.equal(parseCustomConfig({ ...base, maxTokens: "lots" })?.maxTokens, undefined);
  });

  test("rejects configs with no endpoint or model", () => {
    assert.equal(parseCustomConfig({ model: "x" }), null);
    assert.equal(parseCustomConfig({ baseUrl: "https://x" }), null);
    assert.equal(parseCustomConfig(null), null);
  });
});

describe("toAnthropicMessages", () => {
  test("hoists the system message out of the list", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "you are a reader" },
      { role: "user", content: "hello" },
    ]);
    assert.equal(system, "you are a reader");
    assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
  });

  test("joins multiple system messages and keeps turn order", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "first" },
      { role: "user", content: "a" },
      { role: "system", content: "second" },
      { role: "assistant", content: "b" },
    ]);
    assert.equal(system, "first\n\nsecond");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  });

  test("rewrites a data-URL image part into an Anthropic source block", () => {
    const { messages } = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ]);
    assert.deepEqual(messages[0].content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("passes a remote image through as a url source", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ]);
    assert.deepEqual(messages[0].content, [{ type: "image", source: { type: "url", url: "https://x/y.png" } }]);
  });

  test("leaves plain string content alone", () => {
    const { messages } = toAnthropicMessages([{ role: "user", content: "just text" }]);
    assert.equal(messages[0].content, "just text");
  });

  test("returns no system field when there is no system message", () => {
    assert.equal(toAnthropicMessages([{ role: "user", content: "hi" }]).system, undefined);
  });
});
