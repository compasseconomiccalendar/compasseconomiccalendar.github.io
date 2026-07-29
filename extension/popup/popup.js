/**
 * Popup: upcoming events in the viewer's local timezone.
 *
 * Rendering is done with explicit DOM calls rather than innerHTML so no feed
 * string is ever parsed as markup.
 */

import { IN_PROGRESS_GRACE_MS, STALE_AFTER_DAYS } from "../src/config.js";
import {
  detailRows,
  formatTimes,
  typicalMoveBadge,
  typicalMoveDetail,
} from "../src/details.js";
import {
  TYPE_GROUPS,
  coverageGaps,
  groupByDay,
  isInProgress,
  isStale,
  resolveTimeZone,
  upcomingEvents,
} from "../src/filters.js";
import {
  formatMinutes,
  marketCalendar,
  sessionStatus,
  upcomingClosures,
} from "../src/sessions.js";
import { getCached, getPrefs, setPrefs } from "../src/store.js";

const VIEW_HORIZON_MS = 90 * 24 * 3600 * 1000;
const LIST_LIMIT = 60;

const elements = {
  events: document.getElementById("events"),
  empty: document.getElementById("empty"),
  banner: document.getElementById("banner"),
  chips: document.getElementById("chips"),
  more: document.getElementById("more"),
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
  detailMove: document.getElementById("detail-move"),
  moveHeadline: document.getElementById("move-headline"),
  moveRows: document.getElementById("move-rows"),
  moveWindow: document.getElementById("move-window"),
  tabEvents: document.getElementById("tab-events"),
  tabHours: document.getElementById("tab-hours"),
  hoursView: document.getElementById("hours-view"),
  session: document.getElementById("session"),
  hoursRows: document.getElementById("hours-rows"),
  closures: document.getElementById("closures"),
  futuresNote: document.getElementById("futures-note"),
};

let activeTab = "events";

// The zone the detail view formats against; kept in sync with prefs on render.
let activeTimeZone;
// Group ids currently selected in the chip row; empty means "all".
let activeGroups = new Set();

// Rebuilt on each render because the zone is a saved preference, not a
// constant (RESEARCH.md section 4.3 calls for a timezone override).
let timeFormat;

