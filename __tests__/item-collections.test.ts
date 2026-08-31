import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { trail } from "../app/api/zotero/item-collections/route.js";

type Collection = { key: string; data?: { name?: string; parentCollection?: string | false } };

const tree = (...rows: Array<[string, string, string | false]>) =>
  new Map<string, Collection>(rows.map(([key, name, parent]) => [key, { key, data: { name, parentCollection: parent } }]));

describe("collection trail", () => {
  test("a top-level collection is just its own name", () => {
    assert.deepEqual(trail("A", tree(["A", "Inference", false])), ["Inference"]);
  });

  test("a nested collection reads parent-first, so a generic name isn't ambiguous", () => {
    const map = tree(["A", "Project", false], ["B", "Papers", "A"]);
    assert.deepEqual(trail("B", map), ["Project", "Papers"]);
  });

  test("walks more than one level", () => {
    const map = tree(["A", "Lab", false], ["B", "Project", "A"], ["C", "Papers", "B"]);
    assert.deepEqual(trail("C", map), ["Lab", "Project", "Papers"]);
  });

  test("a key with no matching collection yields nothing to show", () => {
    assert.deepEqual(trail("missing", tree(["A", "Inference", false])), []);
  });

  test("a parent that isn't in the map stops the walk instead of throwing", () => {
    const map = new Map<string, Collection>([["B", { key: "B", data: { name: "Papers", parentCollection: "GONE" } }]]);
    assert.deepEqual(trail("B", map), ["Papers"]);
  });

  test("a cycle terminates rather than hanging the request", () => {
    const map = tree(["A", "One", "B"], ["B", "Two", "A"]);
    const names = trail("A", map);
    assert.ok(names.length <= 12);
    assert.ok(names.includes("One"));
  });
});
