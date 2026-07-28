/**
 * Popup: upcoming events in the viewer's local timezone.
 *
 * Rendering is done with explicit DOM calls rather than innerHTML so no feed
 * string is ever parsed as markup.
 */

import { detailRows, formatTimes } from "../src/details.js";
import { coverageGaps, resolveTimeZone, upcomingEvents } from "../src/filters.js";
import { getCached, getPrefs, setPrefs } from "../src/store.js";

const VIEW_HORIZON_MS = 90 * 24 * 3600 * 1000;
const LIST_LIMIT = 50;

const elements = {
  events: document.getElementById("events"),
  empty: document.getElementById("empty"),
  banner: document.getElementById("banner"),
  status: document.getElementById("status"),
  impact: document.getElementById("impact"),
  refresh: document.getElementById("refresh"),
  options: document.getElementById("options"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  back: document.getElementById("back"),
  detailTitle: document.getElementById("detail-title"),
  detailTimes: document.getElementById("detail-times"),
  detailNote: document.getElementById("detail-note"),
  detailRows: document.getElementById("detail-rows"),
  detailSource: document.getElementById("detail-source"),
  detailPrimary: document.getElementById("detail-primary"),
  detailAttribution: document.getElementById("detail-attribution"),
};

// The zone the detail view formats against; kept in sync with prefs on render.
let activeTimeZone;

// Rebuilt on each render because the zone is a saved preference, not a
// constant (RESEARCH.md section 4.3 calls for a timezone override).
let dayFormat;
let timeFormat;

function buildFormatters(timeZonePref) {
  const timeZone = resolveTimeZone(timeZonePref);
  activeTimeZone = timeZone;
  dayFormat = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  timeFormat = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function relativeLabel(startMs, now) {
  const minutes = Math.round((startMs - now) / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

function renderEvent(event, now) {
  const item = document.createElement("li");
  item.className = `event impact-${event.market_impact}`;

  const when = document.createElement("div");
  when.className = "when";
  const start = new Date(event.start_utc);
  const day = document.createElement("span");
  day.className = "day";
  day.textContent = dayFormat.format(start);
  when.append(day);

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = event.all_day ? "all day" : timeFormat.format(start);
  when.append(time);

  const body = document.createElement("div");
  body.className = "body";

  const title = document.createElement("button");
  title.className = "title";
  title.type = "button";
  title.textContent = event.title;
  title.addEventListener("click", () => showDetail(event));
  body.append(title);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent = event.note;
  body.append(note);

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${event.market_impact} impact · ${relativeLabel(
    Date.parse(event.start_utc),
    now,
  )}`;
  body.append(meta);

  item.append(when, body);
  return item;
}

function renderBanner(calendar, now) {
  const gaps = coverageGaps(calendar.coverage, now + VIEW_HORIZON_MS);
  if (!gaps.length) {
    elements.banner.hidden = true;
    return;
  }
  const parts = gaps.map(
    (gap) => `${gap.family.replace(/_/g, " ")} through ${gap.confirmedThrough}`,
  );
  elements.banner.textContent = `Schedules published only up to: ${parts.join(
    "; ",
  )}. Later dates are unpublished, not empty.`;
  elements.banner.hidden = false;
}

function renderStatus(fetchedAt, lastError) {
  if (lastError) {
    elements.status.textContent = `Showing cached data — last refresh failed (${lastError.message}).`;
    elements.status.classList.add("error");
    return;
  }
  elements.status.classList.remove("error");
  elements.status.textContent = fetchedAt
    ? `Updated ${new Date(fetchedAt).toLocaleString()}`
    : "No data cached yet.";
}

async function render() {
  const [{ calendar, fetchedAt, lastError }, prefs] = await Promise.all([
    getCached(),
    getPrefs(),
  ]);

  elements.impact.value = prefs.minImpact;
  buildFormatters(prefs.timeZone);
  renderStatus(fetchedAt, lastError);
  // A refresh or filter change can remove whatever the detail view was
  // showing, so always come back to the list.
  showList();
  elements.events.replaceChildren();

  if (!calendar?.events?.length) {
    elements.empty.textContent =
      "No calendar cached yet. Press ↻ to fetch the feed.";
    elements.empty.hidden = false;
    elements.banner.hidden = true;
    return;
  }

  const now = Date.now();
  renderBanner(calendar, now);

  const events = upcomingEvents(calendar.events, {
    now,
    minImpact: prefs.minImpact,
    hiddenTypes: prefs.hiddenTypes,
    limit: LIST_LIMIT,
    horizonMs: VIEW_HORIZON_MS,
  });

  if (!events.length) {
    elements.empty.textContent = "Nothing upcoming at this impact level.";
    elements.empty.hidden = false;
    return;
  }

  elements.empty.hidden = true;
  elements.events.append(
    ...events.map((event) => renderEvent(event, now)),
  );
}

elements.impact.addEventListener("change", async (domEvent) => {
  await setPrefs({ minImpact: domEvent.target.value });
  await render();
  chrome.runtime.sendMessage({ type: "reschedule" });
});

function appendPairs(target, pairs) {
  target.replaceChildren();
  for (const { label, value } of pairs) {
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value;
    target.append(term, definition);
  }
}

function showDetail(event) {
  elements.detailTitle.textContent = event.title;
  elements.detailNote.textContent = event.note;

  appendPairs(elements.detailTimes, formatTimes(event, activeTimeZone));
  appendPairs(elements.detailRows, detailRows(event));

  elements.detailSource.href = event.source_url;
  elements.detailSource.textContent = "Verify at official source →";

  if (event.primary_source_url) {
    elements.detailPrimary.href = event.primary_source_url;
    elements.detailPrimary.textContent = "Primary source →";
    elements.detailPrimary.hidden = false;
  } else {
    elements.detailPrimary.hidden = true;
  }

  if (event.attribution) {
    elements.detailAttribution.textContent = event.attribution;
    elements.detailAttribution.hidden = false;
  } else {
    elements.detailAttribution.hidden = true;
  }

  elements.listView.hidden = true;
  elements.detailView.hidden = false;
  elements.back.focus();
  window.scrollTo(0, 0);
}

function showList() {
  elements.detailView.hidden = true;
  elements.listView.hidden = false;
}

elements.back.addEventListener("click", showList);

document.addEventListener("keydown", (domEvent) => {
  if (domEvent.key === "Escape" && !elements.detailView.hidden) showList();
});

elements.options.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  elements.status.textContent = "Refreshing…";
  await chrome.runtime.sendMessage({ type: "refresh" });
  await render();
  elements.refresh.disabled = false;
});

render();
