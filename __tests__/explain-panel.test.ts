import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplainPanel } from "../components/ExplainPanel.js";
import type { Annotation, Message } from "../types/session.js";

// The waiting indicator has to sit where the answer will appear — under the
// question just asked. It used to render above the whole thread, so asking a
// follow-up in a long conversation looked like nothing had happened.

const thread = (messages: Message[]): Annotation => ({
  id: "a1",
  type: "text",
  label: "gradient descent",
  selectedText: "gradient descent",
  messages,
  createdAt: 0,
});

function render(annotation: Annotation, streaming: boolean): string {
  return renderToStaticMarkup(
    createElement(ExplainPanel, {
      annotations: [annotation],
      activeId: annotation.id,
      model: "claude-sonnet-4-6",
      streamingIds: streaming ? new Set([annotation.id]) : new Set<string>(),
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
