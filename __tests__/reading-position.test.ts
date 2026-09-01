import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadReadingPosition, saveReadingPosition, trim } from "../lib/reading-position.js";

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

describe("reading position", () => {
  let store: ReturnType<typeof installStorage>;
  beforeEach(() => { store = installStorage(); });
  afterEach(() => {
    const globals = globalThis as unknown as Record<string, unknown>;
    delete globals.window; delete globals.localStorage;
  });

  test("a paper resumes where it was left, at the zoom it was left at", () => {
    saveReadingPosition("paper-a", { scrollTop: 4894, scale: 1.34, page: 4 });
    assert.deepEqual(loadReadingPosition("paper-a"), { scrollTop: 4894, scale: 1.34, page: 4 });
  });

  test("positions are per paper — one does not leak into another", () => {
    saveReadingPosition("a", { scrollTop: 100, scale: 1 });
    saveReadingPosition("b", { scrollTop: 900, scale: 2 });
    assert.equal(loadReadingPosition("a")?.scrollTop, 100);
    assert.equal(loadReadingPosition("b")?.scrollTop, 900);
  });

  test("fit-to-width is stored as a rule, not the number it resolved to", () => {
    // storing the resolved number would freeze the paper at one window size
    saveReadingPosition("a", { scrollTop: 10, scale: "page-width" });
    assert.equal(loadReadingPosition("a")?.scale, "page-width");
  });

  test("a paper never opened has no position, and no key means no lookup", () => {
    assert.equal(loadReadingPosition("never-seen"), null);
    assert.equal(loadReadingPosition(undefined), null);
  });

  test("reopening the same paper replaces its position rather than stacking", () => {
    saveReadingPosition("a", { scrollTop: 100, scale: 1 });
    saveReadingPosition("a", { scrollTop: 250, scale: 1.5 });
    assert.equal(loadReadingPosition("a")?.scrollTop, 250);
    assert.equal(Object.keys(JSON.parse(store.get("paper-reader:reading-positions:v1")!)).length, 1);
  });

  test("corrupt storage reads as no position rather than throwing", () => {
    store.set("paper-reader:reading-positions:v1", "{not json");
    assert.equal(loadReadingPosition("a"), null);
  });

  test("an entry without a usable offset is ignored", () => {
    store.set("paper-reader:reading-positions:v1", JSON.stringify({ a: { scale: 1 } }));
    assert.equal(loadReadingPosition("a"), null);
  });
});

describe("trim", () => {
  test("keeps the most recently read papers when the list grows", () => {
    const all = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}`, { scrollTop: i, scale: 1 as const, at: i }])
    );
    const kept = trim(all, 3);
    assert.deepEqual(Object.keys(kept).sort(), ["p2", "p3", "p4"]);
  });

  test("leaves a short list untouched", () => {
    const all = { a: { scrollTop: 1, scale: 1 as const, at: 1 } };
    assert.deepEqual(trim(all, 3), all);
  });
});
