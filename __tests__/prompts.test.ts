import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTextPrompt, buildImagePrompt, buildAskMessage, buildSessionBootstrap, isDefinitionQuestion, wantsWholePaper, SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_IMAGE } from "../lib/prompts.js";

// A reader stuck on a term wants the term, not its place in the argument. The
// paper-focused default used to answer "what does this mean?" with the latter.
describe("the intent of an ask shapes its message", () => {
  test("Explain puts the idea first and the paper's use of it second", () => {
    const msg = buildAskMessage({ kind: "explain", selectedText: "Lorenzo prediction", pageNumber: 2 });
    assert.match(msg, /first what it means on its own/);
    assert.match(msg, /then, briefly, what it is doing at this point, given what came before/);
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

// A rewritten question goes into a provider session that already holds the
// first wording and its answer. Left unsaid, the model answered "I already
// explained this".
describe("a question asked again after editing", () => {
  test("says it replaces the earlier turn and asks for a fresh answer", () => {
    const msg = buildAskMessage({ kind: "followup", question: "so what is the residual?", rewriteOfTurn: 7 });
    assert.match(msg, /^This replaces my question in \[turn 7\]: I have rewritten it\./);
    assert.match(msg, /as if the earlier wording and your answer to it had never been given/);
    assert.ok(msg.includes("so what is the residual?"));
  });

  test("an original that was never numbered is still replaced", () => {
    const msg = buildAskMessage({ kind: "followup", question: "why?", rewriteOfTurn: null });
    assert.match(msg, /^This replaces an earlier question of mine/);
  });

  test("an ordinary ask carries no such note", () => {
    assert.doesNotMatch(buildAskMessage({ kind: "followup", question: "why?" }), /This replaces/);
  });
});

// A reader checking their understanding page by page does not want the
// paper's later sections in the answer: the ask says where they are, and the
// model stands on what came before it plus general knowledge — unless the
// reader asks for the paper as a whole, in so many words.
describe("the answer stands on what the reader has read", () => {
  test("an ask says where the reader is and what to leave out", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: "the kernel", question: "why is this here?", pageNumber: 4, readUpTo: 4 });
    assert.match(msg, /I am at page 4 of the paper/);
    assert.match(msg, /leave what the paper says after it out/);
    assert.match(msg, /say only that it comes later and where/);
  });

  test("a follow-up carries it too, with the page its conversation is on", () => {
    const msg = buildAskMessage({ kind: "followup", question: "and then?", readUpTo: 7 });
    assert.match(msg, /I am at page 7/);
  });

  test("with no page known, nothing is claimed", () => {
    assert.doesNotMatch(buildAskMessage({ kind: "followup", question: "and then?" }), /I am at page/);
  });

  test("a definition leaves the paper out already, so it says nothing about pages", () => {
    assert.doesNotMatch(buildAskMessage({ kind: "define", selectedText: "MPKI", readUpTo: 3 }), /I am at page/);
  });

  test("asking for the paper as a whole lifts the limit", () => {
    for (const q of ["how does this fit the whole paper?", "overall picture of the method?", "globally, what is the contribution?", "what does the rest of the paper do with it?", "这个在整篇论文里是什么作用", "从全文来看这个方法怎么样", "后文有没有解决这个问题"]) {
      assert.equal(wantsWholePaper(q), true, q);
      assert.match(buildAskMessage({ kind: "followup", question: q, readUpTo: 2 }), /the paper as a whole: draw on all of it/, q);
    }
  });

  test("a passing 'overall' or 'later' is not a request for the whole paper", () => {
    for (const q of ["what is the overall throughput here?", "is this later replaced by a cache?", "what is this?", "这里的latency是单程吗", "why does the author say this?"]) {
      assert.equal(wantsWholePaper(q), false, q);
    }
  });

  test("the bootstrap sets the rule, and keeps the map from answering ahead", () => {
    const boot = buildSessionBootstrap({ title: "A paper", agentic: true, paperPath: "/p/paper.md", mindmapJson: "{}" });
    assert.match(boot, /READ ALONG WITH ME/);
    assert.match(boot, /read no further than the end of page N/);
    assert.match(boot, /not to answer ahead of where I am/);
  });

  test("explain asks for the passage's role given what came before, not what comes after", () => {
    assert.match(buildAskMessage({ kind: "explain", selectedText: "x", pageNumber: 2 }), /at this point, given what came before/);
  });
});
