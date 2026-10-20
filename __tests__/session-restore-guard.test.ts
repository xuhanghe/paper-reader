// Must come first: react-dom decides at import time whether it is in a
// browser, and takes an IE-era code path if it is not.
import { freshRoot } from "./helpers/dom-env.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement, act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useSession } from "../hooks/useSession.js";

// Opening a paper starts from an empty session and fetches the saved one.
// Until that fetch has answered, nothing may be written for the paper: a
// flush on a quick tab switch, or the parked copy's save, would write the
// empty session over the saved conversation. A paper with fifteen
// conversations lost all of them this way; its thread log kept them.

type Hook = ReturnType<typeof useSession>;

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
};

const saved: { id: string; state: { annotations: unknown[] } }[] = [];
type Reply = { status: number; state?: unknown };
// What GET /api/sessions answers for each paper — through a promise, so an
// answer can be held back
const replies = new Map<string, () => Promise<Reply>>();
(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "POST") {
    saved.push(JSON.parse(init.body || "{}"));
    return { ok: true, json: async () => ({}) } as Response;
  }
  const id = decodeURIComponent(/[?&]id=([^&]+)/.exec(url)?.[1] ?? "");
  const reply = await (replies.get(id)?.() ?? Promise.resolve<Reply>({ status: 404 }));
  return { ok: reply.status < 400, status: reply.status, json: async () => ({ state: reply.state }) } as Response;
};

function mount(): { hook: () => Hook } {
  let latest: Hook | null = null;
  function Probe() {
    const h = useSession();
    useEffect(() => { latest = h; });
    return null;
  }
  act(() => { createRoot(freshRoot()).render(createElement(Probe)); });
  return { hook: () => latest as Hook };
}

const PDF = "data:application/pdf;base64,AAAA";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const twoCards = { pdfName: "alpha.pdf", pdfDataUrl: "", zoteroKey: "KEYA", model: "m", concepts: [], highlights: [], annotations: [
  { id: "c1", type: "text", label: "one", messages: [{ role: "assistant", content: "a" }], createdAt: 1 },
  { id: "c2", type: "text", label: "two", messages: [{ role: "assistant", content: "b" }], createdAt: 2 },
] };

describe("a paper is not saved before its saved conversation is in hand", () => {
  beforeEach(() => { saved.length = 0; storage.clear(); replies.clear(); });

  test("a flush and a parked save before the answer write nothing; the conversation then comes through whole", async () => {
    let release!: (r: Reply) => void;
    replies.set("KEYA", () => new Promise((r) => { release = r; }));
    const { hook } = mount();
    await act(async () => { hook().setPdf("alpha.pdf", PDF, "pdf", "KEYA"); });
    await act(async () => { await wait(5); });
    await act(async () => { await hook().flushSave(); });
    assert.equal(saved.filter((s) => s.id === "KEYA").length, 0, "a flush while the saved conversation is still coming");
    // The reader moves on before it arrives: the parked copy must not be saved empty either
    await act(async () => { hook().setPdf("beta.pdf", PDF, "pdf", "KEYB"); });
    await act(async () => { await wait(900); });
    assert.equal(saved.filter((s) => s.id === "KEYA").length, 0, "the parked copy's save");
    // It arrives, into the parked copy; coming back shows it
    await act(async () => { release({ status: 200, state: twoCards }); await wait(20); });
    await act(async () => { hook().setPdf("alpha.pdf", PDF, "pdf", "KEYA"); });
    await act(async () => { await wait(5); });
    assert.equal(hook().session.annotations.length, 2, "the saved conversation is on screen");
    await act(async () => { await hook().flushSave(); });
    const last = [...saved].reverse().find((s) => s.id === "KEYA");
    assert.equal(last?.state.annotations.length, 2, "and is what gets saved");
  });

  test("a server error is not a missing conversation: the fetch is retried, and nothing is written meanwhile", async () => {
    let attempts = 0;
    replies.set("KEYC", async () => { attempts += 1; return { status: 500 }; });
    const { hook } = mount();
    await act(async () => { hook().setPdf("gamma.pdf", PDF, "pdf", "KEYC"); });
    await act(async () => { await wait(2300); });
    assert.equal(attempts, 3);
    await act(async () => { await hook().flushSave(); });
    assert.equal(saved.filter((s) => s.id === "KEYC").length, 0);
  });

  test("a paper with nothing saved is saved from its first question", async () => {
    replies.set("KEYD", async () => ({ status: 404 }));
    const { hook } = mount();
    await act(async () => { hook().setPdf("delta.pdf", PDF, "pdf", "KEYD"); });
    await act(async () => { await wait(20); });
    await act(async () => { hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }] }); });
    await act(async () => { await hook().flushSave(); });
    assert.equal([...saved].reverse().find((s) => s.id === "KEYD")?.state.annotations.length, 1);
  });

  test("a question asked while the answer was out is kept, after what was saved", async () => {
    let release!: (r: Reply) => void;
    replies.set("KEYA", () => new Promise((r) => { release = r; }));
    const { hook } = mount();
    await act(async () => { hook().setPdf("alpha.pdf", PDF, "pdf", "KEYA"); });
    await act(async () => { await wait(5); });
    await act(async () => { hook().addAnnotation({ type: "text", selectedText: "fresh", messages: [{ role: "user", content: "q" }] }); });
    await act(async () => { release({ status: 200, state: twoCards }); await wait(20); });
    assert.deepEqual(hook().session.annotations.map((a) => a.label ?? a.selectedText), ["one", "two", "fresh"]);
  });
});