function buildFormatters(timeZonePref) {
  const timeZone = resolveTimeZone(timeZonePref);
  activeTimeZone = timeZone;
  timeFormat = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function relativeLabel(startMs, now) {
  const minutes = Math.round((startMs - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

function renderEvent(event, now) {
  const item = document.createElement("li");
  item.className = `event impact-${event.market_impact}`;
  const inProgress = isInProgress(event, now, IN_PROGRESS_GRACE_MS);
  if (inProgress) item.classList.add("in-progress");

  const when = document.createElement("div");
  when.className = "when";
  const start = new Date(event.start_utc);
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = event.all_day ? "all day" : timeFormat.format(start);
  when.append(time);

  const relative = document.createElement("span");
  relative.className = "relative";
  relative.textContent = inProgress
    ? "now"
    : relativeLabel(Date.parse(event.start_utc), now);
  when.append(relative);

  const body = document.createElement("div");
  body.className = "body";

  const title = document.createElement("button");
  title.className = "title";
  title.type = "button";
  title.textContent = event.title;
  title.addEventListener("click", () => showDetail(event));
  body.append(title);

  const moveBadge = typicalMoveBadge(event);
  if (moveBadge) {
    const badge = document.createElement("span");
    badge.className = "flag move-flag";
    badge.textContent = moveBadge;
    body.append(badge);
  }

  if (event.approximate) {
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = "estimated date";
    body.append(flag);
  }

  const note = document.createElement("p");
  note.className = "note";
  note.textContent = event.note;
  body.append(note);

  item.append(when, body);
  return item;
}

function renderChips() {
  elements.chips.replaceChildren();
  for (const group of TYPE_GROUPS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = group.label;
    chip.setAttribute("aria-pressed", String(activeGroups.has(group.id)));
    if (activeGroups.has(group.id)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      if (activeGroups.has(group.id)) activeGroups.delete(group.id);
      else activeGroups.add(group.id);
      render();
    });
    elements.chips.append(chip);
  }
}

function renderBanner(calendar, fetchedAt, now) {
  const messages = [];

  if (isStale(fetchedAt, now, STALE_AFTER_DAYS)) {
    messages.push(
      `This calendar has not refreshed in over ${STALE_AFTER_DAYS} days. ` +
        "Times may have changed — press ↻ and verify before trading.",
    );
  }
  if (calendar.partial_build) {
    const failed = (calendar.failed_sources ?? []).length;
    messages.push(
      `The feed was published with ${failed || "some"} source(s) failing, so ` +
        "events may be missing.",
    );
  }

  const gaps = coverageGaps(calendar.coverage, now + VIEW_HORIZON_MS);
  if (gaps.length) {
    const parts = gaps.map(
      (gap) => `${gap.family.replace(/_/g, " ")} through ${gap.confirmedThrough}`,
    );
    messages.push(
      `Schedules published only up to: ${parts.join("; ")}. ` +
        "Later dates are unpublished, not empty.",
    );
  }

  if (!messages.length) {
    elements.banner.hidden = true;
    elements.banner.classList.remove("urgent");
    return;
  }
  elements.banner.replaceChildren();
  for (const message of messages) {
    const line = document.createElement("p");
    line.textContent = message;
    elements.banner.append(line);
  }
  // A stale or partial feed is a correctness problem, not an FYI.
  elements.banner.classList.toggle(
    "urgent",
    isStale(fetchedAt, now, STALE_AFTER_DAYS) || Boolean(calendar.partial_build),
  );
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

  elements.impact.value = prefs.viewMinImpact;
  buildFormatters(prefs.timeZone);
  renderStatus(fetchedAt, lastError);
  renderChips();
  // A refresh or filter change can remove whatever the detail view was
  // showing, so always come back to the list.
  showList();
  elements.events.replaceChildren();
  elements.more.hidden = true;

  if (!calendar?.events?.length) {
    elements.empty.textContent =
      "No calendar cached yet. Press ↻ to fetch the feed.";
    elements.empty.hidden = false;
    elements.banner.hidden = true;
    return;
  }

  const now = Date.now();
  renderBanner(calendar, fetchedAt, now);
  renderHours(calendar);

  const query = {
    now,
    minImpact: prefs.viewMinImpact,
    hiddenTypes: prefs.hiddenTypes,
    horizonMs: VIEW_HORIZON_MS,
    graceMs: IN_PROGRESS_GRACE_MS,
    types: activeGroups.size ? [...activeGroups] : null,
  };
  const matching = upcomingEvents(calendar.events, query);
  const events = matching.slice(0, LIST_LIMIT);

  if (!events.length) {
    elements.empty.textContent = activeGroups.size
      ? "Nothing upcoming for these filters."
      : "Nothing upcoming at this impact level.";
    elements.empty.hidden = false;
    return;
  }
  elements.empty.hidden = true;

  const live = events.filter((event) => isInProgress(event, now, IN_PROGRESS_GRACE_MS));
  const ahead = events.filter((event) => !isInProgress(event, now, IN_PROGRESS_GRACE_MS));

  if (live.length) {
    appendGroup("Happening now", live, now, "live");
  }
  for (const group of groupByDay(ahead, activeTimeZone, now)) {
    appendGroup(group.label, group.events, now);
  }

  if (matching.length > events.length) {
    elements.more.textContent = `${matching.length - events.length} more events not shown — narrow the filters to see them.`;
    elements.more.hidden = false;
  }
}

function appendGroup(label, events, now, extraClass = "") {
  const heading = document.createElement("li");
  heading.className = `day-heading ${extraClass}`.trim();
  heading.textContent = label;
  elements.events.append(heading);
  elements.events.append(...events.map((event) => renderEvent(event, now)));
}

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

  const move = typicalMoveDetail(event);
  if (move) {
    elements.moveHeadline.textContent = move.headline;
    elements.moveHeadline.classList.toggle("notable", move.notable);
    appendPairs(elements.moveRows, move.rows);
    elements.moveWindow.textContent = move.window;
    elements.detailMove.hidden = false;
  } else {
    elements.detailMove.hidden = true;
  }

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
  elements.listView.hidden = activeTab !== "events";
}

function renderHours(calendar) {
  const hours = calendar?.market_hours;
  const equities = hours?.equities ?? {};
  const marketCal = marketCalendar(calendar?.events ?? []);
  const status = sessionStatus(Date.now(), marketCal, hours);

  elements.session.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `dot ${status.state}`;
  const label = document.createElement("strong");
  label.textContent = status.label;
  const detail = document.createElement("span");
  detail.className = "session-detail";
  detail.textContent = status.detail;
  elements.session.append(dot, label, detail);
  elements.session.className = `session ${status.state}`;

  // Times are stated in ET because that is the zone the exchange rules are
  // written in; the events list is what converts to the viewer's zone.
  const closeLabel = status.isEarlyClose
    ? `${formatMinutes(status.closeMinutes)} (early close today)`
    : equities.regular_close;
  appendPairs(elements.hoursRows, [
    { label: "Pre-market", value: `${equities.premarket_open}–${equities.regular_open} ET` },
    { label: "Regular", value: `${equities.regular_open}–${closeLabel} ET` },
    { label: "After hours", value: `${equities.regular_close}–${equities.afterhours_close} ET` },
  ]);

  elements.closures.replaceChildren();
  const closures = upcomingClosures(calendar?.events ?? [], Date.now());
  if (!closures.length) {
    const empty = document.createElement("li");
    empty.className = "closure-empty";
    empty.textContent = "No closures in the published window.";
    elements.closures.append(empty);
  }
  for (const event of closures) {
    const item = document.createElement("li");
    item.className = "closure";

    const when = document.createElement("span");
    when.className = "closure-date";
    when.textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC",
      weekday: "short", month: "short", day: "numeric",
    }).format(new Date(`${event.date_et}T12:00:00Z`));

    const what = document.createElement("span");
    what.className = "closure-name";
    what.textContent = event.holiday_name ?? event.title;

    const kind = document.createElement("span");
    kind.className =
      event.event_type === "market_early_close" ? "closure-kind early" : "closure-kind";
    kind.textContent =
      event.event_type === "market_early_close" ? "1:00pm close" : "closed";

    item.append(when, what, kind);
    elements.closures.append(item);
  }

  elements.futuresNote.textContent = hours?.futures?.note ?? "";
}

