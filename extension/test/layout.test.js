/**
 * The header title shrinks to fit beside the controls, which means a search
 * loop. An unbounded or off-by-one loop here yields a zero-size or invisible
 * title, so the bounds and termination are worth pinning.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { largestFittingSize } from "../src/layout.js";

test("returns the largest size that fits", () => {
  // Everything at or below 12 fits.
  assert.equal(largestFittingSize((s) => s <= 12), 12);
  assert.equal(largestFittingSize((s) => s <= 10.5), 10.5);
});

test("returns the maximum when everything fits", () => {
  assert.equal(largestFittingSize(() => true), 15);
});

test("falls back to the minimum rather than zero when nothing fits", () => {
  // A very long title in a very narrow header must still render something.
  assert.equal(largestFittingSize(() => false), 9);
});

test("respects custom bounds and step", () => {
  assert.equal(largestFittingSize((s) => s <= 20, { max: 24, min: 12, step: 1 }), 20);
  assert.equal(largestFittingSize(() => false, { max: 24, min: 12, step: 1 }), 12);
});

test("degenerate bounds terminate instead of looping", () => {
  // step of 0 would otherwise spin forever.
  assert.equal(largestFittingSize(() => true, { max: 15, min: 9, step: 0 }), 9);
  assert.equal(largestFittingSize(() => true, { max: 5, min: 10 }), 10);
});

test("never returns a size outside the bounds", () => {
  for (const threshold of [0, 5, 9, 12, 15, 100]) {
    const size = largestFittingSize((s) => s <= threshold);
    assert.ok(size >= 9 && size <= 15, `got ${size} for threshold ${threshold}`);
  }
});
