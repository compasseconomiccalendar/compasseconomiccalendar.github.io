/**
 * Smoke test for the options page.
 *
 * Same rationale as popup.render.test.js: this file wires pure modules to the
 * DOM and to chrome.*, so nothing else exercises it, and a reference error
 * here leaves the settings page blank with no other symptom.
 */

import assert from "node:assert/strict";
import test from "node:test";

function makeElement(id = "", tag = "div") {
  const element = {
    id,
    tag,
    children: [],
    className: "",
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    type: "",
    dataset: {},
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, force) {
        const on = force ?? !this._set.has(name);
        if (on) this._set.add(name);
        else this._set.delete(name);
        return on;
      },
      contains(name) { return this._set.has(name); },
    },
    listeners: {},
    append(...nodes) { element.children.push(...nodes); },
    replaceChildren(...nodes) { element.children = [...nodes]; },
    addEventListener(type, handler) { element.listeners[type] = handler; },
    attributes: {},
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    focus() {},
    // Descendant search, like the real DOM. A shallow version silently
    // returned nothing here, since the checkboxes sit inside label rows.
    querySelectorAll() {
      const found = [];
      const walk = (node) => {
        for (const child of node.children ?? []) {
          if (child.type === "checkbox") found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
  };
  return element;
}

const CALENDAR = {
  generated_at_utc: "2026-11-01T18:10:47Z",
  coverage: {
    families: {
      fomc: { horizon: "reported", event_count: 28, confirmed_through: "2027-10-27", complete_to_window_end: true },
      ism: { horizon: "computed", event_count: 27, confirmed_through: "2027-12-01", complete_to_window_end: true },
    },
    warnings: [],
  },
  counts: {
    by_event_type: { fomc_statement: 9, macro_release_cpi: 5, market_holiday: 10 },
  },
};

function installStubs({ commands = true, testResponse = { ok: true } } = {}) {
  const registry = new Map();
  const opened = [];
  const sent = [];
  globalThis.document = {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    createElement: (tag) => makeElement("", tag),
    addEventListener() {},
    documentElement: makeElement("html"),
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get() { return { calendar: CALENDAR, fetchedAt: Date.now(), lastError: null }; },
        async set() {},
      },
      sync: { async get() { return {}; }, async set() {} },
    },
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        return message?.type === "test-notification"
          ? testResponse
          : { ok: true, count: 12 };
      },
    },
    tabs: { create(options) { opened.push(options.url); } },
    ...(commands
      ? { commands: { async getAll() { return [{ name: "_execute_action", shortcut: "Alt+Shift+C" }]; } } }
      : {}),
  };
  return { registry, opened, sent };
}

test("the options page initialises without throwing", async () => {
  const { registry, opened } = installStubs();
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);

  await import("../options/options.js");
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onRejection);

  assert.deepEqual(errors.map((error) => String(error?.message ?? error)), []);

  // Timezone list built, with the pinned trading zones present.
  const zones = registry.get("timezone");
  assert.ok(zones.children.length > 5, "timezone list not populated");
  assert.ok(zones.children.some((option) => option.value === "America/Denver"));

  // Event-type checkboxes come from the cached feed's counts, grouped under
  // the popup's filter groups: FOMC, Data and Market here.
  const groups = registry.get("types").children;
  assert.deepEqual(groups.map((group) => group.children[0].textContent), ["FOMC", "Data", "Market"]);
  const labels = groups.flatMap((group) =>
    group.children[1].children.map((row) => row.children[1].textContent));
  assert.deepEqual(labels, ["FOMC statement", "CPI", "Market holiday"]);

  // Notification types are chips like the popup's, seeded from the defaults.
  const notify = registry.get("notify-groups").children;
  assert.equal(notify.length, 5);
  assert.deepEqual(
    notify.map((chip) => chip.getAttribute("aria-pressed")),
    ["true", "true", "false", "false", "false"],
  );
  assert.match(registry.get("notify-summary").textContent, /FOMC, Data/);

  // Theme and time frame moved here from the popup header.
  assert.equal(registry.get("theme-dark").checked, true);
  assert.equal(registry.get("horizon-90").checked, true);

  // Coverage moved here from the popup; acronyms keep their case and an
  // all-clear feed hides the warning block rather than rendering it empty.
  const names = registry.get("coverage-families").children.map((row) => row.children[0].textContent);
  assert.deepEqual(names, ["FOMC", "ISM"]);
  assert.equal(registry.get("coverage-warnings").hidden, true);
  assert.equal(registry.get("coverage-meta").children.length, 3);

  // The live shortcut is read from Chrome, not assumed from the manifest.
  assert.equal(registry.get("shortcut-current").textContent, "Alt+Shift+C");

  // The shortcuts button targets Chrome's own settings page.
  registry.get("open-shortcuts").listeners.click();
  assert.deepEqual(opened, ["chrome://extensions/shortcuts"]);
});

test("an unset or unavailable shortcut does not break the page", async () => {
  const { registry } = installStubs({ commands: false });
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);

  await import(`../options/options.js?nocommands=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onRejection);

  assert.deepEqual(errors.map((error) => String(error?.message ?? error)), []);
  // Falls back to the manifest's suggestion rendered in the HTML.
  assert.equal(registry.get("timezone").children.length > 5, true);
});

test("the test-notification button reports success and failure in the page", async () => {
  const { registry, sent } = installStubs({ testResponse: { ok: true } });
  await import(`../options/options.js?test-ok=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 40));

  await registry.get("test-notification").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(sent.some((m) => m.type === "test-notification"));
  assert.match(registry.get("test-result").textContent, /Sent/);
});

test("a failed test notification shows the reason rather than nothing", async () => {
  // The whole point of the button: when delivery fails there is normally no
  // notification and no error anywhere, so the reason has to reach the page.
  const { registry } = installStubs({
    testResponse: { ok: false, error: 'permission is "denied"' },
  });
  await import(`../options/options.js?test-fail=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 40));

  await registry.get("test-notification").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = registry.get("test-result");
  assert.match(result.textContent, /Failed: permission is "denied"/);
  assert.ok(result.classList.contains("error"));
});

test("notification chips toggle, and Save stores theme and time frame", async () => {
  const { registry } = installStubs();
  let saved;
  globalThis.chrome.storage.sync.set = async (items) => { saved = items.prefs; };
  await import(`../options/options.js?save=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Untick Data, tick Treasury.
  const chips = registry.get("notify-groups").children;
  chips[1].listeners.click();
  chips[2].listeners.click();
  assert.equal(chips[1].getAttribute("aria-pressed"), "false");
  assert.equal(chips[2].getAttribute("aria-pressed"), "true");

  registry.get("theme-dark").checked = false;
  registry.get("theme-light").checked = true;
  registry.get("horizon-90").checked = false;
  registry.get("horizon-30").checked = true;
  registry.get("offsets").value = "15";
  registry.get("allday-hour").value = "8";

  await registry.get("save").listeners.click();
  assert.deepEqual(saved.notifyGroups, ["fomc", "treasury"]);
  assert.equal(saved.theme, "light");
  assert.equal(saved.viewHorizonDays, 30);
  assert.deepEqual(saved.alarmOffsets, [15]);
});
