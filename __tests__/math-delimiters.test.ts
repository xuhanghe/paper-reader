import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeMathDelimiters } from "../lib/math-delimiters.js";

describe("math delimiters", () => {
  test("inline \\( \\) becomes $ $", () => {
    assert.equal(normalizeMathDelimiters("the residual \\( r_t = q_t - q_{t-1} \\) is small"), "the residual $r_t = q_t - q_{t-1}$ is small");
  });

  test("display \\[ \\] becomes a $$ block on its own lines", () => {
    const out = normalizeMathDelimiters("So:\n\\[ L_3 = D_x D_y D_z \\]\nwhich factors.");
    assert.equal(out, "So:\n\n$$\nL_3 = D_x D_y D_z\n$$\n\nwhich factors.");
  });

  test("dollar maths is left exactly as written", () => {
    const md = "already $a+b$ and\n$$\nc\n$$";
    assert.equal(normalizeMathDelimiters(md), md);
  });

  test("code is never rewritten, fenced or inline", () => {
    const md = "run `printf(\"\\\\(x\\\\)\")` then\n```c\nif (a) \\[ b \\]\n```\nand \\( y \\)";
    const out = normalizeMathDelimiters(md);
    assert.ok(out.includes("`printf(\"\\\\(x\\\\)\")`"), "inline code kept");
    assert.ok(out.includes("if (a) \\[ b \\]"), "fenced code kept");
    assert.ok(out.endsWith("and $y$"), "prose rewritten");
  });

  test("an unmatched opener is left alone", () => {
    assert.equal(normalizeMathDelimiters("a \\( b"), "a \\( b");
  });
});
