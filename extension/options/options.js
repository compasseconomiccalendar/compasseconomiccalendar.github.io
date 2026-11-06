/**
 * Options page. Writes prefs to chrome.storage.sync, then asks the service
 * worker to rebuild its alarm schedule so a change takes effect immediately
 * rather than at the next 12-hour refresh.
 */

import { DEFAULT_PREFS, MAX_ALARM_OFFSETS } from "../src/config.js";
import { familyLabel, typeLabel } from "../src/details.js";
import {
  TYPE_GROUPS,
  groupOf,
  parseOffsets,
  resolveHour12,
  resolveTimeZone,
} from "../src/filters.js";
import { getCached, getPrefs, setPrefs } from "../src/store.js";

// Common US trading zones first, then everything the browser knows about.
const PINNED_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

const elements = {
  timezone: document.getElementById("timezone"),
  timezoneHint: document.getElementById("timezone-hint"),
  timeFormat: document.getElementById("timeformat"),
  themeDark: document.getElementById("theme-dark"),
  themeLight: document.getElementById("theme-light"),
  horizons: [7, 30, 90, 365].map((days) => ({
    days,
    input: document.getElementById(`horizon-${days}`),
  })),
  coverageMeta: document.getElementById("coverage-meta"),
  coverageFamilies: document.getElementById("coverage-families"),
  coverageWarnings: document.getElementById("coverage-warnings"),
  notifyGroups: document.getElementById("notify-groups"),
  notifySummary: document.getElementById("notify-summary"),
  notifications: document.getElementById("notifications-enabled"),
  allDayEnabled: document.getElementById("allday-enabled"),
  allDayHour: document.getElementById("allday-hour"),
  briefEnabled: document.getElementById("brief-enabled"),
  briefHour: document.getElementById("brief-hour"),
  offsets: document.getElementById("offsets"),
  types: document.getElementById("types"),
  openShortcuts: document.getElementById("open-shortcuts"),
  shortcutCurrent: document.getElementById("shortcut-current"),
  testNotification: document.getElementById("test-notification"),
  testResult: document.getElementById("test-result"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  status: document.getElementById("status"),
};

function browserZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function allZones() {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  const rest = supported.filter((zone) => !PINNED_ZONES.includes(zone));
  return [...PINNED_ZONES, ...rest];
}

function buildTimezoneOptions(selected) {
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = `Automatic (${browserZone()})`;
  elements.timezone.append(auto);

  for (const zone of allZones()) {
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = zone.replace(/_/g, " ");
    elements.timezone.append(option);
  }
  elements.timezone.value = resolveTimeZone(selected) ?? "";
}

function updateTimezoneHint() {
  const zone = resolveTimeZone(elements.timezone.value);
  const sample = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour12: resolveHour12(elements.timeFormat.value),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());
  elements.timezoneHint.textContent = `An 8:30am ET release shows in your list at local time — right now that zone reads ${sample}.`;
}

async function buildTypeCheckboxes(hiddenTypes) {
  const { calendar } = await getCached();
  const counts = calendar?.counts?.by_event_type ?? {};
  const types = Object.keys(counts).sort();

  elements.types.replaceChildren();
  if (!types.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent =
      "No feed cached yet — open the popup and refresh, then reload this page.";
    elements.types.append(note);
    return;
  }

  // Grouped the same way as the popup's filter chips, so a type is found
  // under the heading it is filtered by.
  const hidden = new Set(hiddenTypes);
  for (const group of TYPE_GROUPS) {
    const members = types.filter((type) => groupOf(type) === group.id);
    if (!members.length) continue;

    const block = document.createElement("div");
    block.className = "type-group";
    const heading = document.createElement("h3");
    heading.textContent = group.label;
    const list = document.createElement("div");
    list.className = "type-list";

    for (const type of members) {
      const row = document.createElement("label");
      row.className = "type";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = type;
      box.checked = !hidden.has(type);

      const label = document.createElement("span");
      label.textContent = settingsTypeLabel(type);

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(counts[type]);

      row.append(box, label, count);
      list.append(row);
    }
    block.append(heading, list);
    elements.types.append(block);
  }
}

const ACRONYMS = new Set(["fomc", "ism", "cpi", "ppi", "pce", "gdp", "pmi", "jolts", "sep"]);

/**
 * Readable name for a raw event type. The shared typeLabel() covers the
 * curated names; macro releases collapse to "Macro release" there, which is
 * right for a detail row but useless in a list of checkboxes.
 */
