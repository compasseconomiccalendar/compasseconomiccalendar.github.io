/**
 * Options page. Writes prefs to chrome.storage.sync, then asks the service
 * worker to rebuild its alarm schedule so a change takes effect immediately
 * rather than at the next 12-hour refresh.
 */

import { DEFAULT_PREFS, MAX_ALARM_OFFSETS } from "../src/config.js";
import {
  TYPE_GROUPS,
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
  notifyGroups: document.getElementById("notify-groups"),
  notifySummary: document.getElementById("notify-summary"),
  notifications: document.getElementById("notifications-enabled"),
  allDayEnabled: document.getElementById("allday-enabled"),
  allDayHour: document.getElementById("allday-hour"),
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

  const hidden = new Set(hiddenTypes);
  for (const type of types) {
    const row = document.createElement("label");
    row.className = "type";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = type;
    box.checked = !hidden.has(type);

    const label = document.createElement("span");
    label.textContent = type.replace(/_/g, " ");

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(counts[type]);

    row.append(box, label, count);
    elements.types.append(row);
  }
}

/** Same multi-select shape as the popup's type filter, for notifications. */
function buildNotifyGroups(selected) {
  const active = new Set(selected);
  elements.notifyGroups.replaceChildren();

  for (const group of TYPE_GROUPS) {
    const row = document.createElement("label");
    row.className = "type-option";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = group.id;
    box.checked = active.has(group.id);
    box.addEventListener("change", updateNotifySummary);

    const text = document.createElement("span");
    text.textContent = group.label;

    row.append(box, text);
    elements.notifyGroups.append(row);
  }
  updateNotifySummary();
}

function notifyGroupsFromForm() {
  return [...elements.notifyGroups.querySelectorAll("input[type=checkbox]")]
    .filter((box) => box.checked)
    .map((box) => box.value);
}

function updateNotifySummary() {
  const chosen = notifyGroupsFromForm();
  if (!chosen.length) {
    elements.notifySummary.textContent = "All event types";
    return;
  }
  const labels = TYPE_GROUPS.filter((group) => chosen.includes(group.id)).map(
    (group) => group.label,
  );
  elements.notifySummary.textContent =
    labels.length <= 2 ? labels.join(", ") : `${labels.length} types selected`;
}

function hiddenTypesFromForm() {
  return [...elements.types.querySelectorAll("input[type=checkbox]")]
    .filter((box) => !box.checked)
    .map((box) => box.value);
}

function flash(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
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

async function load(prefs) {
  applyTheme(prefs.theme);
  elements.timeFormat.value = prefs.timeFormat;
  buildNotifyGroups(prefs.notifyGroups ?? []);
  elements.notifications.checked = prefs.notificationsEnabled;
  elements.allDayEnabled.checked = prefs.allDayNotifications;
  elements.allDayHour.value = String(prefs.allDayHour);
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
    elements.testResult.textContent =
      "Sent. If you did not see it, your OS is suppressing notifications for this browser.";
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

  await setPrefs({
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
  flash(`Saved — ${response?.count ?? 0} warning(s) scheduled.`);
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
  await showCurrentShortcut();
})();
