import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withQuotes, quotePreview, quoteLabel, addQuote, parseQuotes, QUOTE_PREVIEW_CHARS } from "../lib/quotes.js";

// A quote travels inside the question text, which is why it works on every
// provider without any of them knowing the feature exists.

const q = (text: string, source?: string) => ({ id: "1", text, source });

describe("withQuotes", () => {
  test("leaves the question alone when nothing is quoted", () => {
    assert.equal(withQuotes("why?", []), "why?");
  });

  test("blockquotes the passage above the question", () => {
    const out = withQuotes("why does that hold?", [q("the kernel is bandwidth bound")]);
    assert.match(out, /^A passage I selected/);
    assert.ok(out.includes("> the kernel is bandwidth bound"));
    assert.ok(out.endsWith("why does that hold?"), "the question stays last, where the model reads it");
  });

  test("attributes the conversation it came from", () => {
    const out = withQuotes("expand on this", [q("32 banks", "Shared Memory Padding")]);
    assert.ok(out.includes("from “Shared Memory Padding”"));
  });

  test("quotes every line, so a multi-line passage stays one block", () => {
    const out = withQuotes("compare these", [q("line one\nline two")]);
    assert.ok(out.includes("> line one"));
    assert.ok(out.includes("> line two"));
    assert.equal(/^(?!>)line two/m.test(out), false, "no line escapes the quote");
  });

  test("carries several passages, from different conversations", () => {
    const out = withQuotes("which is right?", [q("first claim", "A"), q("second claim", "B")]);
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

// Holding several passages is only useful if a question can point at one of
// them, so each carries a label that appears identically on screen and in the
// prompt. Without that the model gets an unlabelled pile and "compare the
// second and third" is a guess.
describe("labelling, so a question can name a passage", () => {
  test("labels count from one, the way the reader sees them", () => {
    assert.equal(quoteLabel(0), "[1]");
    assert.equal(quoteLabel(2), "[3]");
  });

  test("every passage is labelled in the prompt, in order", () => {
    const out = withQuotes("why does [1] contradict [2]?", [q("a", "A"), q("b", "B"), q("c", "C")]);
    assert.ok(out.includes("[1] from “A”"));
    assert.ok(out.includes("[2] from “B”"));
    assert.ok(out.includes("[3] from “C”"));
    assert.ok(out.indexOf("[1]") < out.indexOf("[2]"), "labels appear in the order they were taken");
  });

  test("a lone passage is labelled too, so the chip and the prompt agree", () => {
    assert.ok(withQuotes("why?", [q("only one")]).includes("[1]"));
  });

  test("a reference written in the question survives to the model", () => {
    const out = withQuotes("does [2] follow from [1]?", [q("a"), q("b")]);
    assert.ok(out.endsWith("does [2] follow from [1]?"));
  });

  test("an unattributed passage still gets its label", () => {
    const out = withQuotes("why?", [q("no source here")]);
    assert.ok(out.includes("[1]"));
    assert.equal(out.includes("from “"), false);
  });
});

describe("addQuote", () => {
  test("keeps passages in the order they were taken", () => {
    const list = addQuote(addQuote([], q("first")), { id: "2", text: "second" });
    assert.deepEqual(list.map((x) => x.text), ["first", "second"]);
  });

  test("the same passage twice is one quote — numbering must not drift", () => {
    const once = addQuote([], q("same", "A"));
    const twice = addQuote(once, { id: "2", text: "same", source: "A" });
    assert.equal(twice.length, 1);
  });

  test("the same words from a different conversation are a different quote", () => {
    const list = addQuote(addQuote([], q("same", "A")), { id: "2", text: "same", source: "B" });
    assert.equal(list.length, 2);
  });

  test("whitespace does not make a passage look new", () => {
    const list = addQuote(addQuote([], q("  same  ", "A")), { id: "2", text: "same", source: "A" });
    assert.equal(list.length, 1);
  });
});

// Reading a question back is what makes a quote a two-way link: the passage is
// underlined where it was written and leads to the question, and the question
// leads back to it. Both ends are recovered from the question text itself, so
// this parser is the only thing standing between the reader and a dead link —
// including in conversations saved long before the feature existed.
describe("parseQuotes", () => {
  const q = (text: string, source?: string) => ({ id: "1", text, source });

  test("an ordinary question is left exactly as it is", () => {
    assert.deepEqual(parseQuotes("why does that hold?"), { quotes: [], question: "why does that hold?" });
  });

  test("round-trips one passage: what went out comes back", () => {
    const out = parseQuotes(withQuotes("why?", [q("the kernel is bandwidth bound", "Shared Memory")]));
    assert.equal(out.question, "why?");
    assert.deepEqual(out.quotes, [{ label: "[1]", text: "the kernel is bandwidth bound", source: "Shared Memory" }]);
  });

  test("round-trips several, keeping the labels the reader saw", () => {
    const out = parseQuotes(withQuotes("why does [1] contradict [2]?", [q("first", "A"), q("second", "B")]));
    assert.equal(out.question, "why does [1] contradict [2]?");
    assert.deepEqual(out.quotes.map((x) => [x.label, x.text, x.source]), [
      ["[1]", "first", "A"],
      ["[2]", "second", "B"],
    ]);
  });

  test("a multi-line passage comes back whole, without its '>' markers", () => {
    const out = parseQuotes(withQuotes("compare these", [q("line one\nline two", "A")]));
    assert.equal(out.quotes[0].text, "line one\nline two");
    assert.equal(out.question, "compare these");
  });

  test("an unattributed passage parses without inventing a source", () => {
    const out = parseQuotes(withQuotes("why?", [q("no source here")]));
    assert.equal(out.quotes[0].source, undefined);
    assert.equal(out.quotes[0].text, "no source here");
  });

  test("a question that only looks like a quoted one is left alone", () => {
    // No blocks under the lead means it is the reader's own words, and
    // swallowing them would leave the question showing as blank
    const impostor = "A passage I selected from our conversation, labelled so I can refer to it:\n\nbut then I never quoted anything";
    assert.deepEqual(parseQuotes(impostor), { quotes: [], question: impostor });
  });

  test("a question containing a blockquote of its own is not mistaken for a quote", () => {
    const own = "why is this wrong?\n\n> some markdown I pasted";
    assert.deepEqual(parseQuotes(own), { quotes: [], question: own });
  });
});
