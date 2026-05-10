import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTextPrompt, buildImagePrompt, SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_IMAGE } from "../lib/prompts.js";

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
