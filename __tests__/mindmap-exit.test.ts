import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeExit } from "../app/api/mindmap/route.js";

// "claude exited with code 1" told the reader nothing. The CLI does say why —
// on stdout as a result envelope for API errors, on stderr for the rest — and
// that is what the map's error should carry.
describe("what a failed map generation reports", () => {
  test("an API error's own words, from the result envelope", () => {
    const out = JSON.stringify({ type: "result", is_error: true, result: "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it." });
    assert.equal(describeExit(1, out, ""), "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.");
  });

  test("otherwise the last lines of stderr", () => {
    assert.equal(describeExit(1, "", "warning: something\nError: not logged in\nRun claude login"), "claude exited with code 1: warning: something Error: not logged in Run claude login");
  });

  test("a successful envelope is not mistaken for an explanation", () => {
    const out = JSON.stringify({ type: "result", is_error: false, result: "# map" });
    assert.equal(describeExit(1, out, "boom"), "claude exited with code 1: boom");
  });

  test("with nothing said, just the code", () => {
    assert.equal(describeExit(137, "", "   "), "claude exited with code 137");
  });
});
