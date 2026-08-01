/**
 * MV3 service worker: keeps the cached feed fresh and fires advance warnings.
 *
 * The worker is evicted after ~30s idle and restarted on each event, so every
 * handler re-reads its state from storage. Nothing survives in module scope.
 */

import {
  BADGE_ALARM,
  MAX_SCHEDULED_ALARMS,
  NOTIFY_PREFIX,
  REFRESH_ALARM,
  REFRESH_PERIOD_MINUTES,
  SCHEDULE_HORIZON_HOURS,
  SNOOZE_MINUTES,
} from "./config.js";
import {
  alarmName,
  badgeText,
  badgeTickMinutes,
  isStale,
  nextBadgeEvent,
  parseAlarmName,
  plannedNotifications,
  resolveHour12,
  resolveTimeZone,
} from "./filters.js";
import { marketCalendar, sessionStatus } from "./sessions.js";
import {
  getCached,
  getPrefs,
  getSnoozes,
  refreshFeed,
  snoozeEvent,
} from "./store.js";

const HORIZON_MS = SCHEDULE_HORIZON_HOURS * 3600 * 1000;

/**
 * Paint the toolbar badge with a countdown to the next high-impact event.
 *
 * This is the only part of the extension visible without opening the popup,
 * so it is also where a stale feed gets flagged.
 */
async function updateBadge() {
  const [{ calendar, fetchedAt }, prefs] = await Promise.all([
    getCached(),
    getPrefs(),
  ]);

  if (!calendar?.events?.length || isStale(fetchedAt)) {
    await chrome.action.setBadgeText({ text: calendar ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#9a9a94" });
    await chrome.action.setTitle({
      title: calendar
        ? "Compass — calendar data is stale, open to refresh"
        : "Compass Economic Calendar",
    });
    chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 60 });
    return;
  }

  const event = nextBadgeEvent(calendar.events, {
    now: Date.now(),
    minImpact: "high",
    hiddenTypes: prefs.hiddenTypes,
  });

  if (!event) {
    const market = sessionStatus(
      Date.now(),
      marketCalendar(calendar.events),
      calendar.market_hours,
    );
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({
      title: `Compass — market ${market.label.toLowerCase()}${
        market.detail ? ` (${market.detail})` : ""
      }`,
    });
    chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 60 });
    return;
  }

  const msUntil = Date.parse(event.start_utc) - Date.now();
  const urgent = msUntil <= 30 * 60_000;

  // Same shared session logic the popup uses, so market state is known
  // without the popup ever being opened.
  const market = sessionStatus(
    Date.now(),
    marketCalendar(calendar.events),
    calendar.market_hours,
  );

  await chrome.action.setBadgeText({ text: badgeText(msUntil) });
  await chrome.action.setBadgeBackgroundColor({
    color: urgent ? "#c2410c" : "#6b6b66",
  });
  await chrome.action.setTitle({
    title: `Market ${market.label.toLowerCase()} · ${event.title} — ${new Intl.DateTimeFormat(undefined, {
      timeZone: resolveTimeZone(prefs.timeZone),
      hour12: resolveHour12(prefs.timeFormat),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(event.start_utc))}`,
  });

  // Tick faster as the event approaches, slower when it is days out.
  chrome.alarms.create(BADGE_ALARM, {
    periodInMinutes: badgeTickMinutes(msUntil),
  });
}

/**
 * Rebuild the notification alarms from the cached feed.
 *
 * Chrome persists alarms across worker restarts, so this clears the ones it
 * owns before rescheduling instead of accumulating duplicates.
 */
async function rescheduleNotifications() {
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((alarm) => alarm.name.startsWith(NOTIFY_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name)),
  );

  const prefs = await getPrefs();
  if (!prefs.notificationsEnabled) return 0;

  const { calendar } = await getCached();
  if (!calendar?.events) return 0;

  const planned = plannedNotifications(calendar.events, {
    now: Date.now(),
    offsets: prefs.alarmOffsets,
    types: prefs.notifyGroups?.length ? prefs.notifyGroups : null,
    hiddenTypes: prefs.hiddenTypes,
    horizonMs: HORIZON_MS,
    max: MAX_SCHEDULED_ALARMS,
    allDayHour: prefs.allDayNotifications ? prefs.allDayHour : null,
    timeZone: resolveTimeZone(prefs.timeZone),
    snoozedUntil: await getSnoozes(),
  });

  for (const item of planned) {
    chrome.alarms.create(
      alarmName(NOTIFY_PREFIX, item.eventId, item.offsetMinutes),
      { when: item.fireAt },
    );
  }
  return planned.length;
}

async function refreshAndReschedule(options) {
  await refreshFeed(options);
  const count = await rescheduleNotifications();
  await updateBadge();
  console.info(`[compass] refreshed; ${count} notification(s) scheduled`);
}