function settingsTypeLabel(type) {
  const known = typeLabel(type);
  if (known !== "Macro release" && known !== type.replace(/_/g, " ")) return known;
  const text = type
    .replace(/^macro_release_/, "")
    .replace(/^market_early_close$/, "early_close")
    .split("_")
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Notification groups are chips, like the popup filter. Their state lives
// here rather than being read back from the DOM.
let notifySelected = new Set();

function buildNotifyGroups(selected) {
  notifySelected = new Set(selected);
  elements.notifyGroups.replaceChildren();

  for (const group of TYPE_GROUPS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.value = group.id;
    chip.textContent = group.label;
    chip.setAttribute("aria-pressed", String(notifySelected.has(group.id)));
    chip.addEventListener("click", () => {
      if (notifySelected.has(group.id)) notifySelected.delete(group.id);
      else notifySelected.add(group.id);
      chip.setAttribute("aria-pressed", String(notifySelected.has(group.id)));
      updateNotifySummary();
    });
    elements.notifyGroups.append(chip);
  }
  updateNotifySummary();
}

function notifyGroupsFromForm() {
  return TYPE_GROUPS.map((group) => group.id).filter((id) => notifySelected.has(id));
}

function updateNotifySummary() {
  const chosen = notifyGroupsFromForm();
  if (!chosen.length) {
    elements.notifySummary.textContent =
      "Nothing selected means every event notifies, including routine bill " +
      "auctions, and the 20-alarm ceiling starts dropping the furthest-out warnings.";
    return;
  }
  const labels = TYPE_GROUPS.filter((group) => chosen.includes(group.id)).map(
    (group) => group.label,
  );
  elements.notifySummary.textContent = `Only ${labels.join(", ")} events will notify you.`;
}

function hiddenTypesFromForm() {
  return [...elements.types.querySelectorAll("input[type=checkbox]")]
    .filter((box) => !box.checked)
    .map((box) => box.value);
}

function flash(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  elements.status.classList.toggle("ok", !isError);
  if (!isError) {
    setTimeout(() => {
      elements.status.textContent = "";
    }, 2000);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (root) root.dataset.theme = theme === "light" ? "light" : "dark";
}

function selectedHorizon() {
  const checked = elements.horizons.find(({ input }) => input?.checked);
  return checked ? checked.days : DEFAULT_PREFS.viewHorizonDays;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Where each source's schedule runs out; moved here from the popup. */
async function renderCoverage() {
  const { calendar, fetchedAt } = await getCached();
  const when = (value) =>
    value
      ? new Date(value).toLocaleString(undefined, {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        })
      : "never";

  elements.coverageMeta.replaceChildren();
  for (const [label, value] of [
    ["Last refreshed", when(fetchedAt)],
    ["Feed built", calendar?.generated_at_utc ? when(calendar.generated_at_utc) : "unknown"],
    ["Events", String(calendar?.counts?.total ?? calendar?.events?.length ?? 0)],
  ]) {
    const cell = element("div");
    cell.append(element("dt", "", label), element("dd", "", value));
    elements.coverageMeta.append(cell);
  }

  elements.coverageFamilies.replaceChildren();
  for (const [family, info] of Object.entries(calendar?.coverage?.families ?? {})) {
    const row = element("li", `coverage-row${info.complete_to_window_end ? "" : " short"}`);
    row.append(
      element("span", "coverage-name", familyLabel(family)),
      element("span", `coverage-horizon ${info.horizon}`, info.horizon),
      element(
        "span",
        "coverage-through",
        info.confirmed_through
          ? `${info.event_count} events · through ${info.confirmed_through}`
          : "no events",
      ),
    );
    elements.coverageFamilies.append(row);
  }

  const warnings = calendar?.coverage?.warnings ?? [];
  elements.coverageWarnings.replaceChildren(...warnings.map((text) => element("p", "", text)));
  elements.coverageWarnings.hidden = warnings.length === 0;
}

async function load(prefs) {
  applyTheme(prefs.theme);
  elements.themeDark.checked = prefs.theme !== "light";
  elements.themeLight.checked = prefs.theme === "light";
  for (const { days, input } of elements.horizons) {
    if (input) input.checked = days === (prefs.viewHorizonDays ?? 90);
  }
  elements.timeFormat.value = prefs.timeFormat;
  buildNotifyGroups(prefs.notifyGroups ?? []);
  elements.notifications.checked = prefs.notificationsEnabled;
  elements.allDayEnabled.checked = prefs.allDayNotifications;
  elements.allDayHour.value = String(prefs.allDayHour);
  elements.briefEnabled.checked = Boolean(prefs.morningBrief);
  elements.briefHour.value = String(prefs.morningBriefHour ?? DEFAULT_PREFS.morningBriefHour);
  elements.offsets.value = prefs.alarmOffsets.join(", ");
  await buildTypeCheckboxes(prefs.hiddenTypes);
  updateTimezoneHint();
}

// Chrome exposes the *actual* binding, which may differ from the manifest's
// suggestion if the user rebound it or it collided with another extension.
async function showCurrentShortcut() {
  if (!chrome.commands?.getAll) return;
  const commands = await chrome.commands.getAll();
  const action = commands.find((command) => command.name === "_execute_action");
  elements.shortcutCurrent.textContent = action?.shortcut || "not set";
}

elements.testNotification.addEventListener("click", async () => {
  elements.testNotification.disabled = true;
  elements.testResult.textContent = "Sending…";
  elements.testResult.classList.remove("error");

  const response = await chrome.runtime.sendMessage({ type: "test-notification" });

  if (response?.ok) {
    // create() succeeded, so anything missing is below the extension: either
    // the OS is suppressing them, or the browser build does not register with
    // the system notification service (common in Chromium and Arc on macOS).
    elements.testResult.textContent =
      "Sent successfully. If nothing appeared, the browser handed it off but " +
      "your system did not draw it — check OS notification settings, or try " +
      "Google Chrome. Some Chromium builds (including Arc) do not deliver " +
      "notifications on macOS. The toolbar badge countdown works either way.";
  } else {
    // Reported in the page, because the failure mode being debugged is one
    // where nothing appears anywhere and there is nothing to go on.
    elements.testResult.textContent = `Failed: ${response?.error ?? "no response from the extension"}`;
    elements.testResult.classList.add("error");
  }
  elements.testNotification.disabled = false;
});

elements.openShortcuts.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

elements.timezone.addEventListener("change", updateTimezoneHint);
// Theme previews immediately; it is still only stored on Save.
elements.themeDark.addEventListener("change", () => applyTheme("dark"));
elements.themeLight.addEventListener("change", () => applyTheme("light"));

for (const button of document.querySelectorAll?.(".copy") ?? []) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.url);
      button.textContent = "Copied";
      button.classList.add("done");
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = "Copy link";
      button.classList.remove("done");
    }, 1800);
  });
}
elements.timeFormat.addEventListener("change", updateTimezoneHint);

