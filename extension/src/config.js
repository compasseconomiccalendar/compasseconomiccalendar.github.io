/**
 * Shared constants. The extension is a thin client: it reads one static JSON
 * from GitHub Pages and never calls a government site directly (RESEARCH.md
 * section 4.2), which is what keeps host_permissions to a single entry.
 */

export const FEED_BASE =
  "https://compasseconomiccalendar.github.io/compasseconomiccalendar";
export const FEED_URL = `${FEED_BASE}/calendar.json`;

export const STORAGE_KEYS = {
  calendar: "calendar",
  fetchedAt: "fetchedAt",
  etag: "etag",
  lastError: "lastError",
  prefs: "prefs",
  snoozes: "snoozes",
};

export const DEFAULT_PREFS = {
  // Notifications are filtered by event type, like the list. Defaulted to the
  // two that matter rather than everything: with no filter, every Treasury
  // bill auction would interrupt you and the alarm ceiling would bind.
  notifyGroups: ["fomc", "data"],
  // Which event types the list shows; empty means all.
  selectedGroups: [],
  // How far ahead the list reaches.
  viewHorizonDays: 90,
  // Dark by default; the toggle sets an explicit theme rather than following
  // the OS, so the choice sticks.
  theme: "dark",
  // Matches the advance-warning cadence in RESEARCH.md section Phase 2.
  alarmOffsets: [30, 5],
  notificationsEnabled: true,
  hiddenTypes: [],
  // null means "use the browser's zone"; otherwise an IANA name such as
  // "America/Denver" (RESEARCH.md section 4.3 calls for this override).
  timeZone: null,
  // "auto" follows the viewer's locale; "12h" and "24h" force the format.
  timeFormat: "auto",
  // All-day events (futures rolls, FOMC day 1) get a morning-of nudge
  // instead of a "30 minutes before", which would mean 30 min before midnight.
  allDayNotifications: true,
  allDayHour: 8,
};

// How long an event stays in the list after it starts, so an FOMC statement
// does not vanish at 2:00:01 while you are reading the reaction.
export const IN_PROGRESS_GRACE_MS = 90 * 60 * 1000;

export const MAX_ALARM_OFFSETS = 4;

export const REFRESH_ALARM = "compass:refresh";
export const BADGE_ALARM = "compass:badge";
export const NOTIFY_PREFIX = "compass:notify:";

export const SNOOZE_MINUTES = 60;
export const STALE_AFTER_DAYS = 10;

// The feed rebuilds weekly; twice a day is plenty and stays well clear of the
// MV3 alarm floor (30s since Chrome 120).
export const REFRESH_PERIOD_MINUTES = 12 * 60;

// Chrome keeps alarms in a shared table, so only the near-term events get one.
// Every refresh and every fired alarm rebuilds the schedule.
export const SCHEDULE_HORIZON_HOURS = 72;
export const MAX_SCHEDULED_ALARMS = 20;

export const DISCLAIMER =
  "For informational and educational purposes only. Not investment advice. " +
  "Times are subject to change; verify against official sources before trading.";

export const FRED_ATTRIBUTION =
  "This product uses the FRED® API but is not endorsed or certified by " +
  "the Federal Reserve Bank of St. Louis.";
