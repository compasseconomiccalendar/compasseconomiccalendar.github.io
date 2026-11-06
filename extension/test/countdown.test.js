import assert from "node:assert/strict";
import test from "node:test";

import { countdownParts, countdownText, pickHero, relativeShort } from "../src/countdown.js";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

test("countdown shows the two largest units", () => {
  assert.equal(countdownText(4 * D + 11 * H + 5 * M), "4d 11h");
  assert.equal(countdownText(11 * H + 23 * M + 59 * S), "11h 23m");
  assert.equal(countdownText(42 * M + 10 * S), "42m 10s");
  assert.equal(countdownText(9 * S + 900), "9s");
  assert.equal(countdownText(0), "0s");
});

test("countdown is empty for past or invalid durations", () => {
  assert.equal(countdownParts(-1), null);
  assert.equal(countdownParts(Number.NaN), null);
  assert.equal(countdownText(-5 * M), "");
});

test("relative labels round down so a row never overstates the time left", () => {
  assert.equal(relativeShort(0), "now");
  assert.equal(relativeShort(-M), "now");
  assert.equal(relativeShort(30 * S), "in <1m");
  assert.equal(relativeShort(59 * M + 59 * S), "in 59m");
  assert.equal(relativeShort(23 * H + 59 * M), "in 23h");
  assert.equal(relativeShort(47 * H), "in 1d");
});

const NOW = Date.parse("2026-11-05T12:00:00Z");
const at = (offset, extra = {}) => ({
  id: `e${offset}`,
  start_utc: new Date(NOW + offset).toISOString(),
  all_day: false,
  market_impact: "medium",
  ...extra,
});

test("the hero prefers the first high-impact event over a nearer medium one", () => {
  const events = [at(H), at(3 * H, { market_impact: "high" }), at(5 * H, { market_impact: "high" })];
  assert.equal(pickHero(events, NOW).id, `e${3 * H}`);
});

test("without a high-impact event the hero falls back to the next timed one", () => {
  assert.equal(pickHero([at(H), at(2 * H)], NOW).id, `e${H}`);
});

test("the hero skips all-day and already-started events", () => {
  const events = [
    at(-10 * M, { market_impact: "high" }),
    at(2 * H, { all_day: true, market_impact: "high" }),
    at(4 * H),
  ];
  assert.equal(pickHero(events, NOW, 90 * M).id, `e${4 * H}`);
});

test("no qualifying event means no hero", () => {
  assert.equal(pickHero([], NOW), null);
  assert.equal(pickHero(undefined, NOW), null);
  assert.equal(pickHero([at(H, { all_day: true })], NOW), null);
});
