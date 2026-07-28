/**
 * MV3 service worker: keeps the cached feed fresh and fires advance warnings.
 *
 * The worker is evicted after ~30s idle and restarted on each event, so every
 * handler re-reads its state from storage. Nothing survives in module scope.
 */

import {
  MAX_SCHEDULED_ALARMS,
  NOTIFY_PREFIX,
  REFRESH_ALARM,
  REFRESH_PERIOD_MINUTES,
  SCHEDULE_HORIZON_HOURS,
} from "./config.js";
import { alarmName, parseAlarmName, plannedNotifications } from "./filters.js";
import { getCached, getPrefs, refreshFeed } from "./store.js";

const HORIZON_MS = SCHEDULE_HORIZON_HOURS * 3600 * 1000;

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
    minImpact: prefs.minImpact,
    hiddenTypes: prefs.hiddenTypes,
    horizonMs: HORIZON_MS,
    max: MAX_SCHEDULED_ALARMS,
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
  console.info(`[compass] refreshed; ${count} notification(s) scheduled`);
}

async function showNotification(eventId, offsetMinutes) {
  const { calendar } = await getCached();
  const event = calendar?.events?.find((candidate) => candidate.id === eventId);
  if (!event) return;

  const when = new Date(event.start_utc).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  await chrome.notifications.create(`compass:${event.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `${event.title} in ${offsetMinutes} min`,
    message: `${when} · ${event.market_impact.toUpperCase()} impact`,
    contextMessage: "Compass Economic Calendar",
    priority: event.market_impact === "high" ? 2 : 1,
  });
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

  const parsed = parseAlarmName(NOTIFY_PREFIX, alarm.name);
  if (!parsed) return;

  await showNotification(parsed.eventId, parsed.offsetMinutes);
  // One alarm just fired, freeing a slot -- pull the next one in.
  await rescheduleNotifications();
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

// The popup asks for a refresh when the user hits the reload control.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "refresh") {
    refreshAndReschedule({ force: true }).then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async reply
  }
  if (message?.type === "reschedule") {
    rescheduleNotifications().then((count) => sendResponse({ ok: true, count }));
    return true;
  }
  return false;
});
