import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAskMessage, buildWorkspaceAskMessage } from "../lib/prompts.js";

// A passage asked about from the page in the Workspace is phrased as the
// Reader phrases it, so the two surfaces get the same kind of answer. The
// Workspace chat has no numbered turns and the agent is not reading along,
// so those two directives stay out.

describe("a passage asked about in the workspace", () => {
  test("is the Reader's explain, with paper links and nothing about turns or reading order", () => {
    const text = buildWorkspaceAskMessage({ kind: "explain", selectedText: "pooled samples contain few positives", pageNumber: 3 });
    assert.ok(text.includes('I selected this passage (page 3):\n\n"pooled samples contain few positives"'));
    assert.ok(text.includes("(paper:12)"), "how to cite the paper");
    assert.ok(!text.includes("turn:"), "no turn links in a chat without turns");
    assert.ok(!/read up to|have not read/i.test(text), "no reading-order directive");
    const reader = buildAskMessage({ kind: "explain", selectedText: "pooled samples contain few positives", pageNumber: 3, readUpTo: 3 });
    assert.ok(reader.includes("turn:"), "the Reader's own message does carry them");
  });

  test("a question about a passage keeps the question", () => {
    const text = buildWorkspaceAskMessage({ kind: "question", selectedText: "a Bayesian framework", question: "why is the prior needed here?", pageNumber: 2 });
    assert.ok(text.includes('About this passage (page 2):\n\n"a Bayesian framework"\n\nMy question: why is the prior needed here?'));
  });

  test("a captured figure asks for an explanation of it", () => {
    assert.ok(buildWorkspaceAskMessage({ kind: "figure" }).startsWith("I captured the attached figure from the paper. Explain it."));
  });

  test("a definition leaves the paper out, as in the Reader", () => {
    const text = buildWorkspaceAskMessage({ kind: "define", selectedText: "prior" });
    assert.ok(text.includes("Draw on general knowledge, not on this paper."));
  });
});
