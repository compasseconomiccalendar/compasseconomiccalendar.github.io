/**
 * Pure selection logic over the calendar feed.
 *
 * Everything here is a plain function of its arguments -- no chrome.* calls,
 * no clock reads -- so the service worker can be restarted at any moment
 * without losing state, and so this can be tested under plain node.
 */

import { DEFAULT_PREFS } from "./config.js";

export const IMPACT_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Merge stored preferences over the defaults, migrating the old schema.
 *
 * Both the list and notifications now filter by event type. Impact drove them
 * in earlier versions, first through a shared `minImpact` and then through a
 * split `viewMinImpact` / `notifyMinImpact`. None of those keys mean anything
 * now, so they are stripped rather than left in synced storage as settings
 * that silently do nothing.
 */
export function migratePrefs(stored = {}) {
  const merged = { ...DEFAULT_PREFS, ...stored };
  for (const dead of ["minImpact", "viewMinImpact", "notifyMinImpact"]) {
    delete merged[dead];
  }
  return merged;
}

/** Mirrors the coverage families emitted by ingestion/build_calendar.py. */
export function familyOf(eventType) {
  if (eventType.startsWith("fomc_")) return "fomc";
  if (eventType.startsWith("macro_release_")) return "macro_releases";
  if (eventType === "treasury_auction") return "treasury_auctions";
  if (eventType === "treasury_quarterly_refunding") return "treasury_refunding";
  if (eventType.startsWith("market_")) return "market_sessions";
  if (
    eventType.startsWith("futures_") ||
    eventType === "quad_witching" ||
    eventType === "monthly_opex"
  ) {
    return "futures";
  }
  return "other";
}

export function meetsImpact(event, minImpact) {
  return (IMPACT_RANK[event.market_impact] ?? 0) >= (IMPACT_RANK[minImpact] ?? 0);
}

function startMs(event) {
  return Date.parse(event.start_utc);
}

/**
 * Upcoming events, soonest first.
 *
 * `now` is passed in rather than read from the clock so results are
 * deterministic. An event is "upcoming" until it starts; a release at 8:30
 * stops being upcoming at 8:30 even though it stays interesting afterwards.
 */
export function upcomingEvents(events, options = {}) {
  const {
    now = Date.now(),
    minImpact = "low",
    hiddenTypes = [],
    limit = Infinity,
    horizonMs = Infinity,
    // How long an event stays in the list after it starts. Without this an
    // FOMC statement disappears at 2:00:01 -- exactly when you are watching it.
    graceMs = 0,
    types = null,
  } = options;

  const hidden = new Set(hiddenTypes);
  const allowedGroups = types ? new Set(types) : null;
  const cutoff = horizonMs === Infinity ? Infinity : now + horizonMs;

  return events
    .filter((event) => {
      const start = startMs(event);
      if (!Number.isFinite(start) || start + graceMs < now || start > cutoff) {
        return false;
      }
      if (hidden.has(event.event_type)) return false;
      if (allowedGroups && !allowedGroups.has(groupOf(event.event_type))) {
        return false;
      }
      return meetsImpact(event, minImpact);
    })
    .sort((a, b) => startMs(a) - startMs(b))
    .slice(0, limit === Infinity ? undefined : limit);
}

/** Whether an event has started but is still inside its grace window. */
export function isInProgress(event, now, graceMs) {
  const start = startMs(event);
  return Number.isFinite(start) && start <= now && start + graceMs >= now;
}

/**
 * Coarse groupings for the popup's filter chips. Narrower than `familyOf`,
 * which mirrors the feed's coverage families.
 */
export function groupOf(eventType) {
  if (eventType.startsWith("fomc_")) return "fomc";
  if (eventType.startsWith("macro_release_") || eventType.startsWith("ism_")) {
    return "data";
  }
  if (eventType.startsWith("treasury_")) return "treasury";
  if (eventType.startsWith("market_")) return "market";
  return "futures";
}

export const TYPE_GROUPS = [
  { id: "fomc", label: "FOMC" },
  { id: "data", label: "Data" },
  { id: "treasury", label: "Treasury" },
  { id: "futures", label: "Futures" },
  { id: "market", label: "Market" },
];

/**
 * The next event worth putting on the toolbar badge, or null.
 * All-day events are skipped: a countdown to midnight is not useful.
 */
export function nextBadgeEvent(events, options = {}) {
  const { now = Date.now(), minImpact = "high", hiddenTypes = [] } = options;
  const candidates = upcomingEvents(events, { now, minImpact, hiddenTypes });
  return candidates.find((event) => !event.all_day) ?? null;
}

/**
 * Badge text for a countdown, kept to four characters so Chrome does not
 * truncate it: "5m", "45m", "2h", "3d".
 */
