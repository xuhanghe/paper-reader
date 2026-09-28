// Must come first: react-dom decides at import time whether it is in a
// browser, and takes an IE-era code path if it is not.
import { freshRoot } from "./helpers/dom-env.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement, act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useSession } from "../hooks/useSession.js";

// An answer keeps streaming after the reader has moved to another paper.
// Every piece lands in the paper it was asked in, never in the one on
// screen, and it is all there when they come back.

type Hook = ReturnType<typeof useSession>;

// localStorage for the hook's last-session bookkeeping
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
};

// Every save the hook makes, by paper
const saved: { id: string; state: { annotations: { messages: { content: string }[] }[]; providerSessions?: Record<string, string> } }[] = [];
(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "POST") {
    saved.push(JSON.parse(init.body || "{}"));
    return { ok: true, json: async () => ({}) } as Response;
  }
  // No saved conversation for anything
  void url;
  return { ok: false, json: async () => ({}) } as Response;
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

describe("switching papers while an answer streams", () => {
  beforeEach(() => { saved.length = 0; storage.clear(); });

  test("the answer lands in its own paper, not the one now open, and is there on return", async () => {
    const { hook } = mount();
    await act(async () => { hook().setPdf("alpha.pdf", PDF, "pdf", "KEYA"); });
    await act(async () => { await wait(5); });
    const A = hook().paperId as string;
    let id = "";
    await act(async () => { id = hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }] }); });
    await act(async () => { hook().updateLastAssistantMessage(id, "first", A); });
    assert.equal(hook().session.annotations[0].messages[1].content, "first");

    // Move to another paper; the stream keeps going
    await act(async () => { hook().setPdf("beta.pdf", PDF, "pdf", "KEYB"); });
    await act(async () => { await wait(5); });
    assert.equal(hook().session.pdfName, "beta.pdf");
    await act(async () => {
      hook().updateLastAssistantMessage(id, "first and more", A);
      hook().markTurn(id, 7, A);
      hook().setProviderSession("claude", "sess-A", A);
    });
    assert.equal(hook().session.annotations.length, 0, "nothing of alpha's leaks into beta");
    assert.equal(hook().session.providerSessions?.claude, undefined);

    // The parked paper is saved with what arrived
    await act(async () => { await wait(900); });
    const lastA = [...saved].reverse().find((s) => s.id === A);
    assert.ok(lastA, "alpha saved while parked");
    assert.equal(lastA.state.annotations[0].messages[1].content, "first and more");
    assert.equal(lastA.state.providerSessions?.claude, "sess-A");

    // Back to alpha: the streamed text is on screen, and further pieces land live
    await act(async () => { hook().setPdf("alpha.pdf", PDF, "pdf", "KEYA"); });
    assert.equal(hook().session.annotations[0].messages[1].content, "first and more");
    assert.equal(hook().session.annotations[0].messages[0].turn, 7);
    assert.equal(hook().session.providerSessions?.claude, "sess-A");
    assert.equal(hook().session.pdfDataUrl, PDF, "the document comes from the reopen, not the parked copy");
    await act(async () => { hook().updateLastAssistantMessage(id, "done", A); });
    assert.equal(hook().session.annotations[0].messages[1].content, "done");
  });

  test("an update with no paper named goes to the open one, as before", async () => {
    const { hook } = mount();
    await act(async () => { hook().setPdf("gamma.pdf", PDF, "pdf", "KEYG"); });
    await act(async () => { await wait(5); });
    let id = "";
    await act(async () => { id = hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }] }); });
    await act(async () => { hook().updateLastAssistantMessage(id, "here"); });
    assert.equal(hook().session.annotations[0].messages[1].content, "here");
  });

  test("a closed paper is written once more and then let go", async () => {
    const { hook } = mount();
    await act(async () => { hook().setPdf("delta.pdf", PDF, "pdf", "KEYD"); });
    await act(async () => { await wait(5); });
    const D = hook().paperId as string;
    let id = "";
    await act(async () => { id = hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }] }); });
    await act(async () => { hook().setPdf("epsilon.pdf", PDF, "pdf", "KEYE"); });
    await act(async () => { await wait(5); });
    await act(async () => { hook().updateLastAssistantMessage(id, "late", D); });
    saved.length = 0;
    await act(async () => { hook().forgetPaper(D); });
    assert.equal(saved.filter((s) => s.id === D).length, 1, "the pending save is written at once");
    assert.equal(saved[0].state.annotations[0].messages[1].content, "late");
    // Nothing more arrives for it, and nothing more is written
    await act(async () => { hook().updateLastAssistantMessage(id, "later still", D); });
    await act(async () => { await wait(900); });
    assert.equal(saved.filter((s) => s.id === D).length, 1);
    // Reopening it starts from disk, not from a stale parked copy
    await act(async () => { hook().setPdf("delta.pdf", PDF, "pdf", "KEYD"); });
    await act(async () => { await wait(5); });
    assert.equal(hook().session.annotations.length, 0);
  });
});
