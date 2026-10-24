import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claudePermissionMode, modeDirective, parseAgentMode } from "../lib/workspace-modes.js";

// Two ways to run the workspace agent: a discussion, where the conversation
// is the point and files are only read or lightly noted in; and auto, where
// it implements with the power to do so.

describe("the agent's two modes", () => {
  test("anything but auto is a discussion", () => {
    assert.equal(parseAgentMode("auto"), "auto");
    assert.equal(parseAgentMode("discussion"), "discussion");
    assert.equal(parseAgentMode(undefined), "discussion");
    assert.equal(parseAgentMode("write-once"), "discussion");
  });

  test("a discussion keeps to the conversation, may read and note, and does not build", () => {
    const text = modeDirective("discussion");
    assert.ok(text.startsWith("Discussion mode"));
    assert.ok(/write notes/.test(text), "notes are allowed");
    assert.ok(/do not start building/.test(text), "building is not");
    assert.ok(/leave it for auto mode/.test(text));
  });

  test("auto implements on its own and reports what it checked", () => {
    const text = modeDirective("auto");
    assert.ok(text.startsWith("Auto mode"));
    assert.ok(/run commands and tests/.test(text));
    assert.ok(/what you verified/.test(text));
  });

  test("the claude CLI runs a discussion with edits allowed and auto in its own auto mode", () => {
    assert.equal(claudePermissionMode("discussion"), "acceptEdits");
    assert.equal(claudePermissionMode("auto"), "auto");
  });
});
