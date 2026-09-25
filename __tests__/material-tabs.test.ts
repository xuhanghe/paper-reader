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

import { moveMaterialTab, slotAt } from "../components/MaterialTabs";

// Dragging a tab means dropping it into a slot between two tabs, the one the
// pointer was over: its left half is the slot before it, its right half the
// slot after. The tab lands there, wherever it came from.
describe("moving a tab to a slot", () => {
  test("into a slot after its own position", () => {
    assert.deepEqual(moveMaterialTab(tabs, "a", 3).map((t) => t.id), ["b", "c", "a"]);
    assert.deepEqual(moveMaterialTab(tabs, "a", 2).map((t) => t.id), ["b", "a", "c"]);
  });

  test("into a slot before its own position", () => {
    assert.deepEqual(moveMaterialTab(tabs, "c", 0).map((t) => t.id), ["c", "a", "b"]);
    assert.deepEqual(moveMaterialTab(tabs, "c", 1).map((t) => t.id), ["a", "c", "b"]);
  });

  test("the slots either side of its own position leave the order alone", () => {
    assert.equal(moveMaterialTab(tabs, "b", 1), tabs);
    assert.equal(moveMaterialTab(tabs, "b", 2), tabs);
  });

  test("which slot the pointer means", () => {
    const rect = { left: 100, width: 80 };
    assert.equal(slotAt(120, rect, 4), 4, "left half: before the tab");
    assert.equal(slotAt(160, rect, 4), 5, "right half: after it");
  });
});

// Near a tab's midpoint the slot holds rather than flips with every pixel
describe("the slot holds near the midpoint", () => {
  const rect = { left: 100, width: 100 };
  test("across the middle fifth the current slot stays, whichever side the pointer is", () => {
    assert.equal(slotAt(142, rect, 4, 5), 5);
    assert.equal(slotAt(158, rect, 4, 4), 4);
  });
  test("past it the side decides", () => {
    assert.equal(slotAt(135, rect, 4, 5), 4);
    assert.equal(slotAt(165, rect, 4, 4), 5);
  });
  test("a slot from another tab does not hold here", () => {
    assert.equal(slotAt(152, rect, 4, 9), 5);
  });
});
