import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { clearMarks, markTextInContainer, rangeForText } from "../lib/highlight-dom.js";

// Painting is what the reader actually shows, and it is shared by both viewers:
// the PDF.js text layer and — since HTML snapshots gained highlights — the body
// of a snapshot inside its iframe. These run against a real DOM.

let dom: JSDOM;

before(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  // locateText reads NodeFilter off the global, as it does in a browser
  (globalThis as { NodeFilter?: unknown }).NodeFilter = dom.window.NodeFilter;
});

let body: HTMLElement;
const setBody = (html: string) => {
  dom.window.document.body.innerHTML = html;
  body = dom.window.document.body as unknown as HTMLElement;
};

beforeEach(() => setBody(""));

const marks = () => Array.from(body.querySelectorAll("mark.pr-highlight"));

describe("markTextInContainer", () => {
  test("wraps the passage and carries the id and colour", () => {
    setBody("<p>the quick brown fox</p>");
    assert.equal(markTextInContainer(body, "brown", "pr-highlight", "a note", { id: "h1", color: "#ffd400" }), true);
    const [mark] = marks() as HTMLElement[];
    assert.equal(mark.textContent, "brown");
    assert.equal(mark.dataset.highlightId, "h1");
    assert.equal(mark.title, "a note");
    assert.match(mark.style.background, /255, 212, 0|#ffd400/);
  });

  test("reports false when the passage is absent, so the caller can fall back", () => {
    setBody("<p>the quick brown fox</p>");
    assert.equal(markTextInContainer(body, "kernel", "pr-highlight"), false);
    assert.equal(marks().length, 0);
  });

  test("spans element boundaries as one highlight in several marks", () => {
    setBody("<p>the <em>quick</em> brown fox</p>");
    assert.equal(markTextInContainer(body, "quick brown", "pr-highlight", undefined, { id: "h1" }), true);
    const found = marks() as HTMLElement[];
    assert.ok(found.length > 1, `expected several marks, got ${found.length}`);
    assert.deepEqual([...new Set(found.map((m) => m.dataset.highlightId))], ["h1"]);
    assert.equal(found.map((m) => m.textContent).join(""), "quick brown");
  });

  test("matches across a tag boundary that splits a word", () => {
    setBody("<p>Top<span>K</span> kernel</p>");
    assert.equal(markTextInContainer(body, "TopK", "pr-highlight"), true);
    assert.equal(marks().map((m) => m.textContent).join(""), "TopK");
  });
});

describe("markTextInContainer — snapshot safety", () => {
  // Fetched HTML snapshots carry inline <script>/<style> in the body. Matching
  // there would invent highlights the reader can't see and, worse, wrap a
  // <mark> inside the tag and corrupt it.
  test("never matches inside a <script>", () => {
    setBody('<script>var label = "brown fox";</script><p>the quick brown fox</p>');
    assert.equal(markTextInContainer(body, "brown fox", "pr-highlight"), true);
    assert.equal(body.querySelector("script")!.innerHTML, 'var label = "brown fox";');
    assert.equal(marks()[0].parentElement?.tagName, "P");
  });

  test("never matches inside a <style>", () => {
    setBody("<style>.x::after { content: 'gradient descent'; }</style><p>gradient descent</p>");
    assert.equal(markTextInContainer(body, "gradient descent", "pr-highlight"), true);
    assert.equal(body.querySelector("style")!.innerHTML, ".x::after { content: 'gradient descent'; }");
    assert.equal(marks().length, 1);
  });

  test("a passage that exists only in a script is simply not found", () => {
    setBody('<script>var s = "only in code";</script><p>prose</p>');
    assert.equal(markTextInContainer(body, "only in code", "pr-highlight"), false);
  });

  test("script text does not shift the offsets of real matches", () => {
    setBody('<p>alpha</p><script>xxxxxxxxxxxx</script><p>beta gamma</p>');
    assert.equal(markTextInContainer(body, "beta gamma", "pr-highlight"), true);
    assert.equal(marks().map((m) => m.textContent).join(""), "beta gamma");
  });
});

describe("clearMarks", () => {
  test("restores the original markup exactly", () => {
    const original = "<p>the quick brown fox</p>";
    setBody(original);
    markTextInContainer(body, "quick brown", "pr-highlight", undefined, { id: "h1" });
    assert.notEqual(body.innerHTML, original);
    clearMarks(body, "pr-highlight");
    assert.equal(body.innerHTML, original);
  });

  test("leaves marks of another class alone", () => {
    setBody("<p>the quick brown fox</p>");
    markTextInContainer(body, "quick", "pr-highlight", undefined, { id: "h1" });
    markTextInContainer(body, "fox", "pr-temp-flash");
    clearMarks(body, "pr-highlight");
    assert.equal(marks().length, 0);
    assert.equal(body.querySelectorAll("mark.pr-temp-flash").length, 1);
  });

  test("repainting is stable — paint, clear, repaint gives the same result", () => {
    setBody("<p>the quick brown fox</p>");
    markTextInContainer(body, "brown", "pr-highlight", undefined, { id: "h1" });
    const first = body.innerHTML;
    clearMarks(body, "pr-highlight");
    markTextInContainer(body, "brown", "pr-highlight", undefined, { id: "h1" });
    assert.equal(body.innerHTML, first);
  });
});

describe("rangeForText", () => {
  test("covers exactly the passage", () => {
    setBody("<p>the quick brown fox</p>");
    assert.equal(rangeForText(body, "quick brown")!.toString(), "quick brown");
  });

  test("is null when the passage is absent", () => {
    setBody("<p>the quick brown fox</p>");
    assert.equal(rangeForText(body, "kernel"), null);
  });

  test("skips a decoy inside a script and lands on the prose", () => {
    setBody('<script>"target"</script><p>before target after</p>');
    const range = rangeForText(body, "target")!;
    assert.ok(range);
    assert.equal(range.startContainer.parentElement?.tagName, "P");
  });
});
