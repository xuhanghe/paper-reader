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

import { tabBarScrollFor } from "../components/MaterialTabs";

// With a dozen papers open the bar is wider than the window, and the paper
// being read could be off its edge. It never is: an active tab out of view is
// brought to the middle, one in view is left alone.
describe("keeping the active tab in view", () => {
  const bar = { scrollLeft: 0, clientWidth: 1000, scrollWidth: 3000 };

  test("a tab already in view leaves the bar where it is", () => {
    assert.equal(tabBarScrollFor(bar, { left: 200, width: 150 }), null);
    assert.equal(tabBarScrollFor({ ...bar, scrollLeft: 1200 }, { left: 1300, width: 150 }), null);
  });

  test("a tab past the right edge is centred", () => {
    assert.equal(tabBarScrollFor(bar, { left: 1800, width: 200 }), 1400);
  });

  test("a tab past the left edge is centred too", () => {
    assert.equal(tabBarScrollFor({ ...bar, scrollLeft: 1500 }, { left: 800, width: 200 }), 400);
  });

  test("a tab at either end sits at that end rather than leaving a gap", () => {
    assert.equal(tabBarScrollFor({ ...bar, scrollLeft: 1500 }, { left: 0, width: 200 }), 0);
    assert.equal(tabBarScrollFor(bar, { left: 2900, width: 100 }), 2000);
  });

  test("a tab only partly in view counts as out of view", () => {
    assert.equal(tabBarScrollFor(bar, { left: 950, width: 150 }), 525);
  });
});
