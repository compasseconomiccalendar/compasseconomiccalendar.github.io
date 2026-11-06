/**
 * Smoke test: load popup.js against a stub DOM and render a real feed shape.
 *
 * The pure modules are well covered, but popup.js touches `document` and
 * `chrome.*`, so nothing exercised it — and a reference error there empties
 * the whole popup rather than degrading one section. This caught exactly that:
 * `today` and `local` were used a few lines above their `const` declarations,
 * which is a temporal dead zone error at runtime and invisible to a linter's
 * import check.
 *
 * The stub is deliberately thin. It is not a DOM implementation; it exists to
 * let the module run end to end and surface throws.
 */

import assert from "node:assert/strict";
import test from "node:test";

function makeElement(id = "") {
  const element = {
    id,
    children: [],
    className: "",
    textContent: "",
    hidden: false,
    value: "",
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); },
      toggle(name, force) {
        const on = force ?? !this._set.has(name);
        if (on) this._set.add(name);
        else this._set.delete(name);
        return on;
      },
    },
    listeners: {},
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren(...nodes) { element.children = [...nodes]; },
    appendChild(node) { element.children.push(node); return node; },
    // Handlers are recorded so tests can drive the UI, not just render it.
    addEventListener(type, handler) { element.listeners[type] = handler; },
    removeEventListener(type) { delete element.listeners[type]; },
    attributes: {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    focus() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return element;
}

// Dates are relative: the popup only renders a 90-day horizon, so a fixture
// pinned to a far-future year renders nothing and proves nothing.
const HOUR = 3600 * 1000;
const iso = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayOf = (offsetMs) => iso(offsetMs).slice(0, 10);

const CALENDAR = {
  schema_version: "1.0.0",
  disclaimer: "Not investment advice.",
  counts: { total: 3, by_event_type: {} },
  generated_at_utc: "2026-07-29T13:00:00Z",
  coverage: {
    families: {
      fomc: { horizon: "reported", event_count: 31, confirmed_through: "2027-07-28", complete_to_window_end: true },
      treasury_auctions: { horizon: "reported", event_count: 10, confirmed_through: "2026-08-04", complete_to_window_end: false },
      futures: { horizon: "computed", event_count: 25, confirmed_through: "2027-08-20", complete_to_window_end: true },
    },
    warnings: ["treasury_auctions: upstream has published dates only through 2026-08-04."],
  },
  market_hours: {
    timezone: "America/New_York",
    equities: {
      premarket_open: "04:00", regular_open: "09:30",
      regular_close: "16:00", afterhours_close: "20:00", early_close: "13:00",
    },
    futures: {
      week_open: "18:00", week_close: "17:00",
      daily_halt_start: "17:00", daily_halt_end: "18:00",
    },
  },
  events: [
    {
      id: "fomc-statement-soon", event_type: "fomc_statement",
      title: "FOMC Statement", start_utc: iso(6 * HOUR),
      end_utc: iso(6.5 * HOUR), all_day: false, date_et: dayOf(6 * HOUR),
      time_et: "14:00", market_impact: "high", source: "federalreserve.gov",
      source_url: "https://example.gov", note: "note",
      typical_move: {
        ratio: 1.49, notable: true, move_notable: true, window: "recent",
        sample_start: "2023-07-29", summary: "Moves about 1.5x a normal day.",
        spx: { median_abs_pct: 0.8, ratio: 1.49, n: 23 },
        vol_crush: { median_pct: -3.52, excess_pct: -2.87, n: 44 },
      },
    },
    {
      id: "market-holiday-soon", event_type: "market_holiday",
      title: "Market Closed — Thanksgiving Day", start_utc: iso(30 * 24 * HOUR),
      end_utc: null, all_day: true, date_et: dayOf(30 * 24 * HOUR), time_et: null,
      market_impact: "low", source: "computed", source_url: "https://example.com",
      note: "closed", holiday_name: "Thanksgiving Day",
    },
    {
      id: "market-early-close-soon", event_type: "market_early_close",
      title: "Early Close — Day after Thanksgiving",
      start_utc: iso(31 * 24 * HOUR), end_utc: iso(31 * 24 * HOUR + 1800000),
      all_day: false, date_et: dayOf(31 * 24 * HOUR), time_et: "13:00",
      market_impact: "low", source: "computed", source_url: "https://example.com",
      note: "half day", holiday_name: "Day after Thanksgiving",
    },
  ],
};

