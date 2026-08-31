import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reorderMaterialTabs, type MaterialTab } from "../components/MaterialTabs";

const tabs: MaterialTab[] = [
  { id: "a", name: "A.pdf", docType: "pdf" },
  { id: "b", name: "B.pdf", docType: "pdf" },
  { id: "c", name: "C.pdf", docType: "pdf" },
];

describe("reorderMaterialTabs", () => {
  test("moves a dragged paper before the tab it was dropped on", () => {
    assert.deepEqual(reorderMaterialTabs(tabs, "c", "a").map((tab) => tab.id), ["c", "a", "b"]);
  });

  test("does not mutate the stored order", () => {
    reorderMaterialTabs(tabs, "a", "c");
    assert.deepEqual(tabs.map((tab) => tab.id), ["a", "b", "c"]);
  });

  test("ignores an unknown or no-op drag", () => {
    assert.equal(reorderMaterialTabs(tabs, "a", "a"), tabs);
    assert.equal(reorderMaterialTabs(tabs, "missing", "b"), tabs);
  });
});
