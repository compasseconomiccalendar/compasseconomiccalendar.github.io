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
  badgeText,
  badgeTickMinutes,
  coverageGaps,
  familyOf,
  groupByDay,
  groupOf,
  isInProgress,
  isStale,
  meetsImpact,
  migratePrefs,
  nextBadgeEvent,
  parseAlarmName,
  parseOffsets,
  plannedNotifications,
  resolveTimeZone,
  upcomingEvents,
  zonedTimeToUtc,
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

test("all-day events get one morning nudge, never offset warnings", () => {
  // "30 minutes before midnight" is not a useful warning, so all-day events
  // are handled separately from the offsets.
  const events = [event("allday", 24, { all_day: true, date_et: "2026-07-29" })];
  const planned = plannedNotifications(events, {
    now: NOW,
    offsets: [30, 5],
    timeZone: "UTC",
    horizonMs: 72 * HOUR,
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].offsetMinutes, null);
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

test("in-progress events stay in the list during the grace window", () => {
  const started = event("live", -0.5); // began 30 minutes ago
  const older = event("gone", -3);
  const graceMs = 90 * 60 * 1000;
  const result = upcomingEvents([started, older], { now: NOW, graceMs });
  assert.deepEqual(result.map((item) => item.id), ["live"]);
  assert.ok(isInProgress(started, NOW, graceMs));
  assert.ok(!isInProgress(older, NOW, graceMs));
  // Without a grace window the same event is dropped, which is the old bug.
  assert.deepEqual(upcomingEvents([started], { now: NOW }), []);
});

test("groupOf buckets every event type the feed emits", () => {
  assert.equal(groupOf("fomc_statement"), "fomc");
  assert.equal(groupOf("macro_release_cpi"), "data");
  assert.equal(groupOf("ism_manufacturing_pmi"), "data");
  assert.equal(groupOf("treasury_auction"), "treasury");
  assert.equal(groupOf("treasury_quarterly_refunding"), "treasury");
  assert.equal(groupOf("quad_witching"), "futures");
  assert.equal(groupOf("monthly_opex"), "futures");
});

test("type filtering keeps only the selected groups", () => {
  const events = [
    event("fomc", 1, { event_type: "fomc_statement" }),
    event("cpi", 2, { event_type: "macro_release_cpi" }),
    event("auction", 3, { event_type: "treasury_auction" }),
  ];
  const result = upcomingEvents(events, { now: NOW, types: ["fomc", "treasury"] });
  assert.deepEqual(result.map((item) => item.id), ["fomc", "auction"]);
  // No selection means no filtering.
  assert.equal(upcomingEvents(events, { now: NOW, types: null }).length, 3);
});

test("badgeText stays within four characters", () => {
  assert.equal(badgeText(30_000), "now");
  assert.equal(badgeText(5 * 60_000), "5m");
  assert.equal(badgeText(59 * 60_000), "59m");
  assert.equal(badgeText(2 * 3600_000), "2h");
  assert.equal(badgeText(3 * 24 * 3600_000), "3d");
  assert.equal(badgeText(-1), "");
  for (const ms of [0, 6e4, 36e5, 864e5, 30 * 864e5]) {
    assert.ok(badgeText(ms).length <= 4, `too long for ${ms}`);
  }
});

test("badge ticks faster the closer the event is", () => {
  assert.equal(badgeTickMinutes(10 * 60_000), 1);
  assert.equal(badgeTickMinutes(5 * 3600_000), 15);
  assert.equal(badgeTickMinutes(5 * 24 * 3600_000), 60);
});

test("nextBadgeEvent picks the soonest timed high-impact event", () => {
  const events = [
    event("allday", 1, { all_day: true }),
    event("low", 2, { market_impact: "low" }),
    event("hit", 3),
    event("later", 9),
  ];
  assert.equal(nextBadgeEvent(events, { now: NOW }).id, "hit");
  assert.equal(nextBadgeEvent([], { now: NOW }), null);
});

test("isStale flags an old or absent cache", () => {
  const day = 24 * 3600 * 1000;
  assert.ok(isStale(null, NOW));
  assert.ok(isStale(NOW - 11 * day, NOW));
  assert.ok(!isStale(NOW - 2 * day, NOW));
});

test("groupByDay labels today and tomorrow and buckets in the given zone", () => {
  // 2026-07-28T12:00Z is 8am in New York.
  const events = [
    event("a", 1),
    event("b", 2),
    event("c", 25),
    event("d", 50),
  ];
  const groups = groupByDay(events, "America/New_York", NOW);
  assert.deepEqual(groups.map((group) => group.label).slice(0, 2), ["Today", "Tomorrow"]);
  assert.deepEqual(groups[0].events.map((item) => item.id), ["a", "b"]);
  assert.equal(groups.length, 3);
});

test("groupByDay buckets by local day, not UTC day", () => {
  // 2026-07-29T01:00Z is still the evening of the 28th in New York.
  const lateUtc = { ...event("late", 13), start_utc: "2026-07-29T01:00:00Z" };
  const [group] = groupByDay([lateUtc], "America/New_York", NOW);
  assert.equal(group.label, "Today");
  const [utcGroup] = groupByDay([lateUtc], "UTC", NOW);
  assert.equal(utcGroup.label, "Tomorrow");
});

test("zonedTimeToUtc resolves a wall-clock hour in a zone", () => {
  // 8am in Denver is 14:00Z in summer (MDT) and 15:00Z in winter (MST).
  assert.equal(
    new Date(zonedTimeToUtc("2026-07-15", 8, 0, "America/Denver")).toISOString(),
    "2026-07-15T14:00:00.000Z",
  );
  assert.equal(
    new Date(zonedTimeToUtc("2026-01-15", 8, 0, "America/Denver")).toISOString(),
    "2026-01-15T15:00:00.000Z",
  );
  assert.ok(Number.isNaN(zonedTimeToUtc("nonsense", 8, 0, "UTC")));
});

test("all-day events get a morning-of notification", () => {
  const roll = event("roll", 30, { all_day: true, date_et: "2026-07-29" });
  const planned = plannedNotifications([roll], {
    now: NOW,
    timeZone: "America/Denver",
    allDayHour: 8,
    horizonMs: 72 * HOUR,
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].offsetMinutes, null);
  assert.equal(
    new Date(planned[0].fireAt).toISOString(),
    "2026-07-29T14:00:00.000Z",
  );
});

test("all-day notifications can be switched off without affecting timed ones", () => {
  const events = [
    event("roll", 30, { all_day: true, date_et: "2026-07-29" }),
    event("cpi", 30),
  ];
  const planned = plannedNotifications(events, {
    now: NOW,
    allDayHour: null,
    timeZone: "UTC",
    horizonMs: 72 * HOUR,
  });
  assert.ok(planned.every((item) => item.eventId === "cpi"));
});

test("snoozed events are dropped until their snooze expires", () => {
  const events = [event("a", 2), event("b", 3)];
  const planned = plannedNotifications(events, {
    now: NOW,
    snoozedUntil: { a: NOW + HOUR },
    horizonMs: 72 * HOUR,
  });
  assert.ok(planned.every((item) => item.eventId === "b"));
  // An expired snooze no longer suppresses.
  const after = plannedNotifications(events, {
    now: NOW,
    snoozedUntil: { a: NOW - HOUR },
    horizonMs: 72 * HOUR,
  });
  assert.ok(after.some((item) => item.eventId === "a"));
});

test("prefs migration splits the old single threshold", () => {
  // A permissive browsing filter must not become a notification threshold --
  // that is the bug the split exists to fix.
  const migrated = migratePrefs({ minImpact: "low" });
  assert.equal(migrated.viewMinImpact, "low");
  assert.equal(migrated.notifyMinImpact, "medium");
  assert.equal(migrated.minImpact, undefined);
});

test("migration never makes notifications noisier than they were", () => {
  // Someone who had set "high" kept a quiet inbox; do not downgrade them.
  assert.equal(migratePrefs({ minImpact: "high" }).notifyMinImpact, "high");
  assert.equal(migratePrefs({ minImpact: "medium" }).notifyMinImpact, "medium");
  assert.equal(migratePrefs({ minImpact: "low" }).notifyMinImpact, "medium");
});

test("migration leaves already-split prefs alone", () => {
  const already = { viewMinImpact: "low", notifyMinImpact: "high" };
  const migrated = migratePrefs(already);
  assert.equal(migrated.viewMinImpact, "low");
  assert.equal(migrated.notifyMinImpact, "high");
  // A stale legacy key alongside new ones must not override them.
  const both = migratePrefs({ ...already, minImpact: "low" });
  assert.equal(both.viewMinImpact, "low");
  assert.equal(both.notifyMinImpact, "high");
  assert.equal(both.minImpact, undefined);
});

test("migration fills defaults and preserves unrelated prefs", () => {
  const migrated = migratePrefs({ timeZone: "America/Denver" });
  assert.equal(migrated.viewMinImpact, "medium");
  assert.equal(migrated.notifyMinImpact, "medium");
  assert.equal(migrated.timeZone, "America/Denver");
  assert.deepEqual(migrated.alarmOffsets, [30, 5]);
  // An empty store yields the defaults untouched.
  assert.deepEqual(migratePrefs({}), migratePrefs(undefined));
});
