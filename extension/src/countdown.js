/**
 * Countdown formatting and the choice of which event leads the popup.
 *
 * Kept free of the DOM so both can be tested directly. The popup turns the
 * returned parts into spans so numbers and units can be styled separately.
 */

import { isInProgress } from "./filters.js";

/**
 * Split a duration into at most two display parts, largest unit first:
 * 4d 11h · 11h 23m · 42m 10s · 9s. Negative or invalid input is null.
 *
 * Seconds only appear inside the final hour, where they are worth watching;
 * further out they would just be motion.
 */
export function countdownParts(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil < 0) return null;
  const totalSeconds = Math.floor(msUntil / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return [[days, "d"], [hours, "h"]];
  if (hours > 0) return [[hours, "h"], [minutes, "m"]];
  if (minutes > 0) return [[minutes, "m"], [seconds, "s"]];
  return [[seconds, "s"]];
}

/** Plain-text form of countdownParts, e.g. "11h 23m"; "" when not upcoming. */
export function countdownText(msUntil) {
  const parts = countdownParts(msUntil);
  return parts ? parts.map(([value, unit]) => `${value}${unit}`).join(" ") : "";
}

/**
 * Compact relative label for an agenda row: "now", "in 25m", "in 11h",
 * "in 4d". Rounds down so a row never claims more time than remains.
 */
export function relativeShort(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return "now";
  const minutes = Math.floor(msUntil / 60_000);
  if (minutes < 1) return "in <1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/**
 * The event the hero card counts down to, or null.
 *
 * Only timed events that have not started qualify: a countdown to an all-day
 * entry is a countdown to midnight, and one already released has nothing
 * left to count. Among those, the first high-impact event wins, because that
 * is the one a trader plans around; otherwise the next timed event of any
 * impact.
 *
 * `events` must already be filtered and sorted by start, as upcomingEvents()
 * returns them.
 */
export function pickHero(events, now = Date.now(), graceMs = 0) {
  const ahead = (events ?? []).filter(
    (event) =>
      !event.all_day &&
      Date.parse(event.start_utc) > now &&
      !isInProgress(event, now, graceMs),
  );
  return ahead.find((event) => event.market_impact === "high") ?? ahead[0] ?? null;
}
