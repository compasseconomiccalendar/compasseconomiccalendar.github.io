/**
 * Popup: the next market-moving event with a live countdown, filter chips,
 * then a day-grouped agenda. Market hours and event detail open as panels.
 *
 * Rendering is done with explicit DOM calls rather than innerHTML so no feed
 * string is ever parsed as markup.
 */

import { IN_PROGRESS_GRACE_MS, STALE_AFTER_DAYS } from "../src/config.js";
import { countdownParts, pickHero, relativeShort } from "../src/countdown.js";
import {
  detailRows,
  formatTimes,
  typeLabel,
  typicalMoveBadge,
  typicalMoveDetail,
} from "../src/details.js";
import {
  TYPE_GROUPS,
  groupByDay,
  isInProgress,
  isStale,
  resolveHour12,
  resolveTimeZone,
  upcomingEvents,
} from "../src/filters.js";
import {
  DEFAULT_HOURS,
  etRangeInZone,
  etTimeInZone,
  futuresSessionStatus,
  marketCalendar,
  sessionStatus,
  upcomingClosures,
} from "../src/sessions.js";
import { getCached, getPrefs, setPrefs } from "../src/store.js";

const LIST_LIMIT = 60;
const IMPACT_LABEL = { high: "High impact", medium: "Medium impact", low: "Low impact" };

const $ = (id) => document.getElementById(id);
const elements = {
  events: $("events"),
  empty: $("empty"),
  more: $("more"),
  banner: $("banner"),
  chips: $("chips"),
  status: $("status"),
  refresh: $("refresh"),
  options: $("options"),
  market: $("market"),
  marketDot: $("market-dot"),
  marketLabel: $("market-label"),
  listView: $("list-view"),
  hoursView: $("hours-view"),
  hoursBack: $("hours-back"),
  detailView: $("detail-view"),
  back: $("back"),
  next: $("next"),
  nextEyebrow: $("next-eyebrow"),
  nextTitle: $("next-title"),
  nextCountdown: $("next-countdown"),
  nextWhen: $("next-when"),
  nextMove: $("next-move"),
  detailEyebrow: $("detail-eyebrow"),
  detailTitle: $("detail-title"),
  detailCountdown: $("detail-countdown"),
  detailTimes: $("detail-times"),
  detailNote: $("detail-note"),
  detailRows: $("detail-rows"),
  detailSource: $("detail-source"),
  detailPrimary: $("detail-primary"),
  detailAttribution: $("detail-attribution"),
  detailMove: $("detail-move"),
  moveRows: $("move-rows"),
  moveWindow: $("move-window"),
  session: $("session"),
  hoursRows: $("hours-rows"),
  closures: $("closures"),
  futuresNote: $("futures-note"),
  futuresSession: $("futures-session"),
  futuresRows: $("futures-rows"),
};

