import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dominantLanguage, inputLanguage } from "../lib/language.js";
import { buildAskMessage, buildMindmapPrompt, buildSessionBootstrap, MINDMAP_PROMPT_HEADER } from "../lib/prompts.js";

// Two different rules, deliberately: the paper map follows the paper, an answer
// follows the question.

const EN =
  "We present a method for accelerating top-k selection on modern GPUs. " +
  "The approach partitions the input across thread blocks and merges partial results.";

// A Chinese technical article: mostly Chinese prose, but heavy with English
// identifiers and code — the case that makes "just infer it" unreliable.
const ZH_WITH_CODE = `TopK kernel 优化: 从 20GB/s 到 2024GB/s
第一阶段每个 block 求局部 top32, 第二阶段合并所有 block 的结果得到全局 top32。
template <int TPB, int K> __global__ void device_topk(const float* __restrict__ in,
    float* out, int n) { int tid = threadIdx.x + blockIdx.x * blockDim.x; }
这样做的好处是显存带宽利用率显著提升, 而且避免了全局同步的开销。`;

const JA = "本論文ではGPU上での上位k選択を高速化する手法を提案する。ブロックごとに部分的な結果を求めてから統合する。";
const KO = "이 논문에서는 GPU에서 상위 k개 선택을 가속하는 방법을 제안한다. 블록마다 부분 결과를 구한 뒤 병합한다.";

describe("dominantLanguage", () => {
  test("reports Chinese for a Chinese paper even when it is full of code", () => {
    assert.equal(dominantLanguage(ZH_WITH_CODE), "Chinese");
  });

  test("leaves Latin-script papers to the model rather than guessing", () => {
    assert.equal(dominantLanguage(EN), null);
  });

  test("kana decides Japanese, which also uses Han characters", () => {
    assert.equal(dominantLanguage(JA), "Japanese");
  });

  test("reports Korean for Hangul", () => {
    assert.equal(dominantLanguage(KO), "Korean");
  });

  test("a Chinese name in an English paper's references does not flip it", () => {
    assert.equal(dominantLanguage(`${EN} References: Zhang Wei (张伟), Li Ming (李明).`), null);
  });

  test("says nothing about a scrap of text too short to judge", () => {
    assert.equal(dominantLanguage("优化"), null);
    assert.equal(dominantLanguage(""), null);
  });
});

describe("buildMindmapPrompt — the map follows the paper", () => {
  test("states the language outright when the script settles it", () => {
    const prompt = buildMindmapPrompt(ZH_WITH_CODE);
    assert.match(prompt, /This paper is written in Chinese/);
    assert.match(prompt, /Write "title", "label" and "note" in Chinese/);
  });

  test("adds nothing for a Latin-script paper", () => {
    assert.equal(buildMindmapPrompt(EN).includes("This paper is written in"), false);
  });

  test("still carries the paper text", () => {
    assert.ok(buildMindmapPrompt(ZH_WITH_CODE).includes(ZH_WITH_CODE));
  });

  test("quotes are exempt — translating one would break jump-to-passage", () => {
    // The quote is matched verbatim against the document to locate the passage
    assert.match(MINDMAP_PROMPT_HEADER, /"quote" is the exception/);
    assert.match(MINDMAP_PROMPT_HEADER, /never translated/);
  });
});

describe("inputLanguage — what the user typed", () => {
  test("a short question is enough, where a document would be too short to judge", () => {
    assert.equal(inputLanguage("为什么需要两阶段?"), "Chinese");
    assert.equal(dominantLanguage("为什么需要两阶段?"), null);
  });

  test("an English question naming a Chinese term is still English", () => {
    assert.equal(inputLanguage("what does 优化 mean here?"), null);
  });

  test("empty input says nothing", () => {
    assert.equal(inputLanguage("   "), null);
  });
});

describe("buildAskMessage — the directive that actually holds", () => {
  // The bootstrap rule alone loses: the quoted passage is longer and sits right
  // before the model writes, so it drags the answer into its own language.
  // Verified against a live model — without this, an English question about a
  // Chinese passage came back in Chinese.
  const ZH_PASSAGE = "stage2: 合并所有 block 的 top32 得到全局 top32";
  const EN_PASSAGE = "We model the click-through rate with a Beta prior.";

  test("English question about a Chinese passage asks for English", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: ZH_PASSAGE, question: "Why two stages?" });
    assert.match(msg, /same language as my question above, not the language of the passage/);
  });

  test("Chinese question about an English passage names Chinese outright", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: EN_PASSAGE, question: "为什么要用Beta先验？" });
    assert.match(msg, /Answer in Chinese, matching my question/);
  });

  test("a passage with no question of my own follows the passage", () => {
    assert.match(buildAskMessage({ kind: "explain", selectedText: ZH_PASSAGE }), /Answer in Chinese, matching the passage/);
  });

  test("says nothing about a Latin-script passage — there is nothing to correct for", () => {
    assert.equal(buildAskMessage({ kind: "explain", selectedText: EN_PASSAGE }).includes("Answer in"), false);
  });

  test("a bare question gets no language directive — nothing is pulling it off course", () => {
    const msg = buildAskMessage({ kind: "question", question: "为什么？" });
    assert.ok(msg.startsWith("为什么？"), "the question is sent as asked");
    assert.equal(/Answer in|matching my question/.test(msg), false, "and nothing tells it what language to use");
  });

  test("the passage and question still survive intact", () => {
    const msg = buildAskMessage({ kind: "question", selectedText: ZH_PASSAGE, question: "Why?", pageNumber: 3 });
    assert.ok(msg.includes(ZH_PASSAGE));
    assert.ok(msg.includes("Why?"));
    assert.ok(msg.includes("(page 3)"));
  });
});

describe("buildSessionBootstrap — the answer follows the question", () => {
  const bootstrap = buildSessionBootstrap({ title: "TopK kernel 优化", agentic: true });

  test("asks for the language of the question, and to switch on demand", () => {
    assert.match(bootstrap, /answer in the language of my question/);
    assert.match(bootstrap, /switch languages mid-conversation and you should switch with me/);
  });

  test("names the conflict case rather than leaving it to be inferred", () => {
    assert.match(bootstrap, /follow my question, not the passage/);
  });

  test("falls back to the passage when there is no question of my own", () => {
    // "Explain this" sends an app-written English sentence around the passage;
    // without this the answer would always come back in English
    assert.match(bootstrap, /no question of my own, answer in the language of that passage/);
  });

  test("rules out the two misleading signals", () => {
    assert.match(bootstrap, /Ignore the language of the paper/);
    assert.match(bootstrap, /the language of these instructions/);
  });
});
