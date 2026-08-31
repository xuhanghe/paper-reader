import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { flattenZoteroCollections, zoteroCollectionBranch, zoteroPaperTab, type ZoteroCollection } from "../lib/workspace-zotero";

const collections: ZoteroCollection[] = [
  { key: "child", name: "Experiments", parentKey: "root", numItems: 2 },
  { key: "other", name: "Background", parentKey: null, numItems: 1 },
  { key: "root", name: "Idea", parentKey: null, numItems: 3 },
  { key: "grandchild", name: "Ablations", parentKey: "child", numItems: 1 },
];

describe("workspace Zotero paper selection", () => {
  test("shows the Zotero collection hierarchy in a stable tree order", () => {
    assert.deepEqual(
      flattenZoteroCollections(collections).map(({ key, depth }) => [key, depth]),
      [["other", 0], ["root", 0], ["child", 1], ["grandchild", 2]]
    );
  });

  test("selecting a collection includes all of its nested subcollections", () => {
    assert.deepEqual(zoteroCollectionBranch(collections, "root"), ["root", "child", "grandchild"]);
  });

  test("attaches Zotero metadata without copying the PDF", () => {
    assert.deepEqual(
      zoteroPaperTab({ key: "ABC123", title: "A Paper", creators: "Ada", year: "2026", itemType: "journalArticle" }),
      { id: "ABC123", name: "A Paper.pdf", docType: "pdf", zoteroKey: "ABC123" }
    );
  });
});
