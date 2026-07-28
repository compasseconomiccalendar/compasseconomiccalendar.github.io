/**
 * chrome.storage access and feed fetching.
 *
 * The MV3 service worker is killed after ~30s idle, so nothing is cached in
 * module scope -- every read goes to chrome.storage.local, which survives.
 */

import { DEFAULT_PREFS, FEED_URL, STORAGE_KEYS } from "./config.js";

export async function getPrefs() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.prefs);
  return { ...DEFAULT_PREFS, ...(stored[STORAGE_KEYS.prefs] ?? {}) };
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
