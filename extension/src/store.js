/**
 * chrome.storage access and feed fetching.
 *
 * The MV3 service worker is killed after ~30s idle, so nothing is cached in
 * module scope -- every read goes to chrome.storage.local, which survives.
 */

import { FEED_URL, STORAGE_KEYS } from "./config.js";
import { migratePrefs } from "./filters.js";

export async function getPrefs() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.prefs);
  return migratePrefs(stored[STORAGE_KEYS.prefs] ?? {});
}

export async function setPrefs(patch) {
  const next = { ...(await getPrefs()), ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEYS.prefs]: next });
  return next;
}

/**
 * Snoozed event ids mapped to the timestamp they resume at. Expired entries
 * are pruned on read so the record cannot grow without bound.
 */
export async function getSnoozes() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.snoozes);
  const snoozes = stored[STORAGE_KEYS.snoozes] ?? {};
  const now = Date.now();
  const live = Object.fromEntries(
    Object.entries(snoozes).filter(([, until]) => until > now),
  );
  if (Object.keys(live).length !== Object.keys(snoozes).length) {
    await chrome.storage.local.set({ [STORAGE_KEYS.snoozes]: live });
  }
  return live;
}

export async function snoozeEvent(eventId, until) {
  const snoozes = await getSnoozes();
  snoozes[eventId] = until;
  await chrome.storage.local.set({ [STORAGE_KEYS.snoozes]: snoozes });
}

/**
 * Event ids with a per-event reminder. Ids for events more than a day past
 * are pruned on read, given the current feed, so the list cannot grow.
 */
export async function getReminders(events = null) {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.reminders);
  const ids = Array.isArray(stored[STORAGE_KEYS.reminders]) ? stored[STORAGE_KEYS.reminders] : [];
  if (!events) return ids;

  const cutoff = Date.now() - 24 * 3600 * 1000;
  const live = ids.filter((id) => {
    const event = events.find((candidate) => candidate.id === id);
    // An id missing from this feed is kept: a refresh can drop and restore
    // an event, and losing the user's reminder over that would be wrong.
    return !event || Date.parse(event.start_utc) >= cutoff;
  });
  if (live.length !== ids.length) {
    await chrome.storage.sync.set({ [STORAGE_KEYS.reminders]: live });
  }
  return live;
}

/** Turn a reminder on or off; returns whether it is now on. */
export async function setReminder(eventId, on) {
  const ids = new Set(await getReminders());
  if (on) ids.add(eventId);
  else ids.delete(eventId);
  await chrome.storage.sync.set({ [STORAGE_KEYS.reminders]: [...ids] });
  return on;
}

export async function getCached() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.calendar,
    STORAGE_KEYS.fetchedAt,
    STORAGE_KEYS.lastError,
  ]);
  return {
    calendar: stored[STORAGE_KEYS.calendar] ?? null,
    fetchedAt: stored[STORAGE_KEYS.fetchedAt] ?? null,
    lastError: stored[STORAGE_KEYS.lastError] ?? null,
  };
}

/**
 * Fetch the feed, using the stored ETag so an unchanged feed costs a 304.
 * Returns { calendar, changed }. On failure the previous cache is kept and
 * the error is recorded -- a stale calendar beats a blank one.
 */
export async function refreshFeed({ force = false } = {}) {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.etag,
    STORAGE_KEYS.calendar,
  ]);
  const headers = {};
  if (stored[STORAGE_KEYS.etag] && !force) {
    headers["If-None-Match"] = stored[STORAGE_KEYS.etag];
  }

  try {
    const response = await fetch(FEED_URL, { headers, cache: "no-cache" });

    if (response.status === 304 && stored[STORAGE_KEYS.calendar]) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.fetchedAt]: Date.now(),
        [STORAGE_KEYS.lastError]: null,
      });
      return { calendar: stored[STORAGE_KEYS.calendar], changed: false };
    }

    if (!response.ok) throw new Error(`feed responded ${response.status}`);

    const calendar = await response.json();
    if (!Array.isArray(calendar?.events)) {
      throw new Error("feed is missing an events array");
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.calendar]: calendar,
      [STORAGE_KEYS.etag]: response.headers.get("ETag") ?? null,
      [STORAGE_KEYS.fetchedAt]: Date.now(),
      [STORAGE_KEYS.lastError]: null,
    });
    return { calendar, changed: true };
  } catch (error) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastError]: {
        message: String(error?.message ?? error),
        at: Date.now(),
      },
    });
    return { calendar: stored[STORAGE_KEYS.calendar] ?? null, changed: false };
  }
}
