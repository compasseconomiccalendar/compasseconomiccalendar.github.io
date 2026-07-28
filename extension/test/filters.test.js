/**
 * Tests for the extension's selection logic.
 *
 * Run with:  node --test extension/test/
 *
 * These cover the MV3-sensitive behaviour: the alarm schedule must be bounded
 * and never contain a past time, since the service worker rebuilds it from
 * scratch on every restart.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  alarmName,
  coverageGaps,
  familyOf,
  meetsImpact,
  parseAlarmName,
  parseOffsets,
  plannedNotifications,
  resolveTimeZone,
  upcomingEvents,
} from "../src/filters.js";

const NOW = Date.parse("2026-07-28T12:00:00Z");
const HOUR = 3600 * 1000;

function event(id, offsetHours, overrides = {}) {
  return {
    id,
    event_type: "macro_release_cpi",
    title: id,
    start_utc: new Date(NOW + offsetHours * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z"),
    all_day: false,
    market_impact: "high",
    source_url: "https://example.gov",
    note: "note",
    ...overrides,
  };
}

test("familyOf mirrors the feed's coverage families", () => {
  assert.equal(familyOf("fomc_statement"), "fomc");
  assert.equal(familyOf("macro_release_gdp"), "macro_releases");
  assert.equal(familyOf("treasury_auction"), "treasury_auctions");
  assert.equal(familyOf("treasury_quarterly_refunding"), "treasury_refunding");
  assert.equal(familyOf("quad_witching"), "futures");
  assert.equal(familyOf("monthly_opex"), "futures");
  assert.equal(familyOf("futures_liquidity_roll"), "futures");
  assert.equal(familyOf("something_new"), "other");
});

test("meetsImpact respects the ranking", () => {
  assert.ok(meetsImpact({ market_impact: "high" }, "medium"));
  assert.ok(!meetsImpact({ market_impact: "low" }, "medium"));
  assert.ok(meetsImpact({ market_impact: "low" }, "low"));
});

test("upcomingEvents drops past events and sorts ascending", () => {
  const events = [event("c", 5), event("past", -2), event("a", 1), event("b", 3)];
  const result = upcomingEvents(events, { now: NOW });
  assert.deepEqual(result.map((item) => item.id), ["a", "b", "c"]);
});

test("upcomingEvents honours impact, hidden types, horizon and limit", () => {
  const events = [
    event("hi", 1),
    event("lo", 2, { market_impact: "low" }),
    event("hidden", 3, { event_type: "treasury_auction" }),
    event("far", 400),
  ];
  const result = upcomingEvents(events, {
    now: NOW,
    minImpact: "medium",
    hiddenTypes: ["treasury_auction"],
    horizonMs: 72 * HOUR,
    limit: 10,
  });
  assert.deepEqual(result.map((item) => item.id), ["hi"]);
});

test("plannedNotifications never schedules a time in the past", () => {
  // Event is 10 minutes out, so the 30-minute warning is already missed.
  const events = [event("soon", 10 / 60)];
  const planned = plannedNotifications(events, { now: NOW, offsets: [30, 5] });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].offsetMinutes, 5);
  assert.ok(planned[0].fireAt > NOW);
});

test("plannedNotifications skips all-day events", () => {
  const events = [event("allday", 24, { all_day: true })];
  assert.deepEqual(plannedNotifications(events, { now: NOW }), []);
});

test("plannedNotifications is bounded and returns the soonest first", () => {
  const events = Array.from({ length: 40 }, (_, index) => event(`e${index}`, index + 1));
  const planned = plannedNotifications(events, {
    now: NOW,
    offsets: [30, 5],
    max: 20,
    horizonMs: 72 * HOUR,
  });
  assert.equal(planned.length, 20);
  const times = planned.map((item) => item.fireAt);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("alarm names round-trip, including ids containing dashes", () => {
  const name = alarmName("compass:notify:", "fomc-statement-2026-09-16", 30);
  assert.deepEqual(parseAlarmName("compass:notify:", name), {
    eventId: "fomc-statement-2026-09-16",
    offsetMinutes: 30,
  });
  assert.equal(parseAlarmName("compass:notify:", "compass:refresh"), null);
});

test("resolveTimeZone accepts valid zones and never throws on bad ones", () => {
  assert.equal(resolveTimeZone("America/Denver"), "America/Denver");
  assert.equal(resolveTimeZone("UTC"), "UTC");
  // null/empty means "use the browser zone", which Intl expresses as undefined.
  assert.equal(resolveTimeZone(null), undefined);
  assert.equal(resolveTimeZone(""), undefined);
  // A stored zone can stop being valid; that must degrade, not throw.
  assert.equal(resolveTimeZone("Mars/Olympus_Mons"), undefined);
});

test("resolveTimeZone output actually drives the formatter", () => {
  const noon = new Date("2026-07-28T18:00:00Z"); // 2pm ET / noon MT
  const format = (pref) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: resolveTimeZone(pref),
      hour: "numeric",
      minute: "2-digit",
    }).format(noon);

  assert.equal(format("America/Denver"), "12:00 PM");
  assert.equal(format("America/New_York"), "2:00 PM");
  assert.equal(format("UTC"), "6:00 PM");
});

test("parseOffsets normalises user input", () => {
  assert.deepEqual(parseOffsets("30, 5"), [30, 5]);
  assert.deepEqual(parseOffsets("5 30"), [30, 5]);
  // Deduplicated, rounded, sorted furthest-out first.
  assert.deepEqual(parseOffsets("5, 5, 10.4, 60"), [60, 10, 5]);
  // Junk and non-positive values are dropped.
  assert.deepEqual(parseOffsets("30, abc, -5, 0"), [30]);
  assert.deepEqual(parseOffsets("120 90 60 30 15", 4), [120, 90, 60, 30]);
});

test("parseOffsets returns null when nothing usable was entered", () => {
  // Callers must be able to reject rather than silently save an empty schedule.
  assert.equal(parseOffsets(""), null);
  assert.equal(parseOffsets("   "), null);
  assert.equal(parseOffsets("abc"), null);
  assert.equal(parseOffsets("-5"), null);
});

test("coverageGaps flags reported families but never computed ones", () => {
  const coverage = {
    families: {
      macro_releases: { horizon: "reported", confirmed_through: "2026-12-23" },
      futures: { horizon: "computed", confirmed_through: "2027-08-20" },
      fomc: { horizon: "reported", confirmed_through: "2027-07-28" },
    },
  };
  const gaps = coverageGaps(coverage, Date.parse("2027-03-01T00:00:00Z"));
  assert.deepEqual(gaps, [
    { family: "macro_releases", confirmedThrough: "2026-12-23" },
  ]);

  // A view that stays inside every confirmed range reports nothing.
  assert.deepEqual(coverageGaps(coverage, Date.parse("2026-09-01T00:00:00Z")), []);
  assert.deepEqual(coverageGaps(undefined, NOW), []);
});