elements.save.addEventListener("click", async () => {
  const offsets = parseOffsets(elements.offsets.value, MAX_ALARM_OFFSETS);
  if (!offsets) {
    flash("Enter at least one positive number of minutes.", true);
    elements.offsets.focus();
    return;
  }

  const allDayHour = Number(elements.allDayHour.value);
  if (!Number.isInteger(allDayHour) || allDayHour < 0 || allDayHour > 23) {
    flash("Morning reminder hour must be a whole number from 0 to 23.", true);
    elements.allDayHour.focus();
    return;
  }

  const briefHour = Number(elements.briefHour.value);
  if (!Number.isInteger(briefHour) || briefHour < 0 || briefHour > 23) {
    flash("Morning brief hour must be a whole number from 0 to 23.", true);
    elements.briefHour.focus();
    return;
  }

  await setPrefs({
    morningBrief: elements.briefEnabled.checked,
    morningBriefHour: briefHour,
    theme: elements.themeLight.checked ? "light" : "dark",
    viewHorizonDays: selectedHorizon(),
    allDayNotifications: elements.allDayEnabled.checked,
    allDayHour,
    timeZone: elements.timezone.value || null,
    timeFormat: elements.timeFormat.value,
    notifyGroups: notifyGroupsFromForm(),
    notificationsEnabled: elements.notifications.checked,
    alarmOffsets: offsets,
    hiddenTypes: hiddenTypesFromForm(),
  });

  elements.offsets.value = offsets.join(", ");
  const response = await chrome.runtime.sendMessage({ type: "reschedule" });
  const brief = response?.briefAt
    ? ` Next brief ${new Intl.DateTimeFormat(undefined, {
        weekday: "short", hour: "numeric", minute: "2-digit",
        timeZone: resolveTimeZone(elements.timezone.value),
        hour12: resolveHour12(elements.timeFormat.value),
      }).format(new Date(response.briefAt))}.`
    : "";
  flash(`Saved — ${response?.count ?? 0} warning(s) scheduled.${brief}`);
});

elements.reset.addEventListener("click", async () => {
  await setPrefs({ ...DEFAULT_PREFS });
  elements.timezone.value = "";
  await load(DEFAULT_PREFS);
  await chrome.runtime.sendMessage({ type: "reschedule" });
  flash("Reset to defaults.");
});

(async function init() {
  const prefs = await getPrefs();
  buildTimezoneOptions(prefs.timeZone);
  await load(prefs);
  await renderCoverage();
  await showCurrentShortcut();
})();
