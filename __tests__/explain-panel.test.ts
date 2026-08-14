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
  test("there is one box, not one per conversation", () => {
    // Kept inside a card it either scrolled away with the card or, when
    // sticky, detached at the card's bottom edge and left a gap above the
    // paper composer — a sticky element cannot travel past its containing block
    assert.equal(countFollowUps(renderPanel([CARD_A, CARD_B])), 1);
    assert.equal(countFollowUps(renderPanel([CARD_A])), 1);
  });

  test("it sits after the whole list, flush above the paper composer", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    assert.ok(
      html.indexOf(FOLLOW_UP) > html.lastIndexOf("answer B"),
      "the box must come after the last conversation, not inside the scrolling list"
    );
    assert.ok(
      html.indexOf(FOLLOW_UP) < html.indexOf("Ask anything about the paper"),
      "and before the paper composer"
    );
  });

  test("it says which conversation it will post to", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    assert.ok(html.includes("Follow up on"));
    const bar = html.slice(html.indexOf("Follow up on"));
    assert.ok(bar.includes("conversation B"), "binds to the conversation nearest the bar");
  });

  test("no conversations, no bar", () => {
    assert.equal(countFollowUps(renderPanel([])), 0);
  });
});

describe("folding is reachable without hunting", () => {
  test("every card carries a dedicated fold button, not just a clickable title", () => {
    const html = renderPanel([CARD_A, CARD_B]);
    assert.equal((html.match(/aria-label="Collapse conversation"/g) || []).length, 2);
  });

  test("the header is still a toggle target in its own right", () => {
    assert.equal((renderPanel([CARD_A, CARD_B]).match(/aria-expanded="true"/g) || []).length, 2);
  });

  test("the follow-up bar can fold the conversation it is pointed at", () => {
    assert.ok(renderPanel([CARD_A]).includes("fold"));
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
    // Browser globals the panel uses directly; jsdom hangs them off its window
    g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
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

  test("folding one conversation hides its messages, leaving the others alone", () => {
    mount([CARD_A, CARD_B]);
    assert.ok(host.textContent?.includes("answer A"));

    click(headers()[0]);
    assert.equal(host.textContent?.includes("answer A"), false, "A is folded away");
    assert.ok(host.textContent?.includes("answer B"), "B is untouched");
    assert.equal(headers()[0].getAttribute("aria-expanded"), "false");
  });

  test("the dedicated fold button works, not just the header", () => {
    mount([CARD_A]);
    const fold = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Collapse conversation"
    )!;
    assert.ok(fold, "expected a fold button on the card");
    click(fold);
    assert.equal(host.textContent?.includes("answer A"), false);
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

  test("folding the conversation the bar points at retires the bar", () => {
    mount([CARD_A]);
    assert.equal(boxes(), 1);
    click(headers()[0]);
    assert.equal(boxes(), 0, "a folded conversation is not one you are writing to");
  });

  test("folding the last conversation keeps the box, pointed at one still open", () => {
    // A folded card is barely any height, so scrolling to the bottom puts it
    // nearest the box — which used to take the box away entirely, even with an
    // open conversation sitting right above it
    mount([CARD_A, CARD_B]);
    click(headers()[1]);                       // fold the last one
    assert.equal(boxes(), 1, "there is still an open conversation to write to");
    const bar = host.textContent?.slice(host.textContent.indexOf("Follow up on")) ?? "";
    assert.ok(bar.includes("conversation A"), "the box points at the open conversation");
  });

  test("folding every one is the only thing that retires the box", () => {
    mount([CARD_A, CARD_B]);
    click(headers()[1]);
    assert.equal(boxes(), 1);
    click(headers()[0]);
    assert.equal(boxes(), 0);
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
    assert.equal(boxes(), 1, "one bar, for the conversation nearest it");
    assert.ok(host.textContent?.includes("answer A") && host.textContent?.includes("answer B"));
  });
});

// ── Stop / edit / resend ──────────────────────────────────────────────
describe("stopping and rewriting", () => {
  let dom: JSDOM;
  let host: HTMLElement;
  let stopped: string[];
  let edited: [string, number, string][];

  const mount = (annotations: Annotation[], streamingId?: string) => {
    dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { pretendToBeVisual: true });
    const g = globalThis as Record<string, unknown>;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window;
    g.document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
    g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    stopped = [];
    edited = [];
    host = dom.window.document.getElementById("root") as unknown as HTMLElement;
    act(() => {
      createRoot(host).render(
        createElement(ExplainPanel, {
          annotations,
          activeId: null,
          model: "claude-sonnet-4-6",
          streamingIds: streamingId ? new Set([streamingId]) : new Set<string>(),
          onFollowUp: () => {},
          onStop: (id: string) => stopped.push(id),
          onEditMessage: (id: string, i: number, t: string) => edited.push([id, i, t]),
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

  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

  const LIVE = thread(
    [{ role: "user", content: "why two stages" }, { role: "assistant", content: "partial answer so far" }],
    "a1",
    "live"
  );

  test("Stop replaces Ask while an answer is arriving, and reports the conversation", () => {
    mount([LIVE], LIVE.id);
    const stop = button("Stop");
    assert.ok(stop, "expected a Stop control while streaming");
    assert.equal(button("Ask a follow-up") ?? undefined, undefined);
    click(stop!);
    assert.deepEqual(stopped, [LIVE.id]);
  });

  test("Ask comes back once the answer is done", () => {
    mount([LIVE]);
    assert.equal(button("Stop"), undefined);
    assert.ok(button("Ask"));
  });

  test("editing opens a box prefilled with what was asked", () => {
    mount([LIVE]);
    const edit = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Edit question"
    );
    assert.ok(edit, "expected an edit control on the question");
    click(edit!);

    const box = host.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(box, "editing opens a box");
    assert.equal(box.value, "why two stages", "prefilled, so a typo can be fixed rather than retyped");
  });

  test("sending posts the draft back with the conversation and the position in it", () => {
    // React 19 does not deliver a synthetic input event to onChange under
    // jsdom, so the keystrokes themselves cannot be simulated here — this
    // covers the wiring either side of them: which conversation, which message.
    mount([LIVE]);
    click(Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Edit question")!);
    click(button("Send again")!);
    assert.deepEqual(edited, [[LIVE.id, 0, "why two stages"]]);
    assert.equal(host.querySelector("textarea"), null, "the editor closes on send");
  });

  test("cancelling leaves the question as it was", () => {
    mount([LIVE]);
    click(Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Edit question")!);
    click(button("Cancel")!);
    assert.equal(host.querySelector("textarea"), null);
    assert.deepEqual(edited, []);
    assert.ok(host.textContent?.includes("why two stages"));
  });

  test("answers are not editable — only what you asked", () => {
    mount([LIVE]);
    const edits = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-label") === "Edit question"
    );
    assert.equal(edits.length, 1, "one control, on the one user message");
  });
});

// ── Quoting across conversations ──────────────────────────────────────
describe("quoting a passage out of a conversation", () => {
  let dom: JSDOM;
  let host: HTMLElement;
  let asked: string[];

  const mount = (annotations: Annotation[]) => {
    dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { pretendToBeVisual: true });
    const g = globalThis as Record<string, unknown>;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window;
    g.document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
    g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    // jsdom has no layout, so Range geometry is missing entirely — the panel
    // uses it to place the quote button over the selection
    dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(20, 40, 80, 16);
    dom.window.Range.prototype.getClientRects = (() => []) as unknown as Range["getClientRects"];
    asked = [];
    host = dom.window.document.getElementById("root") as unknown as HTMLElement;
    quoteRoot = createRoot(host);
    renderWith(annotations, true);
  };

  let quoteRoot: Root;
  const renderWith = (annotations: Annotation[], isOpen: boolean) => {
    act(() => {
      quoteRoot.render(
        createElement(ExplainPanel, {
          annotations,
          activeId: null,
          model: "claude-sonnet-4-6",
          streamingIds: new Set<string>(),
          onFollowUp: (_id: string, q: string) => asked.push(q),
          onAskGeneral: (q: string) => asked.push(q),
          onDelete: () => {},
          onReExplainImage: () => {},
          onViewInPdf: () => {},
          annotationRefs: { current: {} },
          isOpen,
          onToggle: () => {},
        })
      );
    });
  };

  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

  // Select a run of text inside one conversation, the way a drag would
  const selectInside = (needle: string) => {
    const walker = dom.window.document.createTreeWalker(host, dom.window.NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (t.data.includes(needle)) { node = t; break; }
    }
    assert.ok(node, `no text node containing ${needle}`);
    const range = dom.window.document.createRange();
    const at = node!.data.indexOf(needle);
    range.setStart(node!, at);
    range.setEnd(node!, at + needle.length);
    const sel = dom.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const list = host.querySelector(".overflow-y-auto")!;
    act(() => { list.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true })); });
  };

  test("selecting inside a conversation offers to quote it", () => {
    mount([CARD_A, CARD_B]);
    assert.equal(button("Quote"), undefined, "nothing offered before a selection");
    selectInside("answer A");
    assert.ok(button("Quote"), "expected a quote control over the selection");
  });

  test("quoting shows the passage, credited to the conversation it came from", () => {
    mount([CARD_A, CARD_B]);
    selectInside("answer A");
    click(button("Quote")!);
    assert.ok(host.textContent?.includes("Quoting"), "the pending quote is visible");
    assert.ok(host.textContent?.includes("answer A"));
    const chip = Array.from(host.querySelectorAll("[title]")).find((el) => el.getAttribute("title")?.includes("answer A"));
    assert.ok(chip?.getAttribute("title")?.includes("conversation A"), "credited to its conversation");
  });

  test("a quote taken from one conversation survives to be used in another", () => {
    // The whole point: the panel is one workspace, not two chats
    mount([CARD_A, CARD_B]);
    selectInside("answer A");
    click(button("Quote")!);
    // the follow-up box is bound to conversation B, and the quote is still held
    const bar = host.textContent?.slice(host.textContent.indexOf("Follow up on")) ?? "";
    assert.ok(bar.includes("conversation B"), "asking into B");
    assert.ok(host.textContent?.includes("Quoting"), "with A's passage still attached");
  });

  test("quotes can be dropped individually and all at once", () => {
    mount([CARD_A, CARD_B]);
    selectInside("answer A");
    click(button("Quote")!);
    assert.ok(host.textContent?.includes("Quoting"));
    click(button("clear")!);
    assert.equal(host.textContent?.includes("Quoting"), false);
  });

  test("works after the panel opens — the order it actually starts in", () => {
    // The panel starts closed and empty: the scrolling list it listens on does
    // not exist yet. Attaching once on mount meant quoting never worked at all
    // in the real app, only in tests that mounted straight into the open state.
    mount([]);                    // mounted open but empty — no list yet
    renderWith([], false);        // closed, as the saved layout has it
    renderWith([CARD_A, CARD_B], true);   // a question arrives and the panel opens
    selectInside("answer A");
    assert.ok(button("Quote"), "quoting has to work on a panel that opened later");
  });

  test("selecting outside a conversation offers nothing", () => {
    mount([CARD_A]);
    const sel = dom.window.getSelection()!;
    sel.removeAllRanges();
    const list = host.querySelector(".overflow-y-auto")!;
    act(() => { list.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true })); });
    assert.equal(button("Quote"), undefined);
  });
});
