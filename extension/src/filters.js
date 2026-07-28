/**
 * Pure selection logic over the calendar feed.
 *
 * Everything here is a plain function of its arguments -- no chrome.* calls,
 * no clock reads -- so the service worker can be restarted at any moment
 * without losing state, and so this can be tested under plain node.
 */

export const IMPACT_RANK = { low: 0, medium: 1, high: 2 };

/** Mirrors the coverage families emitted by ingestion/build_calendar.py. */
export function familyOf(eventType) {
  if (eventType.startsWith("fomc_")) return "fomc";
  if (eventType.startsWith("macro_release_")) return "macro_releases";
  if (eventType === "treasury_auction") return "treasury_auctions";
  if (eventType === "treasury_quarterly_refunding") return "treasury_refunding";
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
  } = options;

  const hidden = new Set(hiddenTypes);
  const cutoff = horizonMs === Infinity ? Infinity : now + horizonMs;

  return events
    .filter((event) => {
      const start = startMs(event);
      if (!Number.isFinite(start) || start < now || start > cutoff) return false;
      if (hidden.has(event.event_type)) return false;
      return meetsImpact(event, minImpact);
    })
    .sort((a, b) => startMs(a) - startMs(b))
    .slice(0, limit === Infinity ? undefined : limit);
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
    minImpact = "medium",
    hiddenTypes = [],
    horizonMs = 72 * 3600 * 1000,
    max = 20,
  } = options;

  const candidates = upcomingEvents(events, {
    now,
    minImpact,
    hiddenTypes,
    horizonMs,
  });

  const planned = [];
  for (const event of candidates) {
    if (event.all_day) continue;
    const start = startMs(event);
    for (const offset of offsets) {
      const fireAt = start - offset * 60_000;
      if (fireAt <= now) continue;
      planned.push({ eventId: event.id, offsetMinutes: offset, fireAt });
    }
  }

  return planned.sort((a, b) => a.fireAt - b.fireAt).slice(0, max);
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
