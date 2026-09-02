import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTextPrompt, buildImagePrompt, buildAskMessage, buildSessionBootstrap, isDefinitionQuestion, SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_IMAGE } from "../lib/prompts.js";

// A reader stuck on a term wants the term, not its place in the argument. The
// paper-focused default used to answer "what does this mean?" with the latter.
describe("the intent of an ask shapes its message", () => {
  test("Explain puts the idea first and the paper's use of it second", () => {
    const msg = buildAskMessage({ kind: "explain", selectedText: "Lorenzo prediction", pageNumber: 2 });
    assert.match(msg, /first what it means on its own/);
    assert.match(msg, /then, briefly, what it is doing here/);
  });

  test("Define asks for the term on its own terms and keeps the paper out", () => {
    const msg = buildAskMessage({ kind: "define", selectedText: "Lorenzo prediction", pageNumber: 2 });
    assert.match(msg, /the way a good textbook would/);
    assert.match(msg, /Do not explain what it does in this paper/);
    assert.match(msg, /Keep it short/);
    assert.doesNotMatch(msg, /what it is doing here/);
  });

  test("a bare 'what does this mean' on a passage is treated as a definition", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: "Lorenzo prediction", question: "what does this mean?" });
    assert.match(msg, /My question: what does this mean\?/);
    assert.match(msg, /the way a good textbook would/);
  });

  test("a question that points at the paper keeps the ordinary path", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: "Lorenzo prediction", question: "what does this mean for the results?" });
    assert.match(msg, /My question: what does this mean for the results\?/);
    assert.doesNotMatch(msg, /textbook/);
  });

  test("the definition detector is conservative", () => {
    for (const q of ["what is this", "What is a Lorenzo predictor?", "what does this mean", "What does 'homomorphic' mean?", "what's this", "define this", "meaning of this term", "这是什么意思", "什么是同态加法", "Lorenzo是什么"]) {
      assert.equal(isDefinitionQuestion(q), true, q);
    }
    for (const q of ["what does this mean for the results", "what is this doing here", "why is this here", "what does the author claim", "what is the role of this in the paper", "what does this do", "how does this work", "这在论文里是什么意思", "为什么这里用这个", "", undefined]) {
      assert.equal(isDefinitionQuestion(q), false, String(q));
    }
  });

  test("the bootstrap no longer demands the paper's role for every passage", () => {
    const boot = buildSessionBootstrap({ title: "A paper", agentic: true, paperPath: "/p/paper.md" });
    assert.doesNotMatch(boot, /what it means AND what role it plays/);
    assert.match(boot, /the idea itself first/);
    assert.match(boot, /leave the paper out unless I ask/);
  });
});

describe("buildTextPrompt", () => {
  test("wraps selected text in quotes", () => {
    const result = buildTextPrompt("gradient descent");
    assert.ok(result.includes('"gradient descent"'));
  });

  test("includes reading-paper context", () => {
    const result = buildTextPrompt("attention mechanism");
    assert.ok(result.toLowerCase().includes("paper"));
  });
});

describe("buildImagePrompt", () => {
  test("returns a non-empty string", () => {
    const result = buildImagePrompt();
    assert.ok(result.length > 0);
  });

  test("mentions capturing a region", () => {
    const result = buildImagePrompt();
    assert.ok(result.toLowerCase().includes("region") || result.toLowerCase().includes("captured"));
  });
});

describe("system prompts", () => {
  test("text prompt explains what role the concept plays in the paper", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("why it") || SYSTEM_PROMPT_TEXT.toLowerCase().includes("role"));
  });

  test("text prompt asks to connect concept to the paper context", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("paper") && SYSTEM_PROMPT_TEXT.toLowerCase().includes("connect"));
  });

  test("image prompt asks to explain what the figure is showing", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("what it is showing") || SYSTEM_PROMPT_IMAGE.toLowerCase().includes("showing"));
  });

  test("image prompt asks to connect figure to the paper's broader context", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("context") || SYSTEM_PROMPT_IMAGE.toLowerCase().includes("broader"));
  });

  test("text prompt asks for learning resources", () => {
    assert.ok(SYSTEM_PROMPT_TEXT.toLowerCase().includes("resources"));
  });

  test("image prompt asks for learning resources", () => {
    assert.ok(SYSTEM_PROMPT_IMAGE.toLowerCase().includes("resources"));
  });
});

// The citation scheme is explained in the bootstrap, which is sent once per
// provider session. A paper whose conversation started before this existed
// would never hear about it, and on a long conversation the rule is thousands
// of tokens behind — so every ask restates it, the way the language rule is.
describe("citations reach every ask, not just the first", () => {
  test("a follow-up carries the scheme", () => {
    const msg = buildAskMessage({ kind: "followup", question: "why?" });
    assert.match(msg, /\(paper:\d+\)/, "with a worked example, not a placeholder");
    assert.match(msg, /\(turn:N\)/);
    assert.ok(msg.startsWith("why?"), "the question still comes first");
  });

  test("an explain carries it too", () => {
    assert.match(buildAskMessage({ kind: "explain", selectedText: "the kernel" }), /\(paper:\d+\)/);
  });

  test("it says the link text is the quote, and names the way that goes wrong", () => {
    // The model read "[verbatim excerpt](paper:N)" as the literal text to
    // write, so the link searched the page for the words "verbatim excerpt"
    const msg = buildAskMessage({ kind: "followup", question: "why?" });
    assert.ok(msg.includes("the link text is the quote"));
    assert.ok(msg.includes("never a description"));
  });

  test("an empty follow-up stays empty, so it is still rejected", () => {
    // Otherwise the directive alone would make a blank ask look like a question
    assert.equal(buildAskMessage({ kind: "followup", question: "" }), "");
    assert.equal(buildAskMessage({ kind: "followup" }), "");
  });

  test("the bootstrap explains the scheme in full", () => {
    const boot = buildSessionBootstrap({ title: "A paper", agentic: true, paperPath: "/p/paper.md" });
    assert.ok(boot.includes("the link text IS the quote"));
    assert.match(boot, /\(paper:\d+\)/, "shown as a worked example");
    assert.match(boot, /\[turn N\]/);
  });
});
