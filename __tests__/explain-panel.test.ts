// Must come first: react-dom decides at import time whether it is in a
// browser, and takes an IE-era code path if it is not.
import { dom, freshRoot } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplainPanel } from "../components/ExplainPanel.js";
import type { Annotation, Message } from "../types/session.js";
import { withQuotes } from "../lib/quotes.js";

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
  let root: Root;
  let host: HTMLElement;

  const mount = (annotations: Annotation[]) => {
    host = freshRoot();
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
  const boxes = () => host.querySelectorAll('textarea[placeholder^="Ask a follow-up"]').length;

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
  let host: HTMLElement;
  let stopped: string[];
  let edited: [string, number, string][];

  const mount = (annotations: Annotation[], streamingId?: string) => {
    stopped = [];
    edited = [];
    host = freshRoot();
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

  // Never assert on a DOM node: node:assert stringifies it for the failure
  // message, and inspecting a jsdom element exhausts the heap
  const editorOpen = () => !!button("Send again");

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

  test("Stop is on the conversation being answered, not only in the box", () => {
    // The box binds to whatever is nearest it, so scrolling to another
    // conversation took the only Stop control away mid-answer
    mount([CARD_B, LIVE], LIVE.id);
    const inCard = button("Stop generating");
    assert.ok(inCard, "expected a Stop beside the answer itself");
    click(inCard!);
    assert.deepEqual(stopped, [LIVE.id]);
  });

  test("a folded conversation can still be stopped from its header", () => {
    mount([LIVE], LIVE.id);
    const fold = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Collapse conversation"
    )!;
    click(fold);
    const stop = button("stop");
    assert.ok(stop, "a folded card that is still answering needs a way to stop it");
    click(stop!);
    assert.deepEqual(stopped, [LIVE.id]);
  });

  test("nothing to stop when nothing is streaming", () => {
    mount([LIVE]);
    assert.equal(button("Stop generating"), undefined);
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

    const box = host.querySelector("[data-editing] textarea") as HTMLTextAreaElement;
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
    assert.equal(editorOpen(), false, "the editor closes on send");
  });

  test("cancelling leaves the question as it was", () => {
    mount([LIVE]);
    click(Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Edit question")!);
    click(button("Cancel")!);
    assert.equal(editorOpen(), false);
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
  let host: HTMLElement;
  let asked: string[];

  const mount = (annotations: Annotation[]) => {
    asked = [];
    host = freshRoot();
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

describe("holding several quotes at once", () => {
  let host: HTMLElement;

  const mount = (annotations: Annotation[]) => {
    host = freshRoot();
    act(() => {
      createRoot(host).render(
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

  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

  const quote = (needle: string) => {
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
    act(() => {
      host.querySelector(".overflow-y-auto")!.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    click(button("Quote")!);
  };

  const chips = () => Array.from(host.querySelectorAll("[aria-label='Drop quote']"));

  test("passages from two conversations are held together and numbered", () => {
    mount([CARD_A, CARD_B]);
    quote("answer A");
    quote("answer B");
    assert.equal(chips().length, 2);
    assert.ok(host.textContent?.includes("[1]"));
    assert.ok(host.textContent?.includes("[2]"), "the second passage is addressable as [2]");
    assert.ok(host.textContent?.includes("(2)"), "the strip says how many are held");
  });

  test("each chip names the conversation it came from", () => {
    mount([CARD_A, CARD_B]);
    quote("answer A");
    quote("answer B");
    const strip = host.textContent ?? "";
    assert.ok(strip.includes("conversation A") && strip.includes("conversation B"));
  });

  test("the same passage twice stays one quote, so the numbers do not shift", () => {
    mount([CARD_A]);
    quote("answer A");
    quote("answer A");
    assert.equal(chips().length, 1);
  });

  test("clicking a quote writes its label into the box being typed in", () => {
    // The point of the labels: pointing at a passage without having to
    // remember which number it was
    mount([CARD_A, CARD_B]);
    quote("answer A");
    quote("answer B");

    // React's onFocus does not fire under jsdom, so this exercises the path
    // taken when no box has been focused yet: the label goes to the box the
    // reader would type in — the follow-up box, since it is showing.
    const label2 = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith("[2]"));
    assert.ok(label2, "expected a clickable [2] chip");
    click(label2!);

    const box = host.querySelector('textarea[placeholder^="Ask a follow-up"]') as HTMLInputElement;
    assert.ok(box.value.includes("[2]"), `expected [2] in the question, got ${JSON.stringify(box.value)}`);
  });

  test("with no conversation to follow up on, the label lands in the paper composer", () => {
    mount([CARD_A]);
    quote("answer A");
    // fold the only conversation, so the follow-up box retires
    click(Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Collapse conversation")!);
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith("[1]"))!);
    const composer = host.querySelector('textarea[data-composer="general"]') as HTMLInputElement;
    assert.ok(composer.value.includes("[1]"), `expected [1] in the composer, got ${JSON.stringify(composer.value)}`);
  });

  test("dropping one renumbers the rest, so the labels stay contiguous", () => {
    mount([CARD_A, CARD_B]);
    quote("answer A");
    quote("answer B");
    click(chips()[0]);                       // drop [1]
    assert.equal(chips().length, 1);
    assert.ok(host.textContent?.includes("[1]"), "what was [2] becomes [1]");
    assert.equal(host.textContent?.includes("[2]"), false);
    assert.ok(host.textContent?.includes("conversation B"), "and it is still B's passage");
  });
});

// ── Where the panel lands ─────────────────────────────────────────────
describe("landing point after a turn", () => {
  let host: HTMLElement;
  let root: Root;
  let scrolls: { block?: string }[];
  const refs = { current: {} as Record<string, HTMLDivElement | null> };

  const setup = () => {
    scrolls = [];
    dom.window.Element.prototype.scrollIntoView = function (opts?: boolean | ScrollIntoViewOptions) {
      scrolls.push(typeof opts === "object" && opts ? opts : {});
    };
    refs.current = {};
    host = freshRoot();
    root = createRoot(host);
  };

  const show = (annotations: Annotation[], activeId: string | null) => {
    act(() => {
      root.render(
        createElement(ExplainPanel, {
          annotations,
          activeId,
          model: "claude-sonnet-4-6",
          streamingIds: new Set<string>(),
          onFollowUp: () => {},
          onAskGeneral: () => {},
          onDelete: () => {},
          onReExplainImage: () => {},
          onViewInPdf: () => {},
          annotationRefs: refs,
          isOpen: true,
          onToggle: () => {},
        })
      );
    });
  };

  const withTurns = (n: number, id = "a1") =>
    thread(
      Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? { role: "user" as const, content: `q${i}` } : { role: "assistant" as const, content: `a${i}` }
      ),
      id,
      "conversation A"
    );

  test("arriving at a conversation lands at its beginning", () => {
    setup();
    show([withTurns(4)], null);
    show([withTurns(4)], "a1");
    assert.deepEqual(scrolls.map((s) => s.block), ["start"]);
  });

  test("asking something lands at the end, where the answer is forming", () => {
    setup();
    show([withTurns(4)], "a1");        // arrive
    scrolls.length = 0;
    show([withTurns(6)], "a1");        // a follow-up adds a turn
    assert.deepEqual(scrolls.map((s) => s.block), ["end"], "not the top of a thread already read");
  });

  test("asking in another conversation lands at that one's end", () => {
    setup();
    show([withTurns(4, "a1"), withTurns(4, "b2")], "a1");
    show([withTurns(4, "a1"), withTurns(4, "b2")], "b2");   // visit B
    scrolls.length = 0;
    show([withTurns(4, "a1"), withTurns(6, "b2")], "b2");   // ask in B
    assert.deepEqual(scrolls.map((s) => s.block), ["end"]);
  });

  test("a streaming answer does not drag the scrollbar around", () => {
    setup();
    show([withTurns(4)], "a1");
    scrolls.length = 0;
    // the answer is rewritten in place as text arrives — same number of turns
    const growing = thread(
      [
        { role: "user", content: "q0" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "partial…" },
      ],
      "a1",
      "conversation A"
    );
    show([growing], "a1");
    const more = thread(
      [
        { role: "user", content: "q0" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "partial… and more text" },
      ],
      "a1",
      "conversation A"
    );
    show([more], "a1");
    assert.deepEqual(scrolls, [], "no scrolling while the text fills in");
  });
});

describe("question boxes hold more than one line", () => {
  // They were single-line <input>s: a newline could not be typed at all, and a
  // long question scrolled sideways with its own beginning off screen. Growth
  // itself needs layout, which jsdom has none of — this guards the element type
  // the behaviour depends on.
  test("both question boxes are textareas, not single-line inputs", () => {
    const html = renderPanel([CARD_A]);
    assert.match(html, /<textarea[^>]*placeholder="Ask a follow-up/);
    assert.match(html, /<textarea[^>]*data-composer="general"/);
    assert.equal(/<input[^>]*placeholder="Ask a follow-up/.test(html), false);
    assert.equal(/<input[^>]*data-composer="general"/.test(html), false);
  });

  test("they do not show a resize grip — the height is managed", () => {
    const html = renderPanel([CARD_A]);
    // Read the whole tag: attribute order is not something to depend on
    const at = html.indexOf("Ask a follow-up");
    const tag = html.slice(html.lastIndexOf("<textarea", at), html.indexOf(">", at));
    assert.match(tag, /resize-none/);
    assert.match(tag, /pr-autosize/, "and the engine sizes it where it can");
  });
});

// ── Quote links ───────────────────────────────────────────────────────
// A quote is only half a connection if it goes one way. The passage has to
// carry a visible mark back to the question that used it, and the question has
// to lead back to the passage — otherwise "why does [1] contradict [2]?" is
// still an answer the reader has to go hunting through the panel to check.
describe("jumping between a passage and the question that quoted it", () => {
  const PASSAGE = "The kernel is bandwidth bound";
  const QUESTION = "does that still hold on H100?";

  const SOURCE = thread(
    [
      { role: "user", content: "what is this" },
      { role: "assistant", content: `${PASSAGE} at this size.` },
    ],
    "a1",
    "conversation A"
  );
  const ASKER = thread(
    [
      { role: "user", content: withQuotes(QUESTION, [{ id: "q", text: PASSAGE, source: "conversation A" }]) },
      { role: "assistant", content: "Yes, more so." },
    ],
    "b2",
    "conversation B"
  );

  let host: HTMLElement;
  let root: Root;
  const refs = { current: {} as Record<string, HTMLDivElement | null> };

  const show = (annotations: Annotation[], streaming?: string) => {
    act(() => {
      root.render(
        createElement(ExplainPanel, {
          annotations,
          activeId: null,
          model: "claude-sonnet-4-6",
          streamingIds: new Set(streaming ? [streaming] : []),
          onFollowUp: () => {},
          onAskGeneral: () => {},
          onEditMessage: () => {},
          onDelete: () => {},
          onReExplainImage: () => {},
          onViewInPdf: () => {},
          annotationRefs: refs,
          isOpen: true,
          onToggle: () => {},
        })
      );
    });
  };

  const mount = (annotations: Annotation[] = [SOURCE, ASKER], streaming?: string) => {
    refs.current = {};
    host = freshRoot();
    root = createRoot(host);
    show(annotations, streaming);
  };

  const marks = () => Array.from(host.querySelectorAll("mark.pr-quoted"));
  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  // The jump unfolds, waits for that render, then scrolls — so it lands a frame later
  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  const flashed = () => host.querySelector(".pr-quote-flash");
  const chip = () =>
    Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("title")?.startsWith("Go back to this passage"));

  test("the passage is underlined where it was written", () => {
    mount();
    assert.equal(marks().length, 1);
    assert.equal(marks()[0].textContent, PASSAGE);
  });

  test("it is marked in the conversation it came from, not the one that quoted it", () => {
    mount();
    const card = marks()[0].closest("[data-conversation]") as HTMLElement;
    assert.equal(card.dataset.conversation, "conversation A");
  });

  test("nothing is underlined until a question actually quotes something", () => {
    mount([SOURCE]);
    assert.equal(marks().length, 0);
  });

  test("the question shows what was typed, not the machinery that carried the quote", () => {
    mount();
    const text = host.textContent ?? "";
    assert.ok(text.includes(QUESTION));
    assert.equal(text.includes("A passage I selected"), false, "the wrapper is for the model, not the reader");
  });

  test("the question carries a chip naming the passage it points at", () => {
    mount();
    const c = chip();
    assert.ok(c, "expected a way back to the passage from the question");
    assert.ok(c!.textContent?.includes("[1]"), "labelled as it was in the prompt");
    assert.ok(c!.getAttribute("title")?.includes("conversation A"), "and credited to its conversation");
  });

  test("clicking the underlined passage lands on the question that quoted it", async () => {
    mount();
    click(marks()[0]);
    await settle();
    const landed = flashed();
    assert.ok(landed, "expected the jump to say where it arrived");
    assert.ok(landed!.textContent?.includes(QUESTION));
  });

  test("clicking the chip lands back on the passage — the same link, travelled backwards", async () => {
    mount();
    click(chip()!);
    await settle();
    const landed = flashed();
    assert.ok(landed, "expected to land somewhere");
    assert.equal(landed!.tagName, "MARK");
    assert.equal(landed!.textContent, PASSAGE);
  });

  test("a folded conversation unfolds itself rather than swallowing the jump", async () => {
    mount();
    const fold = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Collapse conversation"
    );
    click(fold!);
    assert.equal(marks().length, 0, "sanity: a folded conversation has nothing to mark");
    click(chip()!);
    await settle();
    assert.equal(marks().length, 1, "the source conversation is open again");
    assert.equal(flashed()?.textContent, PASSAGE);
  });

  test("a conversation still being answered is left unmarked", () => {
    // Its text is being rewritten chunk by chunk; wrapping marks around it
    // mid-flight would fight React for the same nodes
    mount([SOURCE, ASKER], "a1");
    assert.equal(marks().length, 0);
    show([SOURCE, ASKER]);
    assert.equal(marks().length, 1, "and marked again once the answer is done");
  });

  test("rewriting a question keeps the passage it pointed at", () => {
    // The editor shows the typed question alone — the quote must survive it
    mount();
    const asker = host.querySelector('[data-conversation="conversation B"]')!;
    click(asker.querySelector('button[aria-label="Edit question"]')!);
    const box = host.querySelector("[data-editing] textarea") as HTMLTextAreaElement;
    assert.equal(box.value, QUESTION, "the editor holds the question, not the wrapper");
  });
});


// The follow-up box belongs to whichever conversation you are reading, which is
// often not the one that was last clicked. Asking in any other one used to look
// like arriving there for the first time, and landed at the top of a thread you
// had just written into.
describe("landing after asking in a conversation you had not clicked", () => {
  let host: HTMLElement;
  let root: Root;
  let scrolls: { block?: string }[];
  const refs = { current: {} as Record<string, HTMLDivElement | null> };

  const setup = () => {
    scrolls = [];
    dom.window.Element.prototype.scrollIntoView = function (opts?: boolean | ScrollIntoViewOptions) {
      scrolls.push(typeof opts === "object" && opts ? opts : {});
    };
    refs.current = {};
    host = freshRoot();
    root = createRoot(host);
  };

  const show = (annotations: Annotation[], activeId: string | null) => {
    act(() => {
      root.render(
        createElement(ExplainPanel, {
          annotations, activeId, model: "m", streamingIds: new Set<string>(),
          onFollowUp: () => {}, onAskGeneral: () => {}, onDelete: () => {},
          onReExplainImage: () => {}, onViewInPdf: () => {},
          annotationRefs: refs, isOpen: true, onToggle: () => {},
        })
      );
    });
  };

  const turns = (n: number, id: string) =>
    thread(
      Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? { role: "user" as const, content: `q${i}` } : { role: "assistant" as const, content: `a${i}` }
      ),
      id,
      `conversation ${id}`
    );

  test("lands at the end, not the top of the thread just written into", () => {
    setup();
    // Reading A; B is on screen further down and is where the box is bound
    show([turns(4, "a1"), turns(4, "b2")], "a1");
    scrolls.length = 0;
    // A follow-up asked in B: two messages appear and B becomes active
    show([turns(4, "a1"), turns(6, "b2")], "b2");
    assert.deepEqual(scrolls.map((s) => s.block), ["end"]);
  });

  test("but a conversation merely opened still lands at its beginning", () => {
    setup();
    show([turns(4, "a1"), turns(4, "b2")], "a1");
    scrolls.length = 0;
    show([turns(4, "a1"), turns(4, "b2")], "b2");   // clicked, nothing added
    assert.deepEqual(scrolls.map((s) => s.block), ["start"]);
  });

  test("a brand-new conversation lands at its beginning too", () => {
    setup();
    show([turns(4, "a1")], "a1");
    scrolls.length = 0;
    show([turns(4, "a1"), turns(2, "c3")], "c3");   // a fresh explain
    assert.deepEqual(scrolls.map((s) => s.block), ["start"]);
  });
});