function installStubs(calendar = CALENDAR) {
  const registry = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    createElement: () => makeElement(),
    addEventListener() {},
    documentElement: makeElement("html"),
  };
  globalThis.window = { scrollTo() {} };
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return { calendar, fetchedAt: Date.now(), lastError: null };
        },
        async set() {},
      },
      sync: { async get() { return {}; }, async set() {} },
    },
    runtime: { async sendMessage() { return { ok: true }; }, openOptionsPage() {} },
  };
  return registry;
}

test("the popup renders a full feed without throwing", async () => {
  const registry = installStubs();
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);

  // Importing runs the module, which calls render() immediately.
  await import("../popup/popup.js");
  // Let the async render settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onRejection);

  assert.deepEqual(
    errors.map((error) => String(error?.message ?? error)),
    [],
    "render() threw",
  );

  // The event list is populated, which is what an early throw would prevent.
  const events = registry.get("events");
  assert.ok(events, "#events was never queried");
  assert.ok(events.children.length > 0, "no events rendered");

  // The hero counts down to the next high-impact timed event.
  assert.equal(registry.get("next").hidden, false, "hero hidden");
  assert.equal(registry.get("next-title").textContent, "FOMC Statement");
  assert.ok(registry.get("next-countdown").children.length > 0, "no countdown");
  assert.match(registry.get("next-eyebrow").textContent, /High impact/);

  // Filter chips: "All" first, then one per group, with only "All" pressed.
  const chips = registry.get("chips").children;
  assert.deepEqual(
    chips.map((chip) => chip.value),
    ["", "fomc", "data", "treasury", "futures", "market"],
  );
  assert.deepEqual(
    chips.map((chip) => chip.getAttribute("aria-pressed")),
    ["true", "false", "false", "false", "false", "false"],
  );

  // The header pill carries the equity session.
  assert.match(registry.get("market-label").textContent, /^NYSE /);

  // The hours panel rendered too, including its session line.
  assert.ok(registry.get("session").children.length > 0, "no equity session");
  assert.ok(registry.get("futures-session").children.length > 0, "no futures session");
  assert.ok(registry.get("closures").children.length > 0, "no closures");
  assert.ok(registry.get("hours-rows").children.length > 0, "no hours rows");
});

