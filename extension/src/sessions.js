/**
 * Market session state, derived from the feed's `market_hours` block and its
 * market_holiday / market_early_close events.
 *
 * Pure functions taking an explicit `now`, so the status is deterministic and
 * testable. All reasoning happens in Eastern wall-clock time, because that is
 * what the exchange rules are written in -- doing it in the viewer's zone
 * would break for anyone outside New York.
 */

import { zonedTimeToUtc } from "./filters.js";

const ET = "America/New_York";

const DEFAULT_HOURS = {
  timezone: "America/New_York",
  equities: {
    premarket_open: "04:00",
    regular_open: "09:30",
    regular_close: "16:00",
    afterhours_close: "20:00",
    early_close: "13:00",
  },
};

/** Wall-clock parts of an instant in a given zone. */
export function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl gives hour 24 rather than 0 at midnight under hour12: false.
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    weekday: weekdays[parts.weekday],
  };
}

function toMinutes(hhmm) {
  const [hour, minute] = String(hhmm).split(":").map(Number);
  return hour * 60 + minute;
}

export function formatMinutes(minutes, hour12 = true) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const padded = String(minute).padStart(2, "0");
  if (hour12 === false) return `${String(hour).padStart(2, "0")}:${padded}`;
  const suffix = hour >= 12 ? "pm" : "am";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${padded}${suffix}`;
}

/**
 * Render an Eastern wall-clock time in the viewer's zone.
 *
 * Resolved against a reference date rather than a fixed offset, because the
 * gap between ET and another zone is not constant: US and UK daylight-saving
 * transitions fall on different dates, so 9:30am ET is 13:30 in London during
 * one part of March and 14:30 during another. A baked-in mapping is wrong for
 * several weeks a year.
 *
 * Returns { text, dayOffset } where dayOffset is -1, 0 or +1 relative to the
 * Eastern date -- Tokyo sees the US close on the following morning.
 */
export function etTimeInZone(isoDate, hhmm, timeZone, hour12 = undefined) {
  const [hour, minute] = String(hhmm).split(":").map(Number);
  const instant = new Date(zonedTimeToUtc(isoDate, hour, minute, ET));
  if (Number.isNaN(instant.getTime())) return { text: hhmm, dayOffset: 0 };

  const text = new Intl.DateTimeFormat(undefined, {
    timeZone, hour12, hour: "numeric", minute: "2-digit",
  }).format(instant);

  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  const dayOffset = Math.round(
    (Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${isoDate}T00:00:00Z`)) / 86_400_000,
  );

  return { text, dayOffset };
}

/** "9:30am – 4:00pm" in the viewer's zone, marking any date rollover. */
export function etRangeInZone(isoDate, startHHMM, endHHMM, timeZone, hour12) {
  const start = etTimeInZone(isoDate, startHHMM, timeZone, hour12);
  const end = etTimeInZone(isoDate, endHHMM, timeZone, hour12);
  const suffix = (offset) => (offset === 0 ? "" : offset > 0 ? " (+1d)" : " (−1d)");
  return `${start.text}${suffix(start.dayOffset)}–${end.text}${suffix(end.dayOffset)}`;
}

/** Whether the viewer's zone shows the same wall clock as Eastern. */
export function isEasternZone(isoDate, timeZone) {
  if (!timeZone) return false;
  return (
    etTimeInZone(isoDate, "09:30", timeZone).text ===
    etTimeInZone(isoDate, "09:30", ET).text
  );
}

const DEFAULT_FUTURES = {
  week_open: "18:00",
  week_close: "17:00",
  daily_halt_start: "17:00",
  daily_halt_end: "18:00",
};

/**
 * CME equity index futures session state (/ES, /NQ, /MES, /MNQ).
 *
 * The week runs Sunday 6:00pm ET to Friday 5:00pm ET with a one-hour halt each
 * evening. Holidays are reported as "holiday schedule" rather than closed:
 * CME usually runs a *shortened* session on exchange holidays rather than
 * going dark, and claiming closed would be worse than saying go and check.
 */