async function showNotification(eventId, offsetMinutes) {
  const { calendar } = await getCached();
  const event = calendar?.events?.find((candidate) => candidate.id === eventId);
  if (!event) return;

  const prefs = await getPrefs();
  const when = new Intl.DateTimeFormat(undefined, {
    timeZone: resolveTimeZone(prefs.timeZone),
    hour12: resolveHour12(prefs.timeFormat),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(event.start_utc));

  const title = offsetMinutes === null
    ? `Today: ${event.title}`
    : `${event.title} in ${offsetMinutes} min`;
  const message = event.all_day
    ? `${event.market_impact.toUpperCase()} impact`
    : `${when} · ${event.market_impact.toUpperCase()} impact`;

  const base = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: event.approximate ? `${message} · estimated date` : message,
    contextMessage: "Compass Economic Calendar",
    priority: event.market_impact === "high" ? 2 : 1,
  };

  // Buttons are decoration, and support for them varies by platform -- some
  // native notification backends reject the whole call rather than dropping
  // the unsupported field. Delivering the warning matters more than the
  // buttons, so a failure retries without them.
  const withButtons = {
    ...base,
    buttons: [{ title: "Verify at source" }, { title: `Snooze ${SNOOZE_MINUTES}m` }],
  };

  await deliver(`compass:${event.id}`, withButtons, base, title);
}

/**
 * Create a notification, retrying without the optional decoration if the
 * platform rejects it. Returns { ok, error } so callers can report a failure
 * rather than leave the user staring at nothing.
 */
async function deliver(id, rich, plain, label) {
  const create = (options) =>
    new Promise((resolve) => {
      chrome.notifications.create(id, options, (created) => {
        resolve({ id: created, error: chrome.runtime.lastError?.message ?? null });
      });
    });

  let result = await create(rich);
  if (!result.id) {
    console.warn(`[compass] notification with buttons failed: ${result.error}`);
    result = await create(plain);
  }
  if (!result.id) {
    console.error(`[compass] notification failed entirely: ${result.error}`);
    return { ok: false, error: result.error ?? "unknown error" };
  }
  console.info(`[compass] notified: ${label}`);
  return { ok: true, error: null };
}

/** Fires one notification now, so the user can verify delivery end to end. */
async function sendTestNotification() {
  const level = await new Promise((resolve) =>
    chrome.notifications.getPermissionLevel(resolve),
  );
  if (level !== "granted") {
    return {
      ok: false,
      error: `Chrome reports notification permission is "${level}". Check your OS notification settings for this browser.`,
    };
  }

  const base = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Compass test notification",
    message: "Notifications are working. Real warnings look like this.",
    contextMessage: "Compass Economic Calendar",
  };
  return deliver(
    "compass:test",
    { ...base, buttons: [{ title: "Verify at source" }, { title: "Snooze 60m" }] },
    base,
    "test",
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: REFRESH_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
  await refreshAndReschedule({ force: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshAndReschedule();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    await refreshAndReschedule();
    return;
  }
  if (alarm.name === BADGE_ALARM) {
    await updateBadge();
    return;
  }

  const parsed = parseAlarmName(NOTIFY_PREFIX, alarm.name);
  if (!parsed) return;

  // Logged so the alarm -> notification path is visible in the console even
  // when the notification itself never appears on screen.
  console.info(`[compass] alarm fired: ${alarm.name}`);
  await showNotification(parsed.eventId, parsed.offsetMinutes);
  // One alarm just fired, freeing a slot -- pull the next one in.
  await rescheduleNotifications();
  await updateBadge();
});

// Clicking a notification opens the official source so the time can be
// verified, which is the "verify at official source" mitigation in
// RESEARCH.md section 7.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const eventId = notificationId.replace(/^compass:/, "");
  const { calendar } = await getCached();
  const event = calendar?.events?.find((candidate) => candidate.id === eventId);
  if (event?.source_url) await chrome.tabs.create({ url: event.source_url });
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, index) => {
  const eventId = notificationId.replace(/^compass:/, "");
  chrome.notifications.clear(notificationId);

  if (index === 0) {
    const { calendar } = await getCached();
    const event = calendar?.events?.find((candidate) => candidate.id === eventId);
    if (event?.source_url) await chrome.tabs.create({ url: event.source_url });
    return;
  }

  await snoozeEvent(eventId, Date.now() + SNOOZE_MINUTES * 60_000);
  await rescheduleNotifications();
});

// The popup asks for a refresh when the user hits the reload control.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "refresh") {
    refreshAndReschedule({ force: true }).then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async reply
  }
  if (message?.type === "test-notification") {
    sendTestNotification().then(sendResponse);
    return true;
  }
  if (message?.type === "reschedule") {
    rescheduleNotifications().then((count) => sendResponse({ ok: true, count }));
    return true;
  }
  return false;
});
