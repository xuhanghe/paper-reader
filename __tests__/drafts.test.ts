import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadDraft, saveDraft, trim } from "../lib/drafts.js";

// What is typed and not yet sent is kept per box, so it is there again after
// a refresh, a switch to another paper, or a crossing between surfaces.

// The store reads window lazily, so a shim set up after the import is seen
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

describe("drafts", () => {
  beforeEach(() => store.clear());

  test("a draft comes back as it was left, box by box", () => {
    saveDraft("reader:paper-1", { text: "half a thought", quotes: [{ id: "q1", text: "a passage", page: 3 }] });
    saveDraft("workspace:ws-1", { text: "evaluate this idea" });
    assert.deepEqual(loadDraft("reader:paper-1"), { text: "half a thought", quotes: [{ id: "q1", text: "a passage", page: 3 }] });
    assert.deepEqual(loadDraft("workspace:ws-1"), { text: "evaluate this idea", quotes: [] });
    assert.equal(loadDraft("reader:paper-2"), null);
  });

  test("sending, or clearing the box, forgets the draft", () => {
    saveDraft("reader:paper-1", { text: "half a thought" });
    saveDraft("reader:paper-1", { text: "  ", quotes: [] });
    assert.equal(loadDraft("reader:paper-1"), null);
  });

  test("quotes alone are a draft worth keeping", () => {
    saveDraft("reader:paper-1", { text: "", quotes: [{ id: "q1", text: "a passage" }] });
    assert.equal(loadDraft("reader:paper-1")?.quotes?.length, 1);
  });

  test("no box, nothing kept", () => {
    saveDraft(null, { text: "lost" });
    saveDraft(undefined, { text: "lost" });
    assert.equal(store.size, 0);
    assert.equal(loadDraft(null), null);
  });

  test("the oldest drafts fall off the end", () => {
    const all = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, { text: `t${i}`, at: i }]));
    assert.deepEqual(Object.keys(trim(all, 3)).sort(), ["k2", "k3", "k4"]);
  });

  test("a corrupt store reads as empty rather than throwing", () => {
    store.set("paper-reader:drafts:v1", "{not json");
    assert.equal(loadDraft("reader:paper-1"), null);
    saveDraft("reader:paper-1", { text: "fresh" });
    assert.equal(loadDraft("reader:paper-1")?.text, "fresh");
  });
});
