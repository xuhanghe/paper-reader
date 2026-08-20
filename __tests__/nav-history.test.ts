import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyNav, record, back, forward, samePlace, NAV_LIMIT, type Spot } from "../lib/nav-history.js";

const spot = (doc: number, panel = 0, activeId: string | null = null): Spot => ({ doc, panel, activeId });

describe("going back and forward", () => {
  test("nothing to go back to at the start", () => {
    assert.equal(back(emptyNav, spot(0)), null);
    assert.equal(forward(emptyNav, spot(0)), null);
  });

  test("a jump can be undone", () => {
    const state = record(emptyNav, spot(100));
    const undone = back(state, spot(900));
    assert.ok(undone);
    assert.deepEqual(undone!.to, spot(100), "back to where the jump started");
  });

  test("and redone", () => {
    const state = record(emptyNav, spot(100));
    const undone = back(state, spot(900))!;
    const redone = forward(undone.state, spot(100));
    assert.ok(redone);
    assert.deepEqual(redone!.to, spot(900), "forward to where the jump landed");
  });

  test("several jumps unwind in order, most recent first", () => {
    let state = record(emptyNav, spot(1000));
    state = record(state, spot(2000));
    state = record(state, spot(3000));
    const first = back(state, spot(4000))!;
    assert.deepEqual(first.to, spot(3000));
    const second = back(first.state, first.to)!;
    assert.deepEqual(second.to, spot(2000));
  });

  test("a new jump after going back drops what was ahead", () => {
    // The browser rule: once you go somewhere else, forward is gone
    const state = record(emptyNav, spot(100));
    const undone = back(state, spot(900))!;
    assert.equal(undone.state.forward.length, 1);
    const moved = record(undone.state, spot(100));
    assert.equal(moved.forward.length, 0);
    assert.equal(forward(moved, spot(500)), null);
  });

  test("a jump that goes nowhere is not a step", () => {
    // Following a citation already on screen should not add a back entry that
    // does nothing when taken
    const state = record(emptyNav, spot(100, 50, "a1"));
    const again = record(state, spot(108, 44, "a1"));
    assert.equal(again.back.length, 1);
  });

  test("but a different conversation is a different place, however still the scroll", () => {
    const state = record(emptyNav, spot(100, 50, "a1"));
    const other = record(state, spot(100, 50, "b2"));
    assert.equal(other.back.length, 2);
  });

  test("the trail has an end — old jumps fall off rather than pile up", () => {
    let state = emptyNav;
    for (let i = 0; i < NAV_LIMIT + 12; i++) state = record(state, spot(i * 200));
    assert.equal(state.back.length, NAV_LIMIT);
    assert.deepEqual(state.back[state.back.length - 1], spot((NAV_LIMIT + 11) * 200), "the newest is kept");
  });
});

describe("samePlace", () => {
  test("a small scroll is the same place", () => {
    assert.equal(samePlace(spot(100), spot(110)), true);
  });
  test("a real move is not", () => {
    assert.equal(samePlace(spot(100), spot(400)), false);
  });
  test("neither is opening another conversation", () => {
    assert.equal(samePlace(spot(100, 0, "a1"), spot(100, 0, "b2")), false);
  });
});