// State rebuilt on every render from prefs and the cached feed.
let activeTimeZone;
let activeHour12;
let activeGroups = new Set();
let timeFormat;
let heroEvent = null;
let detailEvent = null;
// Agenda rows whose relative label is refreshed by the ticker.
let liveRows = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildFormatters(prefs) {
  activeTimeZone = resolveTimeZone(prefs.timeZone);
  activeHour12 = resolveHour12(prefs.timeFormat);
  timeFormat = new Intl.DateTimeFormat(undefined, {
    timeZone: activeTimeZone,
    hour12: activeHour12,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Dark unless explicitly set to light; the OS preference is not consulted. */
function applyTheme(theme) {
  const root = document.documentElement;
  if (root) root.dataset.theme = theme === "light" ? "light" : "dark";
}

/** Render "11h 23m" into `target` with the units in their own spans. */
function paintCountdown(target, msUntil, prefix = "") {
  const parts = countdownParts(msUntil);
  target.replaceChildren();
  if (!parts) return;
  if (prefix) target.append(el("span", "unit", prefix));
  for (const [value, unit] of parts) {
    target.append(String(value), el("span", "unit", unit));
  }
}

// ---------- Views ----------

let view = "list";

function showView(name) {
  view = name;
  elements.listView.hidden = name !== "list";
  elements.hoursView.hidden = name !== "hours";
  elements.detailView.hidden = name !== "detail";
  if (name !== "detail") detailEvent = null;
  window.scrollTo(0, 0);
}

// ---------- Hero ----------

function renderHero(event) {
  heroEvent = event;
  if (!event) {
    elements.next.hidden = true;
    return;
  }
  const impact = event.market_impact ?? "low";
  elements.next.className = `hero impact-${impact}`;
  elements.nextEyebrow.textContent =
    impact === "high" ? "Next · High impact" : `Next · ${typeLabel(event.event_type)}`;
  elements.nextTitle.textContent = event.title;
  elements.nextWhen.textContent = new Intl.DateTimeFormat(undefined, {
    timeZone: activeTimeZone,
    hour12: activeHour12,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(event.start_utc));

  const move = typicalMoveBadge(event);
  elements.nextMove.textContent = move ? `Typical move ${move}` : "";
  elements.nextMove.hidden = !move;

  paintCountdown(elements.nextCountdown, Date.parse(event.start_utc) - Date.now());
  elements.next.hidden = false;
}

// ---------- Chips ----------

function renderChips() {
  elements.chips.replaceChildren();

  const all = el("button", "chip", "All");
  all.type = "button";
  all.value = "";
  all.setAttribute("aria-pressed", String(activeGroups.size === 0));
  all.addEventListener("click", () => setGroups([]));
  elements.chips.append(all);

  for (const group of TYPE_GROUPS) {
    const chip = el("button", "chip", group.label);
    chip.type = "button";
    chip.value = group.id;
    chip.setAttribute("aria-pressed", String(activeGroups.has(group.id)));
    chip.addEventListener("click", () => {
      const next = new Set(activeGroups);
      if (next.has(group.id)) next.delete(group.id);
      else next.add(group.id);
      // Every group ticked is the same as none: collapse back to "All".
      return setGroups(next.size === TYPE_GROUPS.length ? [] : [...next]);
    });
    elements.chips.append(chip);
  }
}

async function setGroups(groups) {
  await setPrefs({ selectedGroups: groups });
  await render();
}

// ---------- Agenda ----------

function renderRow(event, now) {
  const impact = event.market_impact ?? "low";
  const item = el("li", `event impact-${impact}`);
  const inProgress = isInProgress(event, now, IN_PROGRESS_GRACE_MS);
  if (inProgress) item.classList.add("in-progress");

  const row = el("button", "row");
  row.type = "button";
  row.addEventListener("click", () => showDetail(event));

  const time = event.all_day
    ? el("span", "row-time allday", "All day")
    : el("span", "row-time", timeFormat.format(new Date(event.start_utc)));

  const dot = el("span", `impact ${impact}`);
  dot.title = IMPACT_LABEL[impact] ?? "";

  const title = el("span", "row-title", event.title);
  title.title = event.title;

  const side = el("span", "row-side");
  const move = typicalMoveBadge(event);
  if (move) side.append(el("span", "tag move", move.replace(" normal", "")));
  if (event.approximate) side.append(el("span", "tag est", "est."));
  if (!event.all_day) {
    const rel = el("span", "rel", inProgress ? "now" : relativeShort(Date.parse(event.start_utc) - now));
    side.append(rel);
    if (!inProgress) liveRows.push({ node: rel, event });
  }

  row.append(time, dot, title, side);
  item.append(row);
  return item;
}

function appendDay(label, dateText, events, now, extraClass = "") {
  const heading = el("li", `day ${extraClass}`.trim());
  heading.append(el("span", "", label));
  if (dateText) heading.append(el("span", "day-date", dateText));
  elements.events.append(heading);
  elements.events.append(...events.map((event) => renderRow(event, now)));
}

function dayDate(event) {
  if (event.all_day && event.date_et) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
    }).format(new Date(`${event.date_et}T12:00:00Z`));
  }
  return new Intl.DateTimeFormat(undefined, {
    timeZone: activeTimeZone, weekday: "short", month: "short", day: "numeric",
  }).format(new Date(event.start_utc));
}

// ---------- Banner and status ----------

function renderBanner(calendar, fetchedAt, now) {
  const messages = [];
  const stale = isStale(fetchedAt, now, STALE_AFTER_DAYS);
  if (stale) {
    messages.push(
      `This calendar has not refreshed in over ${STALE_AFTER_DAYS} days. ` +
        "Times may have changed — refresh and verify before trading.",
    );
  }
  if (calendar.partial_build) {
    const failed = (calendar.failed_sources ?? []).length;
    messages.push(
      `The feed was published with ${failed || "some"} source(s) failing, so ` +
        "events may be missing.",
    );
  }

  if (!messages.length) {
    elements.banner.hidden = true;
    elements.banner.classList.remove("urgent");
    return;
  }
  elements.banner.replaceChildren(...messages.map((text) => el("p", "", text)));
  // A stale or partial feed is a correctness problem, not an FYI.
  elements.banner.classList.toggle("urgent", stale || Boolean(calendar.partial_build));
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
    ? `Updated ${new Date(fetchedAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })}`
    : "No data cached yet.";
}

// ---------- Render ----------

async function render() {
  const [{ calendar, fetchedAt, lastError }, prefs] = await Promise.all([
    getCached(),
    getPrefs(),
  ]);

  activeGroups = new Set(prefs.selectedGroups ?? []);
  const horizonMs = (prefs.viewHorizonDays ?? 90) * 24 * 3600 * 1000;
  applyTheme(prefs.theme);
  buildFormatters(prefs);
  renderStatus(fetchedAt, lastError);
  renderChips();
  renderHours(calendar);
  // A refresh or filter change can remove whatever the detail view was
  // showing, so always come back to the list from there.
  if (view === "detail") showView("list");

  elements.events.replaceChildren();
  elements.more.hidden = true;
  liveRows = [];

  if (!calendar?.events?.length) {
    renderHero(null);
    elements.empty.textContent = "No calendar cached yet. Press refresh to fetch the feed.";
    elements.empty.hidden = false;
    elements.banner.hidden = true;
    return;
  }

  const now = Date.now();
  renderBanner(calendar, fetchedAt, now);

  const matching = upcomingEvents(calendar.events, {
    now,
    hiddenTypes: prefs.hiddenTypes,
    horizonMs,
    graceMs: IN_PROGRESS_GRACE_MS,
    types: activeGroups.size ? [...activeGroups] : null,
  });
  const events = matching.slice(0, LIST_LIMIT);

  renderHero(pickHero(matching, now, IN_PROGRESS_GRACE_MS));

  if (!events.length) {
    elements.empty.textContent = activeGroups.size
      ? "Nothing upcoming for the selected types."
      : "Nothing upcoming.";
    elements.empty.hidden = false;
    return;
  }
  elements.empty.hidden = true;

  const live = events.filter((event) => isInProgress(event, now, IN_PROGRESS_GRACE_MS));
  const ahead = events.filter((event) => !isInProgress(event, now, IN_PROGRESS_GRACE_MS));

  if (live.length) appendDay("Happening now", "", live, now, "live");
  for (const group of groupByDay(ahead, activeTimeZone, now)) {
    const relative = group.label === "Today" || group.label === "Tomorrow";
    appendDay(group.label, relative ? dayDate(group.events[0]) : "", group.events, now);
  }

  if (matching.length > events.length) {
    elements.more.textContent = `${matching.length - events.length} more not shown — narrow the filters or the time frame in settings.`;
    elements.more.hidden = false;
  }
}

// ---------- Detail ----------

function appendPairs(target, pairs) {
  target.replaceChildren();
  for (const { label, value } of pairs) {
    target.append(el("dt", "", label), el("dd", "", value));
  }
}

function showDetail(event) {
  detailEvent = event;
  const impact = event.market_impact ?? "low";
  elements.detailEyebrow.className = `eyebrow impact-${impact}`;
  elements.detailEyebrow.textContent =
    `${IMPACT_LABEL[impact] ?? ""} · ${typeLabel(event.event_type)}`;
  elements.detailTitle.textContent = event.title;
  elements.detailNote.textContent = event.note ?? "";
  paintDetailCountdown();

  appendPairs(elements.detailTimes, formatTimes(event, activeTimeZone, activeHour12));
  appendPairs(elements.detailRows, detailRows(event));

  const move = typicalMoveDetail(event);
  if (move) {
    appendPairs(elements.moveRows, move.rows);
    elements.moveWindow.textContent = move.window;
    elements.detailMove.hidden = false;
  } else {
    elements.detailMove.hidden = true;
  }

  elements.detailSource.href = event.source_url;
  elements.detailSource.textContent = "Verify at official source";
  if (event.primary_source_url) {
    elements.detailPrimary.href = event.primary_source_url;
    elements.detailPrimary.textContent = "Primary source";
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

  showView("detail");
  detailEvent = event;
  elements.back.focus();
}

function paintDetailCountdown() {
  const event = detailEvent;
  if (!event || event.all_day) {
    elements.detailCountdown.replaceChildren();
    return;
  }
  const msUntil = Date.parse(event.start_utc) - Date.now();
  if (msUntil <= 0) {
    elements.detailCountdown.textContent = "Released";
    return;
  }
  paintCountdown(elements.detailCountdown, msUntil, "in ");
}

// ---------- Hours ----------

/** A session's next boundary in the viewer's zone. */
function localiseDetail(status, refDate, timeZone) {
  if (status.haltRange) {
    const shown = etRangeInZone(
      refDate, status.haltRange.from, status.haltRange.to, timeZone, activeHour12,
    );
    return `Halts ${shown}`;
  }
  if (status.nextChange) {
    const { verb, hhmm, suffix } = status.nextChange;
    const shown = etTimeInZone(refDate, hhmm, timeZone, activeHour12).text;
    return `${verb} ${shown}${suffix ? ` ${suffix}` : ""}`;
  }
  return status.detail;
}

function sessionLine(target, status, detailText) {
  target.replaceChildren(
    el("span", `dot ${status.state}`),
    el("strong", "", status.label),
    el("span", "session-detail", detailText),
  );
}

function renderHours(calendar) {
  // A feed cached before market_hours existed must still render.
  const hours = {
    ...DEFAULT_HOURS,
    ...(calendar?.market_hours ?? {}),
    equities: { ...DEFAULT_HOURS.equities, ...(calendar?.market_hours?.equities ?? {}) },
  };
  const equities = hours.equities;
  const marketCal = marketCalendar(calendar?.events ?? []);
  const status = sessionStatus(Date.now(), marketCal, hours);

  // Session state is decided in Eastern, but every time shown is converted to
  // the viewer's zone, resolved against today's date since the offset from ET
  // is not fixed.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const local = activeTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = (from, to) => etRangeInZone(today, from, to, local, activeHour12);

  // Header pill: the equity session at a glance.
  elements.marketDot.className = `dot ${status.state}`;
  elements.marketLabel.textContent = `NYSE ${status.label.toLowerCase()}`;

  sessionLine(
    elements.session,
    status,
    localiseDetail(status, today, local) +
      (status.earlyCloseName ? ` · ${status.earlyCloseName}` : ""),
  );

  const regularClose = status.isEarlyClose ? equities.early_close : equities.regular_close;
  appendPairs(elements.hoursRows, [
    { label: "Pre-market", value: range(equities.premarket_open, equities.regular_open) },
    {
      label: "Regular",
      value:
        range(equities.regular_open, regularClose) +
        (status.isEarlyClose ? " · early close today" : ""),
    },
    { label: "After hours", value: range(equities.regular_close, equities.afterhours_close) },
  ]);

  // Futures: /ES and /NQ run their own, nearly round-the-clock week.
  const futures = hours?.futures ?? {};
  const futuresStatus = futuresSessionStatus(Date.now(), marketCal, hours);
  sessionLine(elements.futuresSession, futuresStatus, localiseDetail(futuresStatus, today, local));

  const weekOpen = etTimeInZone(today, futures.week_open ?? "18:00", local, activeHour12);
  const weekClose = etTimeInZone(today, futures.week_close ?? "17:00", local, activeHour12);
  appendPairs(elements.futuresRows, [
    { label: "Week", value: `Sun ${weekOpen.text} – Fri ${weekClose.text}` },
    {
      label: "Daily halt",
      value: range(futures.daily_halt_start ?? "17:00", futures.daily_halt_end ?? "18:00") +
        ", Mon–Thu",
    },
    { label: "Symbols", value: "/ES · /NQ · /MES · /MNQ" },
  ]);

  elements.closures.replaceChildren();
  const closures = upcomingClosures(calendar?.events ?? [], Date.now());
  if (!closures.length) {
    elements.closures.append(el("li", "closure-empty", "No closures in the published window."));
  }
  for (const event of closures) {
    // All-day closures are anchored at noon UTC so the label cannot slip a
    // day in western zones; timed half days use their real instant.
    const when = new Intl.DateTimeFormat(undefined, {
      timeZone: event.all_day ? "UTC" : local,
      weekday: "short", month: "short", day: "numeric",
    }).format(event.all_day ? new Date(`${event.date_et}T12:00:00Z`) : new Date(event.start_utc));

    const early = event.event_type === "market_early_close";
    const kind = early
      ? `${new Intl.DateTimeFormat(undefined, {
          timeZone: local, hour12: activeHour12, hour: "numeric", minute: "2-digit",
        }).format(new Date(event.start_utc))} close`
      : "closed";

    const item = el("li", "closure");
    item.append(
      el("span", "closure-date", when),
      el("span", "closure-name", event.holiday_name ?? event.title),
      el("span", early ? "closure-kind early" : "closure-kind", kind),
    );
    elements.closures.append(item);
  }

  elements.futuresNote.textContent =
    "Futures holiday sessions are usually shortened rather than closed — " +
    "verify against CME's calendar before trading a holiday.";
}

// ---------- Ticker ----------

let lastMinute = -1;

/** Once a second: the hero and detail countdowns; once a minute: row labels. */
function tick() {
  const now = Date.now();
  if (heroEvent) {
    const msUntil = Date.parse(heroEvent.start_utc) - now;
    // The hero event just started: re-render so the next one takes over.
    if (msUntil <= 0) {
      render();
      return;
    }
    paintCountdown(elements.nextCountdown, msUntil);
  }
  if (detailEvent) paintDetailCountdown();

  const minute = Math.floor(now / 60_000);
  if (minute !== lastMinute) {
    lastMinute = minute;
    for (const { node, event } of liveRows) {
      node.textContent = relativeShort(Date.parse(event.start_utc) - now);
    }
  }
}

const ticker = setInterval(tick, 1000);
// Node keeps a process alive for an active interval; the popup's tests import
// this module, so let the timer go when nothing else is running.
ticker?.unref?.();

// ---------- Events ----------

/** Arrow keys move between agenda rows without leaving the keyboard. */
function moveFocus(direction) {
  const rows = [...elements.events.querySelectorAll("button.row")];
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement);
  const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + direction));
  rows[next].focus();
}

elements.next.addEventListener("click", () => {
  if (heroEvent) showDetail(heroEvent);
});
elements.market.addEventListener("click", () => showView("hours"));
elements.hoursBack.addEventListener("click", () => showView("list"));
elements.back.addEventListener("click", () => showView("list"));

document.addEventListener("keydown", (domEvent) => {
  if (domEvent.key === "Escape" && view !== "list") {
    domEvent.preventDefault();
    showView("list");
    return;
  }
  if (view !== "list") return;
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
elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  elements.refresh.classList.add("spinning");
  elements.status.textContent = "Refreshing…";
  await chrome.runtime.sendMessage({ type: "refresh" });
  await render();
  elements.refresh.classList.remove("spinning");
  elements.refresh.disabled = false;
});

render();
