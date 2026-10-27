import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexArgs, codexExitMessage, codexStream, parseCustomConfig, toAnthropicMessages } from "../lib/providers.js";
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

describe("Codex CLI argument placement", () => {
  test("puts sandbox policy before exec for a first selection question", () => {
    const args = codexArgs("explain this");
    assert.ok(args.indexOf("-s") < args.indexOf("exec"));
    assert.equal(args[args.indexOf("-s") + 1], "read-only");
    assert.ok(args.indexOf("--ignore-user-config") > args.indexOf("exec"));
    assert.ok(args.indexOf("--ignore-rules") > args.indexOf("exec"));
    assert.equal(args.at(-1), "explain this");
  });

  test("never passes root-only flags to exec resume", () => {
    const sessionId = "019c1234-1234-7000-8000-123456789abc";
    const args = codexArgs("follow up", {
      resumeId: sessionId,
      cwd: "/tmp/research-workspace",
      writable: true,
      effort: "high",
    });
    const execAt = args.indexOf("exec");
    const resumeAt = args.indexOf("resume");
    const resumeArgs = args.slice(resumeAt + 1);

    assert.ok(args.indexOf("-C") < execAt);
    assert.ok(args.indexOf("-a") < execAt);
    assert.ok(args.indexOf("-s") < execAt);
    assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
    assert.ok(resumeAt > execAt);
    assert.ok(args.indexOf("--ignore-user-config") < resumeAt);
    assert.ok(args.indexOf("--ignore-rules") < resumeAt);
    assert.equal(resumeArgs.includes("-s"), false);
    assert.ok(resumeArgs.indexOf("--json") < resumeArgs.indexOf(sessionId));
    assert.deepEqual(args.slice(-2), [sessionId, "follow up"]);
  });
});

describe("Codex stream failures", () => {
  test("turns a CLI crash into a visible conversation error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paper-reader-codex-"));
    const fakeCodex = path.join(dir, "codex");
    const previous = process.env.CODEX_BIN;
    const previousHome = process.env.PAPER_READER_CODEX_HOME;
    try {
      await writeFile(fakeCodex, "#!/bin/sh\necho 'error: failed to load models cache: missing field base_instructions' >&2\nexit 1\n");
      await chmod(fakeCodex, 0o755);
      process.env.CODEX_BIN = fakeCodex;
      process.env.PAPER_READER_CODEX_HOME = path.join(dir, "runtime");

      const reader = codexStream("define command ring").getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();

      const text = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).delta?.text ?? "")
        .join("");
      assert.match(text, /Codex exited with code 1/);
      assert.match(text, /failed to load models cache/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
      if (previousHome === undefined) delete process.env.PAPER_READER_CODEX_HOME;
      else process.env.PAPER_READER_CODEX_HOME = previousHome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("selects the useful line from multiline stderr", () => {
    const message = codexExitMessage("warning: retrying\nerror: invalid cache\nfor help, use --help\n", 1);
    assert.match(message, /error: invalid cache/);
    assert.doesNotMatch(message, /for help/);
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
