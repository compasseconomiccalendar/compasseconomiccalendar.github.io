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
};

export const DEFAULT_PREFS = {
  minImpact: "medium",
  // Matches the advance-warning cadence in RESEARCH.md section Phase 2.
  alarmOffsets: [30, 5],
  notificationsEnabled: true,
  hiddenTypes: [],
  // null means "use the browser's zone"; otherwise an IANA name such as
  // "America/Denver" (RESEARCH.md section 4.3 calls for this override).
  timeZone: null,
};

export const MAX_ALARM_OFFSETS = 4;

export const REFRESH_ALARM = "compass:refresh";
export const NOTIFY_PREFIX = "compass:notify:";

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