export function badgeText(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil < 0) return "";
  const minutes = Math.floor(msUntil / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How often the badge needs redrawing, given how far out the event is.
 * Chrome's alarm floor is 30s, and there is no point ticking every minute
 * when the next event is three days away.
 */
export function badgeTickMinutes(msUntil) {
  if (!Number.isFinite(msUntil)) return 60;
  const minutes = msUntil / 60_000;
  if (minutes <= 60) return 1;
  if (minutes <= 24 * 60) return 15;
  return 60;
}

/** True when the cached feed is old enough that its times may have moved. */
export function isStale(fetchedAt, now = Date.now(), thresholdDays = 10) {
  if (!fetchedAt) return true;
  return now - fetchedAt > thresholdDays * 24 * 3600 * 1000;
}

/**
 * Split events into day buckets in the given zone, labelled Today/Tomorrow
 * where that applies. Bucketing must happen in the viewer's zone, not UTC,
 * or an 8:30pm ET event lands on the wrong day.
 */
export function groupByDay(events, timeZone, now = Date.now()) {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  });
  const labelFormat = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const today = keyFormat.format(new Date(now));
  const tomorrow = keyFormat.format(new Date(now + 24 * 3600 * 1000));

  const groups = [];
  let current = null;
  for (const event of events) {
    const when = new Date(event.start_utc);
    const key = keyFormat.format(when);
    if (!current || current.key !== key) {
      let label = labelFormat.format(when);
      if (key === today) label = "Today";
      else if (key === tomorrow) label = "Tomorrow";
      current = { key, label, events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

/**
 * The notification alarms that should exist right now.
 *
 * Returns at most `max` entries, soonest first. All-day events are skipped --
 * "30 minutes before midnight UTC" is not a useful warning. Offsets that have
 * already passed are dropped rather than fired late.
 */
export function plannedNotifications(events, options = {}) {
  const {
    now = Date.now(),
    offsets = [30, 5],
    minImpact = "low",
    hiddenTypes = [],
    types = null,
    horizonMs = 72 * 3600 * 1000,
    max = 20,
    // All-day events (futures rolls, meeting day 1) have no meaningful
    // "30 minutes before", so they get a morning-of nudge instead.
    allDayHour = 8,
    timeZone = undefined,
    snoozedUntil = {},
  } = options;

  const candidates = upcomingEvents(events, {
    now,
    minImpact,
    hiddenTypes,
    types,
    horizonMs,
  });

  const planned = [];
  for (const event of candidates) {
    if ((snoozedUntil[event.id] ?? 0) > now) continue;

    if (event.all_day) {
      if (allDayHour === null) continue;
      const day = event.date_et ?? event.start_utc.slice(0, 10);
      const fireAt = zonedTimeToUtc(day, allDayHour, 0, timeZone);
      if (Number.isFinite(fireAt) && fireAt > now && fireAt - now <= horizonMs) {
        planned.push({ eventId: event.id, offsetMinutes: null, fireAt });
      }
      continue;
    }

    const start = startMs(event);
    for (const offset of offsets) {
      const fireAt = start - offset * 60_000;
      if (fireAt <= now) continue;
      planned.push({ eventId: event.id, offsetMinutes: offset, fireAt });
    }
  }

  return planned.sort((a, b) => a.fireAt - b.fireAt).slice(0, max);
}

/** The UTC offset of `timeZone` at a given instant, in milliseconds. */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/**
 * The UTC instant for a wall-clock time on a given date in a zone.
 *
 * Two-step: guess as if the zone were UTC, measure the real offset at that
 * guess, then correct. Good to the minute except exactly at a DST boundary,
 * which a morning notification never lands on.
 */
export function zonedTimeToUtc(isoDate, hour, minute = 0, timeZone = undefined) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  if (!year || !month || !day) return NaN;
  // A non-finite hour reaches Date.UTC as NaN, and formatToParts throws
  // RangeError on the resulting Invalid Date rather than returning anything
  // the caller can check. Reject it here instead.
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - zoneOffsetMs(new Date(guess), timeZone);
}

export function alarmName(prefix, eventId, offsetMinutes) {
  return `${prefix}${offsetMinutes}:${eventId}`;
}

export function parseAlarmName(prefix, name) {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator === -1) return null;
  const offsetMinutes = Number(rest.slice(0, separator));
  if (!Number.isFinite(offsetMinutes)) return null;
  return { offsetMinutes, eventId: rest.slice(separator + 1) };
}

/**
 * Translate the time-format preference into Intl's `hour12` option.
 *
 * `undefined` is meaningful here, not a failure: it tells Intl to use the
 * locale's own convention, which is what "auto" means.
 */
export function resolveHour12(preference) {
  if (preference === "12h") return true;
  if (preference === "24h") return false;
  return undefined;
}

/**
 * Validate a stored timezone preference.
 *
 * Returns the zone if usable, or undefined to mean "let the formatter use the
 * browser's zone". A stored zone can stop being valid if the user's Chrome is
 * older than the tzdata the name came from, so this never throws.
 */
export function resolveTimeZone(preference) {
  if (!preference) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: preference });
    return preference;
  } catch {
    return undefined;
  }
}

/**
 * Parse a user-entered list of warning offsets, e.g. "30, 5" -> [30, 5].
 *
 * Sorted furthest-out first, deduplicated, non-positive and non-numeric
 * entries dropped. Returns null when nothing usable was entered, so callers
 * can reject the input rather than silently saving an empty schedule.
 */
export function parseOffsets(text, max = 4) {
  const values = String(text)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.round);

  const unique = [...new Set(values)].sort((a, b) => b - a).slice(0, max);
  return unique.length ? unique : null;
}

/**
 * Whether a family's schedule is published far enough to cover `throughMs`.
 *
 * The feed's coverage block distinguishes computed families (complete by
 * construction) from reported ones (bounded by what the agency has published).
 * A view that reaches past `confirmed_through` is showing an unpublished
 * range, not an empty one, and should say so.
 */
export function coverageGaps(coverage, throughMs) {
  if (!coverage?.families) return [];
  const gaps = [];
  for (const [family, info] of Object.entries(coverage.families)) {
    if (info.horizon !== "reported" || !info.confirmed_through) continue;
    // confirmed_through is a date; treat it as covering that whole day.
    const confirmedMs = Date.parse(`${info.confirmed_through}T23:59:59Z`);
    if (Number.isFinite(confirmedMs) && throughMs > confirmedMs) {
      gaps.push({ family, confirmedThrough: info.confirmed_through });
    }
  }
  return gaps;
}
