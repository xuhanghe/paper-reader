import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, buildRankIndex, nearWords, rankSearch, snippet, tokenize } from "../lib/search-rank.js";

// Searching as it is remembered: words in any order, a word half typed,
// Chinese with no spaces to split on

describe("words", () => {
  test("Latin text is split into words, without the commonest ones; Chinese into overlapping pairs", () => {
    assert.deepEqual(tokenize("The Idiosyncrasies of BlueField-3 DPUs"), ["bluefield3", "idiosyncrasies", "bluefield", "3", "dpus"]);
    assert.ok(tokenize("multi-chaining MACs").includes("multichaining"), "a hyphenated word is also one word");
    assert.deepEqual(tokenize("这个MAC check是干啥的"), ["这个", "mac", "check", "是干", "干啥", "啥的"], "English and Chinese written together are still apart");
    assert.ok(tokenize("multi-chaining将GHASH拆成").includes("multichaining"));
    assert.ok(tokenize("multi-chaining将GHASH拆成").includes("ghash"));
    assert.deepEqual(tokenize("检索增强"), ["检索", "索增", "增强"]);
    assert.deepEqual(tokenize("加密 MPI"), ["加密", "mpi"]);
    assert.deepEqual(tokenize("密"), ["密"]);
    assert.deepEqual(tokenize("ＮＣＣＬ"), ["nccl"], "full-width letters read as plain ones");
  });
});

describe("ranking", () => {
  const docs = [
    { title: "Demystifying NCCL", text: "GPU communication protocols, ring and tree" },
    { title: "Pooled testing", text: "a Bayesian framework for group testing; the prior is the prevalence" },
    { title: "Notes", text: "NCCL appears once here among many other words about networks" },
    { title: "基于检索增强的方法", text: "我们提出一种检索增强生成的方法" },
  ];
  const index = buildRankIndex(docs);

  test("a word in the title counts for more than one in the text", () => {
    assert.equal(rankSearch(index, "nccl")[0].doc.title, "Demystifying NCCL");
  });

  test("every word asked for beats one word many times; order does not matter", () => {
    assert.equal(rankSearch(index, "prior bayesian")[0].doc.title, "Pooled testing");
    assert.equal(rankSearch(index, "testing pooled")[0].doc.title, "Pooled testing");
  });

  test("the last word may still be being typed", () => {
    assert.equal(rankSearch(index, "prevale")[0]?.doc.title, "Pooled testing");
    assert.equal(rankSearch(index, "prevale ")[0]?.doc.title, "Pooled testing", "and a finished part of a word still finds the word it is part of");
  });

  test("a Chinese phrase is found inside a longer sentence", () => {
    assert.equal(rankSearch(index, "检索增强")[0]?.doc.title, "基于检索增强的方法");
  });

  test("nothing shared, nothing found", () => {
    assert.deepEqual(rankSearch(index, "quantum chromodynamics"), []);
    assert.deepEqual(rankSearch(index, "   "), []);
  });

  test("the snippet is the text around the first word that matched", () => {
    const text = `${"lorem ipsum ".repeat(30)}the prior is the prevalence estimate ${"dolor ".repeat(30)}`;
    const s = snippet(text, "prevalence", 60);
    assert.ok(s.includes("prevalence"), s);
    assert.ok(s.startsWith("…") && s.endsWith("…"));
  });
});

describe("the best of a few", () => {
  test("the text holding the most of the words asked for; -1 when none holds any", () => {
    const pairs = ["why does dilution matter?", "and the prior? It is the prevalence.", "what about the prior and its prevalence estimate in pools"];
    assert.equal(bestMatch(pairs, "prior prevalence pools"), 2);
    assert.equal(bestMatch(pairs, "dilution"), 0);
    assert.equal(bestMatch(pairs, "quokka"), -1);
    assert.equal(bestMatch(["这个MAC check是干啥的", "multichaining 是什么"], "MAC check 干啥"), 0);
  });
});

describe("a word not quite as it was written", () => {
  const docs = [
    { title: "Multi-chaining MACs", text: "parallel GHASH chains verified at checkpoints" },
    { title: "Bandwidth bound kernels", text: "the kernel is bandwidth bound at this size" },
    { title: "Allreduce on rings", text: "each rank exchanges with its neighbour" },
    { title: "Chain of thought", text: "a chain of reasoning steps" },
  ];
  const index = buildRankIndex(docs);

  test("a word spelt a letter or two off is still found", () => {
    assert.equal(rankSearch(index, "multichaing")[0]?.doc.title, "Multi-chaining MACs");
    assert.equal(rankSearch(index, "bandwith bound")[0]?.doc.title, "Bandwidth bound kernels");
    assert.equal(rankSearch(index, "all-reduce")[0]?.doc.title, "Allreduce on rings", "written with a hyphen or without");
  });

  test("part of a longer word finds it", () => {
    assert.equal(rankSearch(index, "chaining")[0]?.doc.title, "Multi-chaining MACs");
  });

  test("the word as written still comes first, and a short word is not stretched", () => {
    const both = buildRankIndex([{ title: "bandwith typo", text: "" }, { title: "bandwidth right", text: "" }]);
    assert.equal(rankSearch(both, "bandwidth")[0].doc.title, "bandwidth right");
    assert.deepEqual(nearWords(index, "mac"), [], "three letters is too short to guess at");
  });
});
