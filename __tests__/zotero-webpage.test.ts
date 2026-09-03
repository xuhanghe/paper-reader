import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { webpageItemsPayload, webpageAttachmentMetadata, savesAsWebpage } from "../lib/zotero-webpage.js";

const save = {
  title: "笔记：量化那些事之 MoE 混合精度量化 - 知乎",
  url: "https://zhuanlan.zhihu.com/p/2078253964974371120",
  sessionID: "ab12cd34",
  connectorKey: "pr-1",
  now: new Date("2026-09-03T17:27:00Z"),
};

describe("saving a rendered page to Zotero", () => {
  test("the item is a webpage with the page's own title and URL", () => {
    const payload = webpageItemsPayload(save);
    assert.equal(payload.sessionID, "ab12cd34");
    assert.equal(payload.uri, save.url);
    assert.equal(payload.items.length, 1);
    const item = payload.items[0];
    assert.equal(item.itemType, "webpage");
    assert.equal(item.title, save.title);
    assert.equal(item.url, save.url);
    assert.equal(item.accessDate, "2026-09-03T17:27:00Z");
    assert.equal(item.id, "pr-1");
  });

  test("the attachment points back at the item through the connector key", () => {
    const meta = webpageAttachmentMetadata(save);
    assert.equal(meta.parentItemID, "pr-1");
    assert.equal(meta.sessionID, "ab12cd34");
    assert.equal(meta.url, save.url);
  });

  test("a blank title falls back to the URL rather than an empty item", () => {
    assert.equal(webpageItemsPayload({ ...save, title: "   " }).items[0].title, save.url);
  });

  test("a page fetched from the web is a web page; a file from disk is not", () => {
    assert.equal(savesAsWebpage(undefined, "https://zhuanlan.zhihu.com/p/1"), true);
    assert.equal(savesAsWebpage(undefined, undefined), false);
    assert.equal(savesAsWebpage(undefined, "file:///paper.pdf"), false);
    assert.equal(savesAsWebpage("webpage", undefined), true);
    assert.equal(savesAsWebpage("document", "https://arxiv.org/pdf/2508.02322"), false);
  });
});