test("a feed cached before market_hours existed still renders", async () => {
  // The extension serves from chrome.storage.local first, so after an upgrade
  // the popup renders an *older* feed shape before the refresh lands. Any new
  // top-level field therefore has to be optional in the consumer. Missing
  // market_hours previously produced a NaN wall-clock time, which reached
  // Intl.formatToParts as an Invalid Date and threw RangeError, blanking the
  // entire popup rather than just the hours tab.
  const legacy = { ...CALENDAR };
  delete legacy.market_hours;

  const registry = installStubs(legacy);
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);

  const module = await import(`../popup/popup.js?legacy=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onRejection);

  assert.deepEqual(
    errors.map((error) => String(error?.message ?? error)),
    [],
    "render() threw on a legacy feed",
  );
  assert.ok(module);
  // The events list is the part that must survive; it is unrelated to hours.
  assert.ok(registry.get("events").children.length > 0, "no events rendered");
  // Hours still renders, falling back to the built-in session defaults.
  assert.ok(registry.get("hours-rows").children.length > 0, "no hours rows");
});

/**
 * Degraded cache states.
 *
 * Everything the popup reads comes from chrome.storage, which can hold data
 * written by an older version, a failed refresh, or nothing at all. A throw in
 * any of these blanks the whole popup, so each shape is asserted to render.
 */
const DEGRADED = {
  "no calendar cached at all": {
    local: { calendar: null, fetchedAt: null, lastError: null }, sync: {},
  },
  "calendar with no events array": {
    local: { calendar: { disclaimer: "d" }, fetchedAt: Date.now(), lastError: null },
    sync: {},
  },
  "no coverage block": {
    local: {
      calendar: { disclaimer: "d", events: [], counts: { by_event_type: {} } },
      fetchedAt: Date.now(), lastError: null,
    },
    sync: {},
  },
  "prefs still on the pre-split schema": {
    local: { calendar: CALENDAR, fetchedAt: Date.now(), lastError: null },
    sync: { prefs: { minImpact: "low" } },
  },
  "partial build with a failed refresh": {
    local: {
      calendar: { ...CALENDAR, partial_build: true, failed_sources: ["FRED"] },
      fetchedAt: Date.now(), lastError: { message: "boom", at: Date.now() },
    },
    sync: {},
  },
  "cache older than the staleness threshold": {
    local: {
      calendar: CALENDAR,
      fetchedAt: Date.now() - 20 * 24 * 3600 * 1000,
      lastError: null,
    },
    sync: {},
  },
};

for (const [name, stored] of Object.entries(DEGRADED)) {
  test(`popup renders with ${name}`, async () => {
    const registry = new Map();
    globalThis.document = {
      getElementById(id) {
        if (!registry.has(id)) registry.set(id, makeElement(id));
        return registry.get(id);
      },
      createElement: () => makeElement(),
      addEventListener() {},
    };
    globalThis.window = { scrollTo() {} };
    globalThis.chrome = {
      storage: {
        local: { async get() { return stored.local; }, async set() {} },
        sync: { async get() { return stored.sync; }, async set() {} },
      },
      runtime: { async sendMessage() { return { ok: true }; }, openOptionsPage() {} },
    };

    const errors = [];
    const onRejection = (error) => errors.push(error);
    process.on("unhandledRejection", onRejection);
    await import(`../popup/popup.js?degraded=${encodeURIComponent(name)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.off("unhandledRejection", onRejection);

    assert.deepEqual(errors.map((error) => String(error?.message ?? error)), [], name);
  });
}

