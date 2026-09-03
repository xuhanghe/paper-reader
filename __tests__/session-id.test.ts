import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sessionIdFor, legacySessionIdFor } from "../lib/session-id.js";

describe("session ids", () => {
  test("a Zotero key is the id, whatever the name", () => {
    assert.equal(sessionIdFor("Anything.pdf", "U2X9L36Y"), "U2X9L36Y");
  });

  test("Latin names slug the way they always did", () => {
    assert.equal(sessionIdFor("CAMERA: Multi-Matrix Joint Compression.pdf"), "camera-multi-matrix-joint-compression-pdf");
    assert.equal(legacySessionIdFor("CAMERA: Multi-Matrix Joint Compression.pdf"), "camera-multi-matrix-joint-compression-pdf");
  });

  test("a Chinese title keeps its words instead of collapsing to the one Latin token", () => {
    const zhihu = "笔记：量化那些事之 MoE 混合精度量化 - 知乎";
    assert.equal(legacySessionIdFor(zhihu), "moe");
    assert.equal(sessionIdFor(zhihu), "笔记-量化那些事之-moe-混合精度量化-知乎");
  });

  test("two Chinese articles about the same topic no longer share an id", () => {
    const a = sessionIdFor("MoE 推理优化实践 - 知乎");
    const b = sessionIdFor("MoE 训练中的负载均衡 - 知乎");
    assert.notEqual(a, b);
    assert.equal(legacySessionIdFor("MoE 推理优化实践 - 知乎"), legacySessionIdFor("MoE 训练中的负载均衡 - 知乎"));
  });

  test("a rendered page's .pdf suffix does not become the whole id", () => {
    assert.equal(legacySessionIdFor("量化那些事 - 知乎.pdf"), "pdf");
    assert.equal(sessionIdFor("量化那些事 - 知乎.pdf"), "量化那些事-知乎-pdf");
  });

  test("nothing usable in the name still yields an id", () => {
    assert.equal(sessionIdFor("  —— ...  "), "untitled");
    assert.equal(sessionIdFor(""), "untitled");
  });

  test("long names are cut without leaving a dangling separator", () => {
    const id = sessionIdFor("a ".repeat(200));
    assert.ok(id.length <= 120);
    assert.doesNotMatch(id, /-$/);
  });
});
