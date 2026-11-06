// Stand-in for chrome.* so the popup and settings page render in a plain
// browser tab for store screenshots. Injected by render.sh; never shipped.
//
// Query parameters:
//   now=<ISO>       freeze the clock (still ticks forward from there)
//   theme=dark|light
//   reminders=a,b   event ids with a per-event reminder
//   groups=a,b      filter chips to show selected (fomc, data, ...)
//   click=<id>      click an element after the first render (opens panels)
//   scroll=<id>     scroll an element to the top of the page
(() => {
  const params = new URLSearchParams(location.search);

  // A fixed clock makes every render identical: countdowns, the week strip
  // and the market session all derive from "now".
  const frozen = params.get("now") ? Date.parse(params.get("now")) : null;
  if (Number.isFinite(frozen)) {
    const RealDate = Date;
    const started = RealDate.now();
    const clock = () => frozen + (RealDate.now() - started);
    // eslint-disable-next-line no-global-assign
    Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [clock()]));
      }
      static now() {
        return clock();
      }
    };
  }

  const sync = {
    prefs: {
      theme: params.get("theme") || "dark",
      // Store reviewers are everywhere; Eastern is how the agencies publish.
      timeZone: "America/New_York",
      timeFormat: "12h",
      morningBrief: true,
      morningBriefHour: 7,
      selectedGroups: (params.get("groups") || "").split(",").filter(Boolean),
    },
    reminders: (params.get("reminders") || "").split(",").filter(Boolean),
  };
  const local = { calendar: null, fetchedAt: Date.now(), lastError: null, snoozes: {} };
  const ready = fetch("/feed.json")
    .then((response) => response.json())
    .then((calendar) => {
      local.calendar = calendar;
      local.fetchedAt = Date.now() - 2 * 3600 * 1000;
    });

  const pick = (store, keys) => {
    if (keys == null) return { ...store };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]]));
  };

  window.chrome = {
    storage: {
      local: {
        get: async (keys) => { await ready; return pick(local, keys); },
        set: async (items) => Object.assign(local, items),
      },
      sync: {
        get: async (keys) => pick(sync, keys),
        set: async (items) => Object.assign(sync, items),
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async () => ({ ok: true, count: 6, briefAt: null }),
      openOptionsPage() {},
      getManifest: () => ({ version: "1.1.0" }),
    },
    commands: { getAll: async () => [{ name: "_execute_action", shortcut: "Alt+Shift+C" }] },
    tabs: { create() {} },
  };

  addEventListener("load", () => setTimeout(() => {
    const click = params.get("click");
    if (click) document.getElementById(click)?.click();
    const scroll = params.get("scroll");
    if (scroll) document.getElementById(scroll)?.scrollIntoView({ block: "start" });
    // Screenshots should not show a focus ring from a scripted click.
    document.activeElement?.blur?.();
  }, 600));
})();
