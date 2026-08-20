import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTextPrompt, buildImagePrompt, buildAskMessage, buildSessionBootstrap, SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_IMAGE } from "../lib/prompts.js";

describe("buildTextPrompt", () => {
  test("wraps selected text in quotes", () => {
    const result = buildTextPrompt("gradient descent");
    assert.ok(result.includes('"gradient descent"'));
  });

  test("includes reading-paper context", () => {
    const result = buildTextPrompt("attention mechanism");
    assert.ok(result.toLowerCase().includes("paper"));
  });
});

describe("buildImagePrompt", () => {
  test("returns a non-empty string", () => {
    const result = buildImagePrompt();
    assert.ok(result.length > 0);
  });

  test("mentions capturing a region", () => {
    const result = buildImagePrompt();
    assert.ok(result.toLowerCase().includes("region") || result.toLowerCase().includes("captured"));
  });
});

describe("system prompts", () => {
  test("text prompt explains what role the concept plays in the paper", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("why it") || SYSTEM_PROMPT_TEXT.toLowerCase().includes("role"));
  });

  test("text prompt asks to connect concept to the paper context", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("paper") && SYSTEM_PROMPT_TEXT.toLowerCase().includes("connect"));
  });

  test("image prompt asks to explain what the figure is showing", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("what it is showing") || SYSTEM_PROMPT_IMAGE.toLowerCase().includes("showing"));
  });

  test("image prompt asks to connect figure to the paper's broader context", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("context") || SYSTEM_PROMPT_IMAGE.toLowerCase().includes("broader"));
  });

  test("text prompt asks for learning resources", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("resources"));
  });

  test("image prompt asks for learning resources", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("resources"));
  });
});

// The citation scheme is explained in the bootstrap, which is sent once per
// provider session. A paper whose conversation started before this existed
// would never hear about it, and on a long conversation the rule is thousands
// of tokens behind — so every ask restates it, the way the language rule is.
describe("citations reach every ask, not just the first", () => {
  test("a follow-up carries the scheme", () => {
    const msg = buildAskMessage({ kind: "followup", question: "why?" });
    assert.match(msg, /\(paper:N\)/);
    assert.match(msg, /\(turn:N\)/);
    assert.ok(msg.startsWith("why?"), "the question still comes first");
  });

  test("an explain carries it too", () => {
    assert.match(buildAskMessage({ kind: "explain", selectedText: "the kernel" }), /\(paper:N\)/);
  });

  test("an empty follow-up stays empty, so it is still rejected", () => {
    // Otherwise the directive alone would make a blank ask look like a question
    assert.equal(buildAskMessage({ kind: "followup", question: "" }), "");
    assert.equal(buildAskMessage({ kind: "followup" }), "");
  });

  test("the bootstrap explains the scheme in full", () => {
    const boot = buildSessionBootstrap({ title: "A paper", agentic: true, paperPath: "/p/paper.md" });
    assert.match(boot, /\[verbatim excerpt\]\(paper:N\)/);
    assert.match(boot, /\[turn N\]/);
  });
});
