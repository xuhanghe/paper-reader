"use client";
import { useState } from "react";

/**
 * The value from before while the new one is equal to it.
 *
 * For a value rebuilt on every render whose contents seldom change — a list
 * derived from state that changes for other reasons — so that what depends on
 * its identity (a memoised child, an effect) runs only on a real change. The
 * state is adjusted during render, as React's docs do for derived state: an
 * unequal value is returned at once and kept from then on.
 */
export function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const [kept, setKept] = useState(value);
  if (kept !== value && !equal(kept, value)) {
    setKept(value);
    return value;
  }
  return kept;
}

/** Arrays of the same length whose items are equal pairwise. */
export function sameItems<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
  return true;
}
