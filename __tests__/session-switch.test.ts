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

  test("a summary that finishes after the switch lands in its own paper too", async () => {
    const { hook } = mount();
    await act(async () => { hook().setPdf("zeta.pdf", PDF, "pdf", "KEYZ"); });
    await act(async () => { await wait(5); });
    const Z = hook().paperId as string;
    let id = "";
    await act(async () => { id = hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }); });
    await act(async () => { hook().setPdf("eta.pdf", PDF, "pdf", "KEYH"); });
    await act(async () => { await wait(5); });
    // The thread is still readable where it is parked, and its notes go there
    assert.equal(hook().readPaper(Z)?.annotations[0].id, id);
    assert.equal(hook().readPaper()?.pdfName, "eta.pdf");
    await act(async () => { hook().setTakeaways(id, ["what it settled"], 2, Z); });
    assert.equal(hook().session.concepts.length, 0);
    await act(async () => { hook().setPdf("zeta.pdf", PDF, "pdf", "KEYZ"); });
    assert.deepEqual(hook().session.concepts[0].takeaways, ["what it settled"]);
    assert.equal(hook().session.concepts[0].summarizedTurns, 2);
  });

  test("coming back to the surface restores the paper from memory, without fetching or re-saving it", async () => {
    const first = mount();
    await act(async () => { first.hook().setPdf("theta.pdf", PDF, "pdf", "KEYT"); });
    await act(async () => { await wait(5); });
    let id = "";
    await act(async () => { id = first.hook().addAnnotation({ type: "text", selectedText: "x", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }); });
    await act(async () => { await wait(900); });
    const T = first.hook().paperId as string;
    assert.ok(saved.some((s) => s.id === T), "the first save went out");
    storage.set("paper-reader:last-session", T);
    // The surface is left and come back to: a fresh mount of the hook
    const gets: string[] = [];
    const prior = globalThis.fetch as typeof fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; body?: string }) => { if (!init?.method) gets.push(url); return prior(url as never, init as never); };
    saved.length = 0;
    const second = mount();
    await act(async () => { await wait(20); });
    assert.equal(second.hook().session.pdfName, "theta.pdf");
    assert.equal(second.hook().session.annotations[0]?.id, id, "the conversation is there as left");
    assert.deepEqual(gets.filter((u) => u.includes("/api/sessions")), [], "no fetch of the saved session");
    await act(async () => { await wait(900); });
    assert.deepEqual(saved.filter((s) => s.id === T), [], "nothing is written back that was not changed");
    (globalThis as Record<string, unknown>).fetch = prior;
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
