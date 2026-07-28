# Chrome Extension — Phase 2 (in progress)

A thin MV3 client over the published feed. It fetches `calendar.json` from
GitHub Pages and renders it in local time; it never calls a government site
directly, which is what keeps `host_permissions` to a single entry
(`docs/RESEARCH.md` §4.2).

**No build step and no dependencies.** Chrome loads `src/` and `popup/` as
written. `package.json` exists only to mark the sources as ES modules for
`node --test`.

## Load it

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Click the toolbar icon. If the list is empty, press **↻** — the first fetch
   happens on install and on browser startup.

## Test

```bash
cd extension
node --test 'test/*.test.js'
```

Icons are generated, not hand-drawn — regenerate with
`python icons/generate_icons.py` (standard library only).

## What works

- Fetches and caches the feed in `chrome.storage.local`, using an ETag so an
  unchanged feed costs a 304
- Refresh alarm every 12h, plus manual refresh from the popup
- Advance notifications at configurable offsets (30 and 5 minutes by default);
  clicking one opens the event's `source_url` so the time can be verified
  against the official source
- Popup lists upcoming events with an impact filter, and surfaces the feed's
  `coverage` warnings so an unpublished date range does not read as an empty one
- Event detail view: click any event for the full note, source-specific
  metadata (contract code, CUSIP, GDP estimate, meeting span…) and the time in
  your zone, Eastern and UTC. Escape or ← returns to the list
- Options page (⚙ in the popup): timezone override, minimum impact,
  notification toggle and offsets, and per-event-type hiding
- Disclaimer and FRED attribution on both the popup and the options page

## Preferences

Stored in `chrome.storage.sync`, so they follow a signed-in Chrome profile.

| Pref | Default | Notes |
|---|---|---|
| `timeZone` | `null` | `null` uses the browser zone; otherwise an IANA name such as `America/Denver` |
| `minImpact` | `medium` | Applies to the popup list *and* to notifications |
| `alarmOffsets` | `[30, 5]` | Minutes before the event, up to four |
| `notificationsEnabled` | `true` | |
| `hiddenTypes` | `[]` | Event types removed from the list and never notified |

Saving from the options page messages the service worker to rebuild its alarm
schedule immediately, rather than waiting for the next 12-hour refresh.

## Design notes

The MV3 service worker is evicted after ~30s idle, so **no state lives in
module scope** — every handler re-reads `chrome.storage`. Notification alarms
are capped (`MAX_SCHEDULED_ALARMS`, 72h horizon) and rebuilt from scratch on
every refresh and every fired alarm, rather than scheduling one alarm per
event across the whole year.

All selection logic lives in `src/filters.js` as pure functions — no `chrome.*`
calls and no clock reads — which is what makes it testable under plain node.

## Not done yet

- Store listing: privacy policy URL, screenshots, permission justifications

**Vanilla JS is settled** — decided 2026-07-28, recorded in `docs/RESEARCH.md`
§4.4, which originally specified React. Revisit only if the UI grows enough
state to justify a build step.
