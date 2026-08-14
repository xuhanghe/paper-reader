import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplainPanel } from "../components/ExplainPanel.js";
import type { Annotation, Message } from "../types/session.js";

// The waiting indicator has to sit where the answer will appear — under the
// question just asked. It used to render above the whole thread, so asking a
// follow-up in a long conversation looked like nothing had happened.

const thread = (messages: Message[], id = "a1", label = "gradient descent"): Annotation => ({
  id,
  type: "text",
  label,
  selectedText: label,
  messages,
  createdAt: 0,
});

function renderPanel(annotations: Annotation[], streamingId?: string, activeId: string | null = null): string {
  return renderToStaticMarkup(
    createElement(ExplainPanel, {
      annotations,
      activeId,
      model: "claude-sonnet-4-6",
      streamingIds: streamingId ? new Set([streamingId]) : new Set<string>(),
      onFollowUp: () => {},
      onAskGeneral: () => {},
      onDelete: () => {},
      onReExplainImage: () => {},
      onViewInPdf: () => {},
      annotationRefs: { current: {} },
      isOpen: true,
      onToggle: () => {},
    })
  );
}

function render(annotation: Annotation, streaming: boolean): string {
  return renderPanel([annotation], streaming ? annotation.id : undefined, annotation.id);
}

const FOLLOW_UP = "Ask a follow-up";
const countFollowUps = (html: string) => html.split(FOLLOW_UP).length - 1;

const FIRST_Q = "what does this mean";
const FIRST_A = "It is an optimisation method.";
const LATEST_Q = "why is the learning rate needed";

// Mid-flight follow-up: every ask seeds an empty assistant message first
const MID_FOLLOWUP = thread([
  { role: "user", content: FIRST_Q },
  { role: "assistant", content: FIRST_A },
  { role: "user", content: LATEST_Q },
  { role: "assistant", content: "" },
]);

describe("waiting indicator placement", () => {
  test("waits below the latest question, not above the thread", () => {
    const html = render(MID_FOLLOWUP, true);
    const thinking = html.indexOf("Thinking");
    const latest = html.indexOf(LATEST_Q);
    const earliest = html.indexOf(FIRST_Q);

    assert.notEqual(thinking, -1, "expected a waiting indicator while streaming");
    assert.ok(thinking > latest, "the indicator must come after the question just asked");
    assert.ok(latest > earliest, "sanity: the thread renders oldest-first");
  });

  test("it is the last thing in the thread — nothing answered after it", () => {
    const html = render(MID_FOLLOWUP, true);
    assert.ok(html.indexOf("Thinking") > html.indexOf(FIRST_A));
  });

  test("appears exactly once", () => {
    assert.equal(render(MID_FOLLOWUP, true).match(/Thinking/g)?.length, 1);
  });
});

describe("waiting indicator lifecycle", () => {
  test("gives way to the answer as soon as text arrives", () => {
    const answering = thread([
      { role: "user", content: LATEST_Q },
      { role: "assistant", content: "Because the step size controls" },
    ]);
    const html = render(answering, true);
    assert.equal(html.includes("Thinking"), false);
    assert.ok(html.includes("Because the step size controls"));
  });

  test("no indicator when nothing is streaming", () => {
    assert.equal(render(MID_FOLLOWUP, false).includes("Thinking"), false);
  });

  test("a first explain waits in its own empty bubble too", () => {
    const opening = thread([{ role: "assistant", content: "" }]);
    assert.ok(render(opening, true).includes("Thinking"));
  });

  test("an earlier empty answer is not mistaken for the live one", () => {
    // Only the newest message is where a reply is about to land
    const stale = thread([
      { role: "user", content: FIRST_Q },
      { role: "assistant", content: "" },
      { role: "user", content: LATEST_Q },
      { role: "assistant", content: "answered" },
    ]);
    assert.equal(render(stale, true).includes("Thinking"), false);
  });
});

// ── Follow-up box placement ───────────────────────────────────────────
// The box must stay reachable while scrolling back through a long answer, and
// with several conversations open the one at the bottom has to belong to the
// conversation you are actually looking at.

const CARD_A = thread([{ role: "user", content: "q about A" }, { role: "assistant", content: "answer A" }], "a1", "conversation A");
const CARD_B = thread([{ role: "user", content: "q about B" }, { role: "assistant", content: "answer B" }], "b2", "conversation B");

