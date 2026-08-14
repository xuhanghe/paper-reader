import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withQuotes, quotePreview, QUOTE_PREVIEW_CHARS } from "../lib/quotes.js";

// A quote travels inside the question text, which is why it works on every
// provider without any of them knowing the feature exists.

const q = (text: string, source?: string) => ({ id: "1", text, source });

describe("withQuotes", () => {
  test("leaves the question alone when nothing is quoted", () => {
    assert.equal(withQuotes("why?", []), "why?");
  });

  test("blockquotes the passage above the question", () => {
    const out = withQuotes("why does that hold?", [q("the kernel is bandwidth bound")]);
    assert.match(out, /^Referring to this/);
    assert.ok(out.includes("> the kernel is bandwidth bound"));
    assert.ok(out.endsWith("why does that hold?"), "the question stays last, where the model reads it");
  });

  test("attributes the conversation it came from", () => {
    const out = withQuotes("expand on this", [q("32 banks", "Shared Memory Padding")]);
    assert.ok(out.includes("— from “Shared Memory Padding”"));
  });

  test("quotes every line, so a multi-line passage stays one block", () => {
    const out = withQuotes("compare these", [q("line one\nline two")]);
    assert.ok(out.includes("> line one"));
    assert.ok(out.includes("> line two"));
    assert.equal(/^(?!>)line two/m.test(out), false, "no line escapes the quote");
  });

  test("carries several passages, from different conversations", () => {
    const out = withQuotes("which is right?", [q("first claim", "A"), q("second claim", "B")]);
    assert.match(out, /^Referring to these/);
    assert.ok(out.includes("first claim") && out.includes("second claim"));
    assert.ok(out.includes("from “A”") && out.includes("from “B”"));
  });

  test("ignores an empty selection rather than emitting a bare '>'", () => {
    assert.equal(withQuotes("why?", [q("   ")]), "why?");
  });
});

describe("quotePreview", () => {
  test("flattens whitespace so a chip stays one line", () => {
    assert.equal(quotePreview("  the kernel\n  is bound  "), "the kernel is bound");
  });

  test("truncates a long passage for the chip only", () => {
    const long = "x".repeat(QUOTE_PREVIEW_CHARS + 40);
    const preview = quotePreview(long);
    assert.ok(preview.length <= QUOTE_PREVIEW_CHARS + 1);
    assert.ok(preview.endsWith("…"));
    // the question still carries the whole thing
    assert.ok(withQuotes("q", [q(long)]).includes(long));
  });
});
