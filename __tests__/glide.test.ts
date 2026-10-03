import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { glideDuration, glideEase, GLIDE_MAX_MS, GLIDE_MIN_MS } from "../lib/glide.js";

describe("how long a glide takes", () => {
  test("nothing to cover: no time at all", () => {
    for (const distance of [0, 0.4, -20, Number.NaN]) assert.equal(glideDuration(distance), 0);
  });

  test("a screen's worth is over in under half a second, and is not a cut", () => {
    const ms = glideDuration(600);
    assert.ok(ms < 500, `${ms}ms`);
    assert.ok(ms >= GLIDE_MIN_MS, `${ms}ms`);
  });

  test("further takes longer, but less than proportionally", () => {
    const one = glideDuration(600);
    const four = glideDuration(2400);
    assert.ok(four > one);
    assert.ok(four < one * 2, `${one}ms → ${four}ms`);
  });

  test("a jump across the whole paper still ends inside a second", () => {
    assert.equal(glideDuration(40000), GLIDE_MAX_MS);
    assert.ok(GLIDE_MAX_MS <= 1000);
  });
});

describe("how a glide moves", () => {
  test("it starts where it starts and lands where it lands", () => {
    assert.equal(glideEase(0), 0);
    assert.equal(glideEase(1), 1);
    assert.equal(glideEase(0.5), 0.5);
  });

  test("it never moves backwards", () => {
    let last = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const k = glideEase(t);
      assert.ok(k >= last, `t=${t}`);
      last = k;
    }
  });

  test("it is slower at the ends than in the middle", () => {
    const start = glideEase(0.1) - glideEase(0);
    const middle = glideEase(0.55) - glideEase(0.45);
    const end = glideEase(1) - glideEase(0.9);
    assert.ok(middle > start && middle > end);
  });

  test("time outside the glide clamps to its ends", () => {
    assert.equal(glideEase(-1), 0);
    assert.equal(glideEase(2), 1);
  });
});
