/**
 * Tests for market session state.
 *
 * Session rules are written in Eastern wall-clock time, so every case pins an
 * explicit UTC instant and asserts the state a New York trader would see.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  etRangeInZone,
  etTimeInZone,
  formatMinutes,
  futuresSessionStatus,
  isEasternZone,
  marketCalendar,
  sessionStatus,
  upcomingClosures,
} from "../src/sessions.js";

const HOURS = {
  timezone: "America/New_York",
  equities: {
    premarket_open: "04:00",
    regular_open: "09:30",
    regular_close: "16:00",
    afterhours_close: "20:00",
    early_close: "13:00",
  },
  futures: { note: "futures note" },
};

const EMPTY = { holidays: {}, earlyCloses: {} };
const at = (iso) => Date.parse(iso);

test("formatMinutes renders 12-hour times", () => {
  assert.equal(formatMinutes(9 * 60 + 30), "9:30am");
  assert.equal(formatMinutes(16 * 60), "4:00pm");
  assert.equal(formatMinutes(12 * 60), "12:00pm");
  assert.equal(formatMinutes(0), "12:00am");
});

test("a normal weekday walks through every session", () => {
  // 2026-07-29 is a Wednesday. Times below are ET expressed as UTC (EDT, -4).
  const cases = [
    ["2026-07-29T07:00:00Z", "closed"],      // 3:00am ET
    ["2026-07-29T12:00:00Z", "premarket"],   // 8:00am ET
    ["2026-07-29T14:00:00Z", "regular"],     // 10:00am ET
    ["2026-07-29T21:00:00Z", "afterhours"],  // 5:00pm ET
    ["2026-07-30T01:00:00Z", "closed"],      // 9:00pm ET
  ];
  for (const [iso, expected] of cases) {
    assert.equal(sessionStatus(at(iso), EMPTY, HOURS).state, expected, iso);
  }
});

test("the open and close boundaries are inclusive of the open", () => {
  // 9:30am ET exactly is open; 4:00pm ET exactly is after hours.
  assert.equal(sessionStatus(at("2026-07-29T13:30:00Z"), EMPTY, HOURS).state, "regular");
  assert.equal(sessionStatus(at("2026-07-29T13:29:00Z"), EMPTY, HOURS).state, "premarket");
  assert.equal(sessionStatus(at("2026-07-29T20:00:00Z"), EMPTY, HOURS).state, "afterhours");
});

test("weekends are closed", () => {
  // 2026-08-01 is a Saturday, 2026-08-02 a Sunday.
  for (const iso of ["2026-08-01T14:00:00Z", "2026-08-02T14:00:00Z"]) {
    const status = sessionStatus(at(iso), EMPTY, HOURS);
    assert.equal(status.state, "closed-weekend");
    assert.equal(status.detail, "Weekend");
  }
});

test("a holiday closes the market and names itself", () => {
  const calendar = { holidays: { "2026-11-26": "Thanksgiving Day" }, earlyCloses: {} };
  const status = sessionStatus(at("2026-11-26T15:00:00Z"), calendar, HOURS);
  assert.equal(status.state, "closed-holiday");
  assert.equal(status.detail, "Thanksgiving Day");
});

test("an early close ends the session at 1pm and says why", () => {
  const calendar = {
    holidays: {},
    earlyCloses: { "2026-11-27": "Day after Thanksgiving" },
  };
  // 2026-11-27 is EST (-5). 14:00Z = 9:00am ET, 18:30Z = 1:30pm ET.
  const open = sessionStatus(at("2026-11-27T16:00:00Z"), calendar, HOURS);
  assert.equal(open.state, "regular");
  assert.match(open.detail, /1:00pm/);
  assert.match(open.detail, /Day after Thanksgiving/);
  assert.equal(open.isEarlyClose, true);

  // After 1pm ET there is no after-hours session on a half day.
  const after = sessionStatus(at("2026-11-27T18:30:00Z"), calendar, HOURS);
  assert.equal(after.state, "closed");
});

test("marketCalendar indexes closures by date", () => {
  const events = [
    { event_type: "market_holiday", date_et: "2026-12-25", holiday_name: "Christmas Day" },
    { event_type: "market_early_close", date_et: "2026-12-24", holiday_name: "Christmas Eve" },
    { event_type: "macro_release_cpi", date_et: "2026-12-10" },
  ];
  const calendar = marketCalendar(events);
  assert.deepEqual(calendar.holidays, { "2026-12-25": "Christmas Day" });
  assert.deepEqual(calendar.earlyCloses, { "2026-12-24": "Christmas Eve" });
});

test("upcomingClosures drops past dates and other event types", () => {
  const events = [
    { event_type: "market_holiday", date_et: "2026-01-01", holiday_name: "New Year" },
    { event_type: "market_holiday", date_et: "2026-12-25", holiday_name: "Christmas" },
    { event_type: "market_early_close", date_et: "2026-11-27", holiday_name: "Friday" },
    { event_type: "fomc_statement", date_et: "2026-12-09" },
  ];
  const result = upcomingClosures(events, at("2026-07-28T12:00:00Z"));
  assert.deepEqual(result.map((e) => e.date_et), ["2026-11-27", "2026-12-25"]);
});

test("formatMinutes honours the 24-hour preference", () => {
  assert.equal(formatMinutes(9 * 60 + 30, false), "09:30");
  assert.equal(formatMinutes(16 * 60, false), "16:00");
  assert.equal(formatMinutes(0, false), "00:00");
  assert.equal(formatMinutes(13 * 60, false), "13:00");
  // Explicit true and the default both give 12-hour.
  assert.equal(formatMinutes(13 * 60, true), "1:00pm");
  assert.equal(formatMinutes(13 * 60), "1:00pm");
});

test("futures run the week from Sunday evening to Friday afternoon", () => {
  const H = { timezone: "America/New_York", futures: {} };
  const state = (iso) => futuresSessionStatus(at(iso), EMPTY, H).state;

  assert.equal(state("2026-08-01T18:00:00Z"), "closed-weekend");  // Sat 2pm ET
  assert.equal(state("2026-08-02T20:00:00Z"), "closed-weekend");  // Sun 4pm ET
  assert.equal(state("2026-08-02T22:00:00Z"), "open");            // Sun 6pm ET
  assert.equal(state("2026-07-29T14:00:00Z"), "open");            // Wed 10am ET
  assert.equal(state("2026-07-31T14:00:00Z"), "open");            // Fri 10am ET
  assert.equal(state("2026-07-31T21:00:00Z"), "closed-weekend");  // Fri 5pm ET
});

test("the weekday evening halt is an hour, not a close", () => {
  const H = { timezone: "America/New_York", futures: {} };
  // Wed 5:30pm ET is the halt; 6:00pm ET reopens.
  assert.equal(futuresSessionStatus(at("2026-07-29T21:30:00Z"), EMPTY, H).state, "halt");
  assert.equal(futuresSessionStatus(at("2026-07-29T22:00:00Z"), EMPTY, H).state, "open");
  // Friday has no halt -- the week has already ended by then.
  assert.equal(futuresSessionStatus(at("2026-07-31T21:30:00Z"), EMPTY, H).state, "closed-weekend");
});

test("futures holidays report a shortened session, not a closure", () => {
  const H = { timezone: "America/New_York", futures: {} };
  const calendar = { holidays: { "2026-11-26": "Thanksgiving Day" }, earlyCloses: {} };
  const status = futuresSessionStatus(at("2026-11-26T15:00:00Z"), calendar, H);
  // CME usually trades a shortened session rather than going dark, so
  // claiming "closed" would be worse than telling the user to check.
  assert.equal(status.state, "holiday");
  assert.match(status.detail, /verify the session with CME/);
});

test("Eastern times convert to the viewer's zone against a reference date", () => {
  // Denver is a fixed 2h behind ET year-round.
  assert.equal(etTimeInZone("2026-07-29", "09:30", "America/Denver", true).text, "7:30 AM");
  assert.equal(etTimeInZone("2026-01-15", "09:30", "America/Denver", true).text, "7:30 AM");
});

test("the ET offset is not fixed, which is why a reference date is required", () => {
  // US and UK daylight saving shift on different dates, so 9:30am ET is 13:30
  // in London during part of March and 14:30 in July. A baked-in mapping would
  // be wrong for several weeks a year.
  const march = etTimeInZone("2026-03-10", "09:30", "Europe/London", false).text;
  const july = etTimeInZone("2026-07-15", "09:30", "Europe/London", false).text;
  assert.equal(march, "13:30");
  assert.equal(july, "14:30");
  assert.notEqual(march, july);
});

test("a session crossing midnight is marked with a day offset", () => {
  // Tokyo sees the 4:00pm ET close at 5:00am the next morning.
  const close = etTimeInZone("2026-07-29", "16:00", "Asia/Tokyo", false);
  assert.equal(close.text, "05:00");
  assert.equal(close.dayOffset, 1);

  const range = etRangeInZone("2026-07-29", "09:30", "16:00", "Asia/Tokyo", false);
  assert.match(range, /\+1d/);
});

test("isEasternZone spots a viewer already on Eastern", () => {
  assert.equal(isEasternZone("2026-07-29", "America/New_York"), true);
  assert.equal(isEasternZone("2026-07-29", "America/Denver"), false);
  assert.equal(isEasternZone("2026-07-29", undefined), false);
});

test("sessionStatus reports the next boundary for local rendering", () => {
  const open = sessionStatus(at("2026-07-29T14:00:00Z"), EMPTY, HOURS);
  assert.deepEqual(open.nextChange, { verb: "Closes", hhmm: "16:00" });

  const early = sessionStatus(
    at("2026-11-27T16:00:00Z"),
    { holidays: {}, earlyCloses: { "2026-11-27": "Day after Thanksgiving" } },
    HOURS,
  );
  assert.deepEqual(early.nextChange, { verb: "Closes", hhmm: "13:00" });
  assert.equal(early.earlyCloseName, "Day after Thanksgiving");

  // Once the day is over there is no boundary left to show.
  assert.equal(sessionStatus(at("2026-07-30T01:00:00Z"), EMPTY, HOURS).nextChange, null);
});

test("futures boundaries are returned as data, not baked-in Eastern strings", () => {
  const H = { timezone: "America/New_York", futures: {} };
  // Mid-session on a weekday: the halt is a range the caller localises.
  const open = futuresSessionStatus(at("2026-07-29T14:00:00Z"), EMPTY, H);
  assert.deepEqual(open.haltRange, { from: "17:00", to: "18:00" });

  // During the halt, and over the weekend, it is a single boundary.
  assert.deepEqual(
    futuresSessionStatus(at("2026-07-29T21:30:00Z"), EMPTY, H).nextChange,
    { verb: "Reopens", hhmm: "18:00" },
  );
  assert.deepEqual(
    futuresSessionStatus(at("2026-08-01T18:00:00Z"), EMPTY, H).nextChange,
    { verb: "Reopens Sunday", hhmm: "18:00" },
  );
  // Friday closes for the week rather than halting.
  assert.deepEqual(
    futuresSessionStatus(at("2026-07-31T14:00:00Z"), EMPTY, H).nextChange,
    { verb: "Closes", hhmm: "17:00", suffix: "today" },
  );
});

test("the halt renders in the viewer's zone", () => {
  // 5:00-6:00pm ET is 3:00-4:00pm in Denver and 22:00-23:00 in London.
  assert.equal(
    etRangeInZone("2026-07-29", "17:00", "18:00", "America/Denver", true),
    "3:00 PM–4:00 PM",
  );
  assert.equal(
    etRangeInZone("2026-07-29", "17:00", "18:00", "Europe/London", false),
    "22:00–23:00",
  );
});