describe("follow-up box stays reachable", () => {
  test("is pinned to the bottom of the panel rather than scrolling away", () => {
    const html = renderPanel([CARD_A]);
    const box = html.slice(html.indexOf(FOLLOW_UP) - 800, html.indexOf(FOLLOW_UP));
    assert.match(box, /sticky/, "the follow-up box should be sticky-positioned");
    assert.match(box, /bottom-0/);
  });

  test("its card does not clip it — overflow-hidden would trap it in the card", () => {
    // position:sticky resolves against the nearest clipping ancestor, so an
    // expanded card must not create one
    const html = renderPanel([CARD_A]);
    const cardStart = html.indexOf("conversation A");
    const card = html.slice(Math.max(0, cardStart - 500), cardStart);
    assert.equal(/overflow-hidden/.test(card), false, "expanded card must not clip");
  });
});

describe("one box per conversation", () => {
  test("each open conversation carries its own box", () => {
    assert.equal(countFollowUps(renderPanel([CARD_A, CARD_B])), 2);
  });

  test("each box sits inside its own conversation, not pooled at the end", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    const a = html.indexOf("conversation A");
    const b = html.indexOf("conversation B");
    assert.ok(a < b, "sanity: A renders before B");
    // exactly one box between A and B, and one after B
    assert.equal(countFollowUps(html.slice(a, b)), 1, "A needs its own box before B starts");
    assert.equal(countFollowUps(html.slice(b)), 1, "B needs its own box after it");
  });
});

describe("folding conversations", () => {
  test("an open conversation shows its messages and its box", () => {
    const html = renderPanel([CARD_A]);
    assert.ok(html.includes("answer A"));
    assert.equal(countFollowUps(html), 1);
  });

  test("the header offers a fold control once there is more than one", () => {
    assert.ok(renderPanel([CARD_A, CARD_B]).includes("collapse all"));
    assert.equal(renderPanel([CARD_A]).includes("collapse all"), false);
  });

  test("conversations start open, so nothing changes for existing readers", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    assert.ok(html.includes("answer A") && html.includes("answer B"));
  });

  test("the fold control is a real toggle target on every card", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    assert.equal((html.match(/aria-expanded="true"/g) || []).length, 2);
  });
});

// Folding is interactive state, so static rendering cannot reach it — these
// mount the panel for real and click the header.
describe("folding hides the conversation", () => {
  let dom: JSDOM;
  let root: Root;
  let host: HTMLElement;

  const mount = (annotations: Annotation[]) => {
    dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { pretendToBeVisual: true });
    const g = globalThis as Record<string, unknown>;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window;
    g.document = dom.window.document;
    // navigator is a getter-only global on modern Node, so it has to be
    // redefined rather than assigned
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
      configurable: true,
      writable: true,
    });
    host = dom.window.document.getElementById("root") as unknown as HTMLElement;
    root = createRoot(host);
    act(() => {
      root.render(
        createElement(ExplainPanel, {
          annotations,
          activeId: null,
          model: "claude-sonnet-4-6",
          streamingIds: new Set<string>(),
          onFollowUp: () => {},
          onAskGeneral: () => {},
          onDelete: () => {},
          onReExplainImage: () => {},
          onViewInPdf: () => {},
          annotationRefs: { current: {} },
          isOpen: true,
          onToggle: () => {},
        })
      );
    });
  };

  const headers = () => Array.from(host.querySelectorAll('[aria-expanded]')) as HTMLElement[];
  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const boxes = () => host.querySelectorAll('input[placeholder^="Ask a follow-up"]').length;

  test("folding one conversation hides its messages and its box", () => {
    mount([CARD_A, CARD_B]);
    assert.equal(boxes(), 2, "both open to begin with");

    click(headers()[0]);
    assert.equal(host.textContent?.includes("answer A"), false, "A's messages are folded away");
    assert.ok(host.textContent?.includes("answer B"), "B is untouched");
    assert.equal(boxes(), 1, "only the open conversation keeps a box");
    assert.equal(headers()[0].getAttribute("aria-expanded"), "false");
  });

  test("the folded card still says how much is hidden", () => {
    mount([CARD_A]);
    click(headers()[0]);
    assert.match(host.textContent || "", /1 reply/);
    assert.ok(host.textContent?.includes("conversation A"), "the label stays readable when folded");
  });

  test("unfolding brings it back", () => {
    mount([CARD_A]);
    click(headers()[0]);
    click(headers()[0]);
    assert.ok(host.textContent?.includes("answer A"));
    assert.equal(boxes(), 1);
  });

  test("collapse all folds every conversation, then restores them", () => {
    mount([CARD_A, CARD_B]);
    const toggle = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("collapse all"))!;
    assert.ok(toggle, "expected a collapse-all control");
    click(toggle);
    assert.equal(boxes(), 0, "nothing is open");
    assert.equal(host.textContent?.includes("answer A"), false);

    const expand = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("expand all"))!;
    click(expand);
    assert.equal(boxes(), 2);
    assert.ok(host.textContent?.includes("answer A") && host.textContent?.includes("answer B"));
  });
});
