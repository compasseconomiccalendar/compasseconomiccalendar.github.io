/**
 * Week at a glance: the next five trading weekdays with a count of high- and
 * medium-impact events on each, so busy days stand out before you scroll.
 */

import { dayKey } from "./filters.js";

function addDays(isoDate, days) {
  const next = new Date(`${isoDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function isWeekend(isoDate) {
  const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * One entry per weekday, starting today (or the next weekday on a weekend):
 * { key, weekday, day, high, medium, closed, early, isToday }.
 *
 * `events` should already be the filtered list the agenda shows, so the strip
 * and the list always agree. Holidays and early closes are read from the full
 * feed via `allEvents`, so filtering the list to FOMC does not hide that the
 * market is shut.
 */
export function weekGlance(events, options = {}) {
  const { now = Date.now(), timeZone, days = 5, allEvents = events } = options;
  const today = dayKey(now, timeZone);

  const keys = [];
  for (let day = today; keys.length < days; day = addDays(day, 1)) {
    if (!isWeekend(day)) keys.push(day);
  }

  const keyOf = (event) =>
    event.all_day ? event.date_et : dayKey(Date.parse(event.start_utc), timeZone);

  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
  return keys.map((key) => {
    const onDay = (events ?? []).filter((event) => keyOf(event) === key);
    const marketEvents = (allEvents ?? []).filter((event) => event.date_et === key);
    const anchor = new Date(`${key}T12:00:00Z`);
    return {
      key,
      weekday: weekday.format(anchor),
      day: anchor.getUTCDate(),
      high: onDay.filter((event) => event.market_impact === "high").length,
      medium: onDay.filter((event) => event.market_impact === "medium").length,
      closed: marketEvents.some((event) => event.event_type === "market_holiday"),
      early: marketEvents.some((event) => event.event_type === "market_early_close"),
      isToday: key === today,
    };
  });
}
