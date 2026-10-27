import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isEffortName, isModelId, modelSpec, normalizeModelSpec, parseModelSpec, providerIdFor } from "../lib/model-spec.js";

describe("model specs", () => {
  test("values saved before models were chosen per provider keep their meaning", () => {
    assert.deepEqual(parseModelSpec("claude-sonnet-4-6"), { provider: "claude", model: "claude-sonnet-4-6" });
    assert.deepEqual(parseModelSpec("codex"), { provider: "codex", model: undefined });
    assert.deepEqual(parseModelSpec("opencode"), { provider: "opencode", model: undefined });
    assert.deepEqual(parseModelSpec("custom"), { provider: "custom" });
    assert.deepEqual(parseModelSpec(undefined), { provider: "claude" });
  });

  test("each provider carries its own model", () => {
    assert.deepEqual(parseModelSpec("claude:opus"), { provider: "claude", model: "opus" });
    assert.deepEqual(parseModelSpec("claude:sonnet[1m]"), { provider: "claude", model: "sonnet[1m]" });
    assert.deepEqual(parseModelSpec("codex:gpt-5.2-codex"), { provider: "codex", model: "gpt-5.2-codex" });
    assert.deepEqual(parseModelSpec("opencode:anthropic/claude-sonnet-4-5"), { provider: "opencode", model: "anthropic/claude-sonnet-4-5" });
  });

  test("Claude's default is no model at all, so the CLI picks", () => {
    assert.equal(parseModelSpec("claude:default").model, undefined);
    assert.equal(modelSpec("claude"), "claude:default");
  });

  test("a custom spec names an endpoint, and a model that may itself contain colons", () => {
    assert.deepEqual(parseModelSpec("custom:ep_1a2b"), { provider: "custom", endpointId: "ep_1a2b", model: undefined });
    assert.deepEqual(parseModelSpec("custom:ep_1a2b:llama3:8b"), { provider: "custom", endpointId: "ep_1a2b", model: "llama3:8b" });
    assert.deepEqual(parseModelSpec("custom:ep_x:openai/gpt-5:free"), { provider: "custom", endpointId: "ep_x", model: "openai/gpt-5:free" });
  });

  test("a model that could be read as a CLI flag, or holds odd characters, is dropped", () => {
    assert.equal(parseModelSpec("codex:--dangerously-bypass").model, undefined);
    assert.equal(parseModelSpec("claude:opus; rm -rf").model, undefined);
    assert.equal(parseModelSpec('codex:gpt"5').model, undefined);
    assert.equal(isModelId("-x"), false);
    assert.equal(isModelId("a".repeat(200)), false);
  });

  test("specs round-trip, and the old spelling normalizes to the new", () => {
    for (const spec of ["claude:opus", "claude:default", "codex", "codex:gpt-5.2", "opencode:openai/gpt-5", "custom", "custom:ep_1", "custom:ep_1:m:1"]) {
      assert.equal(normalizeModelSpec(spec), spec);
    }
    assert.equal(normalizeModelSpec("claude-haiku-4-5-20251001"), "claude:claude-haiku-4-5-20251001");
  });

  test("the provider decides which saved conversation a question resumes", () => {
    assert.equal(providerIdFor("codex:gpt-5.2"), "codex");
    assert.equal(providerIdFor("opencode:x/y"), "opencode");
    assert.equal(providerIdFor("custom:ep_1:m"), "custom");
    assert.equal(providerIdFor("claude:opus"), "claude");
    assert.equal(providerIdFor("claude-opus-4-7"), "claude");
  });

  test("effort names are the backends' own words, nothing else", () => {
    for (const e of ["low", "xhigh", "max", "minimal", "none"]) assert.equal(isEffortName(e), true);
    for (const e of ["", "High", "--x", "x y", 3]) assert.equal(isEffortName(e), false);
  });
});
