import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadPanelScroll, savePanelScroll, trim } from "../lib/panel-scroll.js";

function installStorage() {
  const store = new Map<string, string>();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {};
  globals.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

describe("ask panel scroll memory", () => {
  let store: ReturnType<typeof installStorage>;
  beforeEach(() => { store = installStorage(); });
  afterEach(() => {
    const globals = globalThis as unknown as Record<string, unknown>;
    delete globals.window; delete globals.localStorage;
  });

  test("a conversation resumes where it was left", () => {
    savePanelScroll("paper-a", 1240);
    assert.equal(loadPanelScroll("paper-a"), 1240);
  });

  test("offsets are per paper", () => {
    savePanelScroll("paper-a", 1240);
    savePanelScroll("paper-b", 15);
    assert.equal(loadPanelScroll("paper-a"), 1240);
    assert.equal(loadPanelScroll("paper-b"), 15);
    assert.equal(loadPanelScroll("paper-c"), null);
  });

  test("the latest save wins", () => {
    savePanelScroll("paper-a", 100);
    savePanelScroll("paper-a", 0);
    assert.equal(loadPanelScroll("paper-a"), 0);
  });

  test("no key means nothing is remembered, and nothing throws", () => {
    savePanelScroll(undefined, 500);
    assert.equal(loadPanelScroll(undefined), null);
    assert.equal(store.size, 0);
  });

  test("garbage in storage reads as nothing remembered", () => {
    store.set("paper-reader:ask-scroll:v1", "{not json");
    assert.equal(loadPanelScroll("paper-a"), null);
    savePanelScroll("paper-a", 7);
    assert.equal(loadPanelScroll("paper-a"), 7);
  });

  test("only the newest entries are kept", () => {
    const all: Record<string, { top: number; at: number }> = {};
    for (let i = 0; i < 10; i++) all[`p${i}`] = { top: i, at: i };
    const kept = trim(all, 3);
    assert.deepEqual(Object.keys(kept).sort(), ["p7", "p8", "p9"]);
  });
});