function installInteractive(initialPrefs = {}) {
  const registry = new Map();
  const state = { prefs: initialPrefs, reminders: [], sent: [] };
  const root = makeElement("html");
  globalThis.document = {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    createElement: () => makeElement(),
    addEventListener() {},
    documentElement: root,
  };
  globalThis.window = { scrollTo() {} };
  globalThis.chrome = {
    storage: {
      local: {
        async get() { return { calendar: CALENDAR, fetchedAt: Date.now(), lastError: null }; },
        async set() {},
      },
      sync: {
        async get(key) {
          return key === "reminders" ? { reminders: state.reminders } : { prefs: state.prefs };
        },
        async set(items) {
          if ("prefs" in items) state.prefs = items.prefs;
          if ("reminders" in items) state.reminders = items.reminders;
        },
      },
    },
    runtime: {
      async sendMessage(message) { state.sent.push(message); return { ok: true }; },
      openOptionsPage() {},
    },
  };
  return { registry, state, root };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("filter chips toggle groups, persist them, and collapse back to All", async () => {
  const { registry, state } = installInteractive();
  await import(`../popup/popup.js?filter=${Date.now()}`);
  await settle(40);

  // Chips are rebuilt on every render, so look them up fresh each time.
  const chip = (value) => registry.get("chips").children.find((c) => c.value === value);
  const press = async (value) => {
    await chip(value).listeners.click();
    await settle();
  };

  await press("fomc");
  assert.deepEqual(state.prefs.selectedGroups, ["fomc"]);
  assert.equal(chip("fomc").getAttribute("aria-pressed"), "true");
  assert.equal(chip("").getAttribute("aria-pressed"), "false");

  await press("data");
  assert.deepEqual(state.prefs.selectedGroups, ["fomc", "data"]);

  // Pressing a selected chip again removes it.
  await press("fomc");
  assert.deepEqual(state.prefs.selectedGroups, ["data"]);

  // "All" clears the selection.
  await press("");
  assert.deepEqual(state.prefs.selectedGroups, []);
  assert.equal(chip("").getAttribute("aria-pressed"), "true");

  // Selecting every group is the same as selecting none.
  for (const value of ["fomc", "data", "treasury", "futures"]) await press(value);
  await press("market");
  assert.deepEqual(state.prefs.selectedGroups, []);
});

test("theme and time frame come from settings", async () => {
  const { registry, root } = installInteractive({ theme: "light", viewHorizonDays: 7 });
  await import(`../popup/popup.js?prefs=${Date.now()}`);
  await settle(40);

  assert.equal(root.dataset.theme, "light");
  // A one-week horizon drops the holiday 30 days out: one day heading plus
  // the FOMC row.
  const rows = registry.get("events").children.filter((child) => /event/.test(child.className));
  assert.equal(rows.length, 1);
});

test("dark is the default theme, set explicitly rather than left to the OS", async () => {
  const { root } = installInteractive();
  await import(`../popup/popup.js?dark=${Date.now()}`);
  await settle(40);
  assert.equal(root.dataset.theme, "dark");
});

test("the market pill and hero open their panels, and back returns", async () => {
  const { registry } = installInteractive();
  await import(`../popup/popup.js?panels=${Date.now()}`);
  await settle(40);

  registry.get("market").listeners.click();
  assert.equal(registry.get("hours-view").hidden, false);
  assert.equal(registry.get("list-view").hidden, true);

  registry.get("hours-back").listeners.click();
  assert.equal(registry.get("list-view").hidden, false);
  assert.equal(registry.get("hours-view").hidden, true);

  registry.get("next").listeners.click();
  assert.equal(registry.get("detail-view").hidden, false);
  assert.equal(registry.get("detail-title").textContent, "FOMC Statement");
  assert.equal(registry.get("detail-source").href, "https://example.gov");

  registry.get("back").listeners.click();
  assert.equal(registry.get("detail-view").hidden, true);
  assert.equal(registry.get("list-view").hidden, false);
});

test("the week strip shows five weekdays and dims days with nothing major", async () => {
  const { registry } = installInteractive();
  await import(`../popup/popup.js?glance=${Date.now()}`);
  await settle(40);

  const cells = registry.get("glance").children;
  assert.equal(cells.length, 5);
  // The fixture's only high-impact timed event is 6 hours out, so at most
  // two cells (today, or tomorrow if that crosses midnight) can be enabled.
  assert.ok(cells.filter((cell) => !cell.disabled).length <= 2);
  assert.ok(cells.every((cell) => /: /.test(cell.title)), "cells carry a summary tooltip");
});

test("Remind me toggles a stored reminder and asks for a reschedule", async () => {
  const { registry, state } = installInteractive();
  await import(`../popup/popup.js?remind=${Date.now()}`);
  await settle(40);

  registry.get("next").listeners.click();
  const remind = registry.get("detail-remind");
  assert.equal(remind.hidden, false);
  assert.equal(registry.get("detail-remind-label").textContent, "Remind me");
  assert.match(registry.get("detail-gcal").href, /^https:\/\/calendar\.google\.com\//);

  await remind.listeners.click();
  await settle();
  assert.deepEqual(state.reminders, ["fomc-statement-soon"]);
  assert.equal(registry.get("detail-remind-label").textContent, "Reminder on");
  assert.equal(remind.getAttribute("aria-pressed"), "true");
  assert.ok(state.sent.some((message) => message.type === "reschedule"));
  // Still on the detail view: toggling must not bounce back to the list.
  assert.equal(registry.get("detail-view").hidden, false);

  await remind.listeners.click();
  await settle();
  assert.deepEqual(state.reminders, []);
  assert.equal(registry.get("detail-remind-label").textContent, "Remind me");
});