export function futuresSessionStatus(now, calendar, hours = {}) {
  const futures = { ...DEFAULT_FUTURES, ...(hours?.futures ?? {}) };
  const zone = hours?.timezone ?? DEFAULT_HOURS.timezone;
  const { date: today, minutes, weekday } = zonedParts(new Date(now), zone);

  const weekOpen = toMinutes(futures.week_open);
  const weekClose = toMinutes(futures.week_close);
  const haltStart = toMinutes(futures.daily_halt_start);
  const haltEnd = toMinutes(futures.daily_halt_end);

  if (weekday === 6) {
    return { state: "closed-weekend", label: "Closed", detail: "Reopens Sunday 6:00pm ET" };
  }
  if (weekday === 0) {
    return minutes < weekOpen
      ? { state: "closed-weekend", label: "Closed", detail: "Opens 6:00pm ET tonight" }
      : { state: "open", label: "Open", detail: "Trading through the week" };
  }
  if (weekday === 5 && minutes >= weekClose) {
    return { state: "closed-weekend", label: "Closed", detail: "Reopens Sunday 6:00pm ET" };
  }

  // Mon-Thu evenings pause for an hour between sessions.
  if (weekday >= 1 && weekday <= 4 && minutes >= haltStart && minutes < haltEnd) {
    return { state: "halt", label: "Daily halt", detail: "Reopens 6:00pm ET" };
  }

  const holidayName = calendar?.holidays?.[today];
  if (holidayName) {
    return {
      state: "holiday",
      label: "Holiday schedule",
      detail: `${holidayName} — verify the session with CME`,
    };
  }

  return {
    state: "open",
    label: "Open",
    detail:
      weekday === 5
        ? "Closes 5:00pm ET today"
        : "Halts 5:00pm–6:00pm ET",
  };
}

/**
 * Index the feed's closure events by date.
 * Returns { holidays: {date: name}, earlyCloses: {date: name} }.
 */
export function marketCalendar(events = []) {
  const holidays = {};
  const earlyCloses = {};
  for (const event of events) {
    const day = event.date_et;
    if (!day) continue;
    if (event.event_type === "market_holiday") {
      holidays[day] = event.holiday_name ?? "Market holiday";
    } else if (event.event_type === "market_early_close") {
      earlyCloses[day] = event.holiday_name ?? "Early close";
    }
  }
  return { holidays, earlyCloses };
}

/**
 * The equity session state right now.
 *
 * Returns { state, label, detail, closeMinutes, holidayName, isEarlyClose },
 * where `state` is one of closed-holiday | closed-weekend | premarket |
 * regular | afterhours | closed.
 */
export function sessionStatus(now, calendar, hours = DEFAULT_HOURS) {
  const equities = { ...DEFAULT_HOURS.equities, ...(hours?.equities ?? {}) };
  const zone = hours?.timezone ?? DEFAULT_HOURS.timezone;
  const { date: today, minutes, weekday } = zonedParts(new Date(now), zone);

  const holidayName = calendar?.holidays?.[today];
  const earlyName = calendar?.earlyCloses?.[today];

  if (holidayName) {
    return {
      state: "closed-holiday",
      label: "Closed",
      detail: holidayName,
      holidayName,
      isEarlyClose: false,
    };
  }
  // Intl weekday: 0 = Sunday, 6 = Saturday.
  if (weekday === 0 || weekday === 6) {
    return {
      state: "closed-weekend",
      label: "Closed",
      detail: "Weekend",
      isEarlyClose: false,
    };
  }

  const preOpen = toMinutes(equities.premarket_open);
  const open = toMinutes(equities.regular_open);
  const close = toMinutes(earlyName ? equities.early_close : equities.regular_close);
  const afterClose = earlyName ? close : toMinutes(equities.afterhours_close);

  let state = "closed";
  let label = "Closed";
  let detail = `Opens ${formatMinutes(open)} ET`;
  // The boundary is returned separately so callers can render it in the
  // viewer's zone; `detail` stays Eastern as a fallback.
  let nextChange = { verb: "Opens", hhmm: equities.regular_open };

  if (minutes >= preOpen && minutes < open) {
    state = "premarket";
    label = "Pre-market";
    detail = `Regular open ${formatMinutes(open)} ET`;
    nextChange = { verb: "Regular open", hhmm: equities.regular_open };
  } else if (minutes >= open && minutes < close) {
    state = "regular";
    label = "Open";
    detail = `Closes ${formatMinutes(close)} ET`;
    nextChange = {
      verb: "Closes",
      hhmm: earlyName ? equities.early_close : equities.regular_close,
    };
  } else if (minutes >= close && minutes < afterClose) {
    state = "afterhours";
    label = "After hours";
    detail = `Until ${formatMinutes(afterClose)} ET`;
    nextChange = { verb: "Until", hhmm: equities.afterhours_close };
  } else if (minutes >= afterClose) {
    detail = "Reopens tomorrow";
    nextChange = null;
  }

  return {
    state,
    label,
    detail: earlyName && state !== "closed" ? `${detail} · ${earlyName}` : detail,
    closeMinutes: close,
    nextChange,
    earlyCloseName: earlyName ?? null,
    holidayName: null,
    isEarlyClose: Boolean(earlyName),
  };
}

/** Upcoming closures and half days, soonest first. */
export function upcomingClosures(events = [], now = Date.now(), limit = 8) {
  const today = new Date(now).toISOString().slice(0, 10);
  return events
    .filter(
      (event) =>
        (event.event_type === "market_holiday" ||
          event.event_type === "market_early_close") &&
        event.date_et >= today,
    )
    .sort((a, b) => a.date_et.localeCompare(b.date_et))
    .slice(0, limit);
}
