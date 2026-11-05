import { dom } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { goToResult, onJump, surfaceOf, takePendingJump } from "../lib/search-nav.js";

// A result on this surface is acted on here; one on the other surface is
// handed over, and taken there once

const g = globalThis as Record<string, unknown>;
g.sessionStorage = dom.window.sessionStorage;
g.CustomEvent = dom.window.CustomEvent;
g.window = dom.window;

const turn = { kind: "conversation" as const, paperId: "P1", title: "A paper", annotationId: "c1", turn: 3 };
const message = { kind: "workspace-chat" as const, workspaceId: "w1", workspaceName: "DPU", messageId: "m1" };

describe("going to a result", () => {
  test("each kind belongs to a surface", () => {
    assert.equal(surfaceOf(turn), "reader");
    assert.equal(surfaceOf({ kind: "note", paperId: "P", title: "t", noteId: "n" }), "reader");
    assert.equal(surfaceOf(message), "workspace");
    assert.equal(surfaceOf({ kind: "workspace-file", workspaceId: "w", workspaceName: "W", path: "a.md" }), "workspace");
  });

  test("on this surface it is announced, and nothing is left behind", () => {
    const heard: unknown[] = [];
    const stop = onJump((loc) => heard.push(loc));
    let moved = "";
    goToResult(turn, "reader", (href) => { moved = href; });
    stop();
    assert.deepEqual(heard, [turn]);
    assert.equal(moved, "");
    assert.equal(takePendingJump("reader"), null);
  });

  test("on the other it is handed over, taken there once, and only there", () => {
    let moved = "";
    goToResult(message, "reader", (href) => { moved = href; });
    assert.equal(moved, "/workspace");
    assert.equal(takePendingJump("reader"), null, "not the Reader's to take");
    assert.deepEqual(takePendingJump("workspace"), message);
    assert.equal(takePendingJump("workspace"), null, "taken once");
  });

  test("one left too long ago is not taken on a later visit", () => {
    goToResult(turn, "workspace", () => {});
    assert.equal(takePendingJump("reader", Date.now() + 120_000), null);
  });
});