function setTab(tab) {
  activeTab = tab;
  elements.tabEvents.classList.toggle("on", tab === "events");
  elements.tabHours.classList.toggle("on", tab === "hours");
  elements.tabEvents.setAttribute("aria-selected", String(tab === "events"));
  elements.tabHours.setAttribute("aria-selected", String(tab === "hours"));
  elements.hoursView.hidden = tab !== "hours";
  elements.detailView.hidden = true;
  elements.listView.hidden = tab !== "events";
}

/** Arrow keys move between event titles without leaving the keyboard. */
function moveFocus(direction) {
  const titles = [...elements.events.querySelectorAll("button.title")];
  if (!titles.length) return;
  const index = titles.indexOf(document.activeElement);
  const next = index === -1
    ? 0
    : Math.min(titles.length - 1, Math.max(0, index + direction));
  titles[next].focus();
}

elements.tabEvents.addEventListener("click", () => setTab("events"));
elements.tabHours.addEventListener("click", () => setTab("hours"));

elements.back.addEventListener("click", showList);

document.addEventListener("keydown", (domEvent) => {
  if (domEvent.key === "Escape" && !elements.detailView.hidden) {
    showList();
    return;
  }
  if (!elements.detailView.hidden) return;
  if (domEvent.key === "ArrowDown") {
    domEvent.preventDefault();
    moveFocus(1);
  } else if (domEvent.key === "ArrowUp") {
    domEvent.preventDefault();
    moveFocus(-1);
  }
});

elements.options.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// View-only: this deliberately does not touch the notification threshold or
// reschedule anything. Changing what you are looking at must not change what
// interrupts you.
elements.impact.addEventListener("change", async (domEvent) => {
  await setPrefs({ viewMinImpact: domEvent.target.value });
  await render();
});

elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  elements.status.textContent = "Refreshing…";
  await chrome.runtime.sendMessage({ type: "refresh" });
  await render();
  elements.refresh.disabled = false;
});

render();
