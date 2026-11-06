/**
 * The morning brief: one weekday notification summarising today's events.
 *
 * Pure functions only, so the schedule and the wording are testable without
 * chrome.*; background.js owns the alarm and the notification call.
 */

import { dayKey, zonedTimeToUtc } from "./filters.js";

/** Impact levels worth a line in the brief. Bill auctions would drown it. */
const BRIEF_IMPACTS = new Set(["high", "medium"]);
// A basic notification shows roughly three lines; past that it truncates
// mid-word, so the brief names the first few and counts the rest.
const MAX_LISTED = 4;

/**
 * Weekday of an ISO calendar date, 0 = Sunday. Anchored at noon UTC so the
 * answer is the same in every zone.
 */
function weekdayOf(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

function addDays(isoDate, days) {
  const next = new Date(`${isoDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * The next instant the brief should fire: `hour`:00 local time in
 * `timeZone`, on the next weekday whose brief time is still ahead of `now`.
 * Weekends are skipped -- there is nothing scheduled to brief.
 */
export function nextBriefTime(now, hour, timeZone) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return NaN;
  let day = dayKey(now, timeZone);
  for (let step = 0; step < 8; step += 1) {
    const weekday = weekdayOf(day);
    if (weekday !== 0 && weekday !== 6) {
      const fireAt = zonedTimeToUtc(day, hour, 0, timeZone);
      if (fireAt > now) return fireAt;
    }
    day = addDays(day, 1);
  }
  return NaN;
}

/**
 * Today's brief, or null when there is nothing worth interrupting for.
 *
 * Lists high- and medium-impact events plus anything the user set a reminder
 * on, in time order, as "8:30 CPI · 10:00 Consumer sentiment".
 */
export function buildBrief(events, options = {}) {
  const {
    now = Date.now(),
    timeZone,
    hour12,
    hiddenTypes = [],
    reminders = [],
  } = options;
  const hidden = new Set(hiddenTypes);
  const pinned = new Set(reminders);
  const today = dayKey(now, timeZone);

  const todays = (events ?? []).filter((event) => {
    if (hidden.has(event.event_type)) return false;
    if (!BRIEF_IMPACTS.has(event.market_impact) && !pinned.has(event.id)) return false;
    // All-day entries carry their Eastern date; timed ones are bucketed in
    // the viewer's zone, as the agenda does.
    const key = event.all_day
      ? event.date_et
      : dayKey(Date.parse(event.start_utc), timeZone);
    return key === today;
  });
  if (!todays.length) return null;

  todays.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone, hour12, hour: "numeric", minute: "2-digit",
  });

  const parts = todays.slice(0, MAX_LISTED).map((event) =>
    event.all_day ? event.title : `${time.format(new Date(event.start_utc))} ${event.title}`,
  );
  const extra = todays.length - MAX_LISTED;
  if (extra > 0) parts.push(`+${extra} more`);

  const high = todays.filter((event) => event.market_impact === "high").length;
  const count = `${todays.length} event${todays.length === 1 ? "" : "s"}`;
  return {
    title: high ? `Today: ${count} · ${high} high impact` : `Today: ${count}`,
    message: parts.join(" · "),
    priority: high ? 2 : 1,
  };
}
