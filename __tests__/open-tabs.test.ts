import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadOpenTabs, saveOpenTabs, subscribeOpenTabs, upsertOpenTab, OPEN_TABS_KEY } from "../lib/open-tabs.js";
import type { MaterialTab } from "../components/MaterialTabs.js";

const paper = (id: string, name = id): MaterialTab => ({ id, name, docType: "pdf" });

// Minimal window/localStorage so the module's browser paths can be exercised
function installWindow() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const win = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn));
    },
    dispatchEvent: (event: { type: string }) => {
      (listeners.get(event.type) ?? []).forEach((fn) => fn(event));
      return true;
    },
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = win;
  globals.localStorage = win.localStorage;
  globals.CustomEvent = win.CustomEvent;
  return { store, listeners };
}

describe("upsertOpenTab", () => {
  test("adds a paper that isn't open yet", () => {
    assert.deepEqual(upsertOpenTab([paper("a")], paper("b")).map((t) => t.id), ["a", "b"]);
  });

  test("refreshes an open paper in place, keeping tab order stable", () => {
    const tabs = [paper("a"), paper("b"), paper("c")];
    const next = upsertOpenTab(tabs, { ...paper("b", "renamed"), zoteroKey: "K" });
    assert.deepEqual(next.map((t) => t.id), ["a", "b", "c"]);
    assert.equal(next[1].name, "renamed");
    assert.equal(next[1].zoteroKey, "K");
  });
});

describe("the shared tab store", () => {
  let installed: ReturnType<typeof installWindow>;
  beforeEach(() => { installed = installWindow(); });
  afterEach(() => {
    const globals = globalThis as unknown as Record<string, unknown>;
    delete globals.window; delete globals.localStorage; delete globals.CustomEvent;
  });

  test("what one surface saves, the other loads", () => {
    saveOpenTabs([paper("a"), paper("b")]);
    assert.deepEqual(loadOpenTabs().map((t) => t.id), ["a", "b"]);
  });

  test("a save notifies this document — `storage` alone never would", () => {
    let calls = 0;
    const stop = subscribeOpenTabs(() => { calls++; });
    saveOpenTabs([paper("a")]);
    assert.equal(calls, 1);
    stop();
    saveOpenTabs([paper("b")]);
    assert.equal(calls, 1, "unsubscribing must actually detach");
  });

  test("a change in another browser tab is heard too", () => {
    let calls = 0;
    subscribeOpenTabs(() => { calls++; });
    installed.listeners.get("storage")?.forEach((fn) => fn({ type: "storage", key: OPEN_TABS_KEY }));
    assert.equal(calls, 1);
    installed.listeners.get("storage")?.forEach((fn) => fn({ type: "storage", key: "something-else" }));
    assert.equal(calls, 1, "unrelated keys must not trigger a reload");
  });

  test("corrupt storage reads as no tabs rather than throwing", () => {
    installed.store.set(OPEN_TABS_KEY, "{not json");
    assert.deepEqual(loadOpenTabs(), []);
  });

  test("entries without an id or name are dropped", () => {
    installed.store.set(OPEN_TABS_KEY, JSON.stringify([{ id: "a", name: "A" }, { id: "b" }, null]));
    assert.deepEqual(loadOpenTabs().map((t) => t.id), ["a"]);
  });
});
