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
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren(...nodes) { element.children = [...nodes]; },
    appendChild(node) { element.children.push(node); return node; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
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
  coverage: { families: {}, warnings: [] },
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

  // The hours tab rendered too, including its session line.
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
