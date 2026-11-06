/**
 * The four v1.1.0 features: morning brief, calendar export, week at a
 * glance, and per-event reminders in the notification schedule.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildBrief, nextBriefTime } from "../src/brief.js";
import { googleCalendarUrl, icsFilename, icsForEvent } from "../src/export.js";
import { dayKey, plannedNotifications } from "../src/filters.js";
import { weekGlance } from "../src/glance.js";

const NY = "America/New_York";
const H = 3600 * 1000;
const M = 60 * 1000;

const event = (id, startIso, extra = {}) => ({
  id,
  event_type: "macro_release_cpi",
  title: id,
  start_utc: startIso,
  end_utc: null,
  all_day: false,
  date_et: startIso.slice(0, 10),
  market_impact: "high",
  source_url: "https://www.bls.gov/schedule/news_release/cpi.htm",
  note: "Headline and core CPI.",
  ...extra,
});

// ---------- dayKey ----------

test("dayKey buckets by the viewer's zone, zero-padded", () => {
  // 02:00 UTC on the 6th is still the evening of the 5th in New York.
  assert.equal(dayKey(Date.parse("2026-11-06T02:00:00Z"), NY), "2026-11-05");
  assert.equal(dayKey(Date.parse("2026-11-06T02:00:00Z"), "UTC"), "2026-11-06");
});

// ---------- Morning brief ----------

test("the brief fires later today when the hour is still ahead", () => {
  // Thu Nov 5 2026, 6:00 ET.
  const now = Date.parse("2026-11-05T11:00:00Z");
  assert.equal(nextBriefTime(now, 7, NY), Date.parse("2026-11-05T12:00:00Z"));
});

test("the brief rolls to the next weekday once today's hour has passed", () => {
  const thursdayNoon = Date.parse("2026-11-05T17:00:00Z");
  assert.equal(nextBriefTime(thursdayNoon, 7, NY), Date.parse("2026-11-06T12:00:00Z"));
  // Friday afternoon skips the weekend to Monday.
  const fridayNoon = Date.parse("2026-11-06T17:00:00Z");
  assert.equal(nextBriefTime(fridayNoon, 7, NY), Date.parse("2026-11-09T12:00:00Z"));
});

test("the brief follows DST: 7am Eastern is 11:00 UTC in summer", () => {
  const summerSunday = Date.parse("2026-07-05T12:00:00Z");
  assert.equal(nextBriefTime(summerSunday, 7, NY), Date.parse("2026-07-06T11:00:00Z"));
});

test("an invalid brief hour schedules nothing", () => {
  assert.ok(Number.isNaN(nextBriefTime(Date.now(), 24, NY)));
  assert.ok(Number.isNaN(nextBriefTime(Date.now(), 7.5, NY)));
});

test("the brief lists today's high and medium events in time order", () => {
  const now = Date.parse("2026-11-10T12:00:00Z"); // 7:00 ET
  const events = [
    event("CPI", "2026-11-10T13:30:00Z"),
    event("10-Year auction", "2026-11-10T18:00:00Z", { market_impact: "medium" }),
    event("4-Week bill", "2026-11-10T16:30:00Z", { market_impact: "low" }),
    event("Tomorrow's PPI", "2026-11-11T13:30:00Z"),
  ];
  const brief = buildBrief(events, { now, timeZone: NY, hour12: true });
  assert.equal(brief.title, "Today: 2 events · 1 high impact");
  assert.match(brief.message, /^8:30\sAM CPI · 1:00\sPM 10-Year auction$/);
  assert.equal(brief.priority, 2);
});

test("a low-impact event with a reminder makes the brief; hidden types do not", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const events = [
    event("4-Week bill", "2026-11-10T16:30:00Z", {
      market_impact: "low", event_type: "treasury_auction",
    }),
    event("CPI", "2026-11-10T13:30:00Z"),
  ];
  const brief = buildBrief(events, {
    now, timeZone: NY, reminders: ["4-Week bill"], hiddenTypes: ["macro_release_cpi"],
  });
  assert.equal(brief.title, "Today: 1 event");
  assert.match(brief.message, /4-Week bill/);
});

test("a quiet day produces no brief", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const events = [event("4-Week bill", "2026-11-10T16:30:00Z", { market_impact: "low" })];
  assert.equal(buildBrief(events, { now, timeZone: NY }), null);
  assert.equal(buildBrief([], { now, timeZone: NY }), null);
});

test("a long day names the first four and counts the rest", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const events = [1, 2, 3, 4, 5, 6].map((n) =>
    event(`E${n}`, `2026-11-10T1${n}:00:00Z`));
  const brief = buildBrief(events, { now, timeZone: NY });
  assert.match(brief.message, /E4 · \+2 more$/);
  assert.doesNotMatch(brief.message, /E5/);
});

// ---------- Calendar export ----------

test("Google Calendar link carries title, UTC times and the source", () => {
  const url = new URL(googleCalendarUrl(event("Consumer Price Index (CPI)", "2026-11-10T13:30:00Z")));
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "Consumer Price Index (CPI)");
  // No end_utc: a 30-minute block.
  assert.equal(url.searchParams.get("dates"), "20261110T133000Z/20261110T140000Z");
  assert.match(url.searchParams.get("details"), /Verify: https:\/\/www\.bls\.gov/);
});

test("all-day events export as DATE values with an exclusive end", () => {
  const holiday = event("Market Closed — Thanksgiving", "2026-11-26T12:00:00Z", {
    all_day: true, date_et: "2026-11-26",
  });
  assert.match(googleCalendarUrl(holiday), /dates=20261126%2F20261127/);
  const ics = icsForEvent(holiday, 0);
  assert.match(ics, /DTSTART;VALUE=DATE:20261126\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20261127\r\n/);
});

test("the .ics is valid RFC 5545: CRLF, escaped text, folded long lines", () => {
  const long = event("FOMC Statement; rates, balance sheet", "2026-12-09T19:00:00Z", {
    end_utc: "2026-12-09T19:30:00Z",
    note: "x".repeat(200),
  });
  const ics = icsForEvent(long, Date.parse("2026-11-05T00:00:00Z"));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("SUMMARY:FOMC Statement\\; rates\\, balance sheet\r\n"));
  assert.match(ics, /DTSTART:20261209T190000Z\r\nDTEND:20261209T193000Z\r\n/);
  assert.match(ics, /UID:FOMC Statement; rates, balance sheet@compasseconomiccalendar\.github\.io/);
  for (const line of ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line.length}`);
  }
  // Unfolding restores the description intact.
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("x".repeat(200)));
});

test("multi-byte characters are never split across folded lines", () => {
  const ics = icsForEvent(event("—".repeat(60), "2026-11-10T13:30:00Z"), 0);
  const summary = ics.replace(/\r\n /g, "").match(/SUMMARY:(.*)\r\n/)[1];
  assert.equal(summary, "—".repeat(60));
});

test(".ics filenames are slugged and dated", () => {
  assert.equal(
    icsFilename(event("Consumer Price Index (CPI)", "2026-11-10T13:30:00Z")),
    "consumer-price-index-cpi-2026-11-10.ics",
  );
  assert.equal(icsFilename({ title: "!!!", date_et: "2026-11-10" }), "event-2026-11-10.ics");
});

// ---------- Week at a glance ----------

test("the strip shows five weekdays from today and counts by impact", () => {
  const now = Date.parse("2026-11-05T15:00:00Z"); // Thursday
  const events = [
    event("NFP", "2026-11-06T13:30:00Z"),
    event("Claims", "2026-11-06T13:30:00Z", { market_impact: "medium" }),
    event("CPI", "2026-11-10T13:30:00Z"),
  ];
  const days = weekGlance(events, { now, timeZone: NY });
  assert.deepEqual(days.map((d) => d.key), [
    "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11",
  ]);
  assert.equal(days[0].isToday, true);
  assert.deepEqual([days[1].high, days[1].medium], [1, 1]);
  assert.equal(days[3].high, 1);
  assert.equal(days[2].high + days[2].medium, 0);
});

test("on a weekend the strip starts on Monday", () => {
  const saturday = Date.parse("2026-11-07T15:00:00Z");
  const days = weekGlance([], { now: saturday, timeZone: NY });
  assert.equal(days[0].key, "2026-11-09");
  assert.equal(days.some((d) => d.isToday), false);
});

test("holidays come from the full feed even when the list is filtered", () => {
  const now = Date.parse("2026-11-23T15:00:00Z"); // Monday of Thanksgiving week
  const holiday = event("Market Closed", "2026-11-26T12:00:00Z", {
    all_day: true, date_et: "2026-11-26", event_type: "market_holiday", market_impact: "low",
  });
  const early = event("Early close", "2026-11-27T18:00:00Z", {
    date_et: "2026-11-27", event_type: "market_early_close", market_impact: "low",
  });
  const days = weekGlance([], { now, timeZone: NY, allEvents: [holiday, early] });
  const thursday = days.find((d) => d.key === "2026-11-26");
  const friday = days.find((d) => d.key === "2026-11-27");
  assert.equal(thursday.closed, true);
  assert.equal(friday.early, true);
  assert.equal(friday.closed, false);
});

// ---------- Per-event reminders ----------

const NOW = Date.parse("2026-11-05T12:00:00Z");
const bill = event("bill", new Date(NOW + 5 * H).toISOString(), {
  event_type: "treasury_auction", market_impact: "low",
});
const cpi = event("cpi", new Date(NOW + 6 * H).toISOString());

test("a reminder notifies for an event its type filter excludes", () => {
  const base = { now: NOW, offsets: [30], types: ["data"], horizonMs: 72 * H };
  assert.deepEqual(plannedNotifications([bill, cpi], base).map((p) => p.eventId), ["cpi"]);
  assert.deepEqual(
    plannedNotifications([bill, cpi], { ...base, reminderIds: ["bill"] }).map((p) => p.eventId),
    ["bill", "cpi"],
  );
});

test("reminders fire with the master switch off; type alerts do not", () => {
  const planned = plannedNotifications([bill, cpi], {
    now: NOW, offsets: [30, 5], typeAlerts: false, reminderIds: ["bill"], horizonMs: 72 * H,
  });
  assert.deepEqual(planned.map((p) => [p.eventId, p.offsetMinutes]), [["bill", 30], ["bill", 5]]);
  assert.equal(planned[0].fireAt, Date.parse(bill.start_utc) - 30 * M);
});

test("an event that is both filtered in and reminded is scheduled once", () => {
  const planned = plannedNotifications([cpi], {
    now: NOW, offsets: [30], reminderIds: ["cpi"], horizonMs: 72 * H,
  });
  assert.equal(planned.length, 1);
});

test("a reminded all-day event gets a morning nudge even with those turned off", () => {
  const roll = event("roll", "2026-11-06T12:00:00Z", {
    all_day: true, date_et: "2026-11-06", event_type: "futures_liquidity_roll", market_impact: "low",
  });
  const base = { now: NOW, typeAlerts: false, allDayHour: null, timeZone: NY, horizonMs: 72 * H };
  assert.equal(plannedNotifications([roll], base).length, 0);
  const planned = plannedNotifications([roll], { ...base, reminderIds: ["roll"] });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].fireAt, Date.parse("2026-11-06T13:00:00Z")); // 8:00 ET
});
