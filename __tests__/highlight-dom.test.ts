import { dom } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findIgnoringWhitespace,
  findAllIgnoringWhitespace,
  markTextInContainer,
  occurrenceAt,
} from "../lib/highlight-dom.js";

// The text layer and the browser's selection disagree about whitespace, so a
// highlight has to be located without it. See lib/highlight-dom.ts.

describe("findIgnoringWhitespace — plain matches", () => {
  test("finds an exact substring", () => {
    assert.deepEqual(findIgnoringWhitespace("the quick brown fox", "brown"), { start: 10, end: 15 });
  });

  test("is case-insensitive", () => {
    assert.deepEqual(findIgnoringWhitespace("Gradient Descent", "gradient"), { start: 0, end: 8 });
  });

  test("returns null when absent", () => {
    assert.equal(findIgnoringWhitespace("the quick brown fox", "kernel"), null);
  });

  test("returns null for an all-whitespace query", () => {
    assert.equal(findIgnoringWhitespace("the quick brown fox", "  \n "), null);
  });
});

describe("findIgnoringWhitespace — whitespace disagreements", () => {
  test("matches when the selection has a break the layer does not (CJK case)", () => {
    // Chrome puts a newline between per-character spans; the DOM has none
    const found = findIgnoringWhitespace("学渣暮易Introduction", "暮易\nIntro");
    assert.deepEqual(found, { start: 2, end: 9 });
  });

  test("matches when the layer has whitespace the selection does not", () => {
    const found = findIgnoringWhitespace("top k kernel", "topk");
    assert.deepEqual(found, { start: 0, end: 5 }); // spans the interior space
  });

  test("matches across a line wrap in the query", () => {
    const found = findIgnoringWhitespace("the quick brown fox", "quick\n  brown");
    assert.deepEqual(found, { start: 4, end: 15 });
  });

  test("ignores leading and trailing whitespace in the query", () => {
    assert.deepEqual(findIgnoringWhitespace("the quick brown fox", "  brown  "), { start: 10, end: 15 });
  });
});

describe("findIgnoringWhitespace — index integrity", () => {
  test("the returned range starts and ends on non-whitespace", () => {
    const full = "a  bc   def";
    const found = findIgnoringWhitespace(full, "bc def")!;
    assert.ok(found);
    assert.equal(full[found.start], "b");
    assert.equal(full[found.end - 1], "f");
  });

  test("a character that lowercases to two units keeps indices aligned", () => {
    // "İ".toLowerCase() is two code units — folding it would shift every
    // later index, so it is left as-is
    const full = "aİb kernel";
    const found = findIgnoringWhitespace(full, "kernel")!;
    assert.ok(found);
    assert.equal(full.slice(found.start, found.end), "kernel");
  });
});

// A phrase can appear more than once on a page — "operator-level granularities"
// in the abstract and again in the contributions. Painting the first match
// highlights a passage the reader did not select.
describe("repeated phrases", () => {
  const page = () => {
    const el = dom.window.document.createElement("div");
    el.innerHTML =
      "<span>and (ii) operator-level granularities. We begin by</span>" +
      "<span> analysing each accelerator. </span>" +
      "<span>both (i) end-to-end workload, and (ii) operator-level granularities. Notably</span>";
    return el as unknown as HTMLElement;
  };

  test("every occurrence is found, in order", () => {
    const hits = findAllIgnoringWhitespace(page().textContent!, "operator-level granularities");
    assert.equal(hits.length, 2);
    assert.ok(hits[0].start < hits[1].start);
  });

  test("the second occurrence can be marked instead of the first", () => {
    const el = page();
    markTextInContainer(el, "operator-level granularities", "pr-highlight", undefined, { occurrence: 1 });
    const mark = el.querySelector("mark")!;
    // The one in the contributions sentence, not the one in the opening
    assert.ok(mark.parentElement!.textContent!.includes("Notably"));
  });

  test("the first is still the default", () => {
    const el = page();
    markTextInContainer(el, "operator-level granularities", "pr-highlight");
    assert.ok(el.querySelector("mark")!.parentElement!.textContent!.includes("We begin by"));
  });

  test("an occurrence that no longer exists falls back rather than vanishing", () => {
    const el = page();
    assert.equal(markTextInContainer(el, "operator-level granularities", "pr-highlight", undefined, { occurrence: 7 }), true);
    assert.equal(el.querySelectorAll("mark").length > 0, true);
  });

  test("a selection reports which occurrence it is on", () => {
    const el = page();
    const spans = el.querySelectorAll("span");
    const second = spans[2].firstChild as Text;
    const at = second.data.indexOf("operator-level");
    assert.equal(occurrenceAt(el, "operator-level granularities", second, at), 1);
    const first = spans[0].firstChild as Text;
    assert.equal(occurrenceAt(el, "operator-level granularities", first, first.data.indexOf("operator-level")), 0);
  });

  test("overlapping matches are not counted twice", () => {
    const el = dom.window.document.createElement("div") as unknown as HTMLElement;
    el.textContent = "aaaa";
    assert.equal(findAllIgnoringWhitespace(el.textContent!, "aa").length, 2);
  });
});
