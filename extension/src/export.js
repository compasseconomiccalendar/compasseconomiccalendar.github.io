/**
 * Single-event calendar export: a Google Calendar link and an .ics file.
 *
 * Only schedule facts the feed already publishes go out -- title, time, the
 * description note and the official source link -- which is the same data
 * the public .ics subscriptions carry.
 */

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

/** 20261110T133000Z */
function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 20261110 */
function dateStamp(isoDate) {
  return isoDate.replace(/-/g, "");
}

function nextDate(isoDate) {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** Start and end as calendar values; all-day events use DATE, end exclusive. */
function span(event) {
  if (event.all_day) {
    const day = event.date_et ?? event.start_utc.slice(0, 10);
    return { allDay: true, start: dateStamp(day), end: dateStamp(nextDate(day)) };
  }
  const start = Date.parse(event.start_utc);
  const end = event.end_utc ? Date.parse(event.end_utc) : start + DEFAULT_DURATION_MS;
  return {
    allDay: false,
    start: utcStamp(start),
    end: utcStamp(end > start ? end : start + DEFAULT_DURATION_MS),
  };
}

function description(event) {
  return [event.note, event.source_url ? `Verify: ${event.source_url}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** A link that opens Google Calendar's new-event form, prefilled. */
export function googleCalendarUrl(event) {
  const { start, end } = span(event);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${start}/${end}`,
    details: description(event),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** RFC 5545 TEXT escaping. */
function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line at 75 octets, as RFC 5545 requires. Splits on
 * characters, counting UTF-8 bytes, so a multi-byte character is never cut.
 */
function fold(line) {
  const encoder = new TextEncoder();
  const out = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines start with a space, which counts toward their 75.
    const limit = out.length ? 74 : 75;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** A one-event VCALENDAR document. */
export function icsForEvent(event, now = Date.now()) {
  const { allDay, start, end } = span(event);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Compass Economic Calendar//Extension//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@compasseconomiccalendar.github.io`,
    `DTSTAMP:${utcStamp(now)}`,
    allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
    allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(description(event))}`,
  ];
  if (event.source_url) lines.push(`URL:${event.source_url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** A safe, readable filename: "consumer-price-index-cpi-2026-11-10.ics". */
export function icsFilename(event) {
  const slug = String(event.title ?? "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "event";
  const day = event.date_et ?? String(event.start_utc ?? "").slice(0, 10);
  return `${slug}${day ? `-${day}` : ""}.ics`;
}
