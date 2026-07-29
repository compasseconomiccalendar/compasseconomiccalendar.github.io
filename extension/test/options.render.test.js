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
    setAttribute() {},
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
  counts: {
    by_event_type: { fomc_statement: 9, macro_release_cpi: 5, market_holiday: 10 },
  },
};

function installStubs({ commands = true } = {}) {
  const registry = new Map();
  const opened = [];
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
    runtime: { async sendMessage() { return { ok: true, count: 12 }; } },
    tabs: { create(options) { opened.push(options.url); } },
    ...(commands
      ? { commands: { async getAll() { return [{ name: "_execute_action", shortcut: "Alt+Shift+C" }]; } } }
      : {}),
  };
  return { registry, opened };
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

  // Event-type checkboxes come from the cached feed's counts.
  assert.equal(registry.get("types").children.length, 3);

  // Notification types render as the same multi-select shape as the popup,
  // seeded from the default selection.
  const notify = registry.get("notify-groups");
  assert.equal(notify.children.length, 5);
  assert.equal(registry.get("notify-summary").textContent, "FOMC, Data");

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
