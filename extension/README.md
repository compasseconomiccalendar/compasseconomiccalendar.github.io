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
- **Toolbar badge** counts down to the next high-impact event (`45m`, `2h`,
  `3d`), turning red inside 30 minutes. Ticks every minute when close and
  hourly when days out; shows `!` when the cache is stale
- Popup lists upcoming events grouped by day (Today / Tomorrow / weekday) with
  an impact filter and FOMC/Data/Treasury/Futures chips
- **Events stay listed for 90 minutes after they start**, under "Happening
  now" — an FOMC statement should not vanish at 2:00:01
- Warns when the cache is over 10 days old or the feed was built with a
  failing source, and surfaces the feed's `coverage` warnings so an
  unpublished date range does not read as an empty one
- All-day events (futures rolls, FOMC day 1) get a morning-of nudge instead of
  a meaningless "30 minutes before midnight"
- Notification buttons to verify at source or snooze for an hour
- Arrow keys move between events; Escape leaves the detail view
- Event detail view: click any event for the full note, source-specific
  metadata (contract code, CUSIP, GDP estimate, meeting span…) and the time in
  your zone, Eastern and UTC. Escape or ← returns to the list
- Options page (⚙ in the popup): timezone override, separate list and
  notification impact thresholds, notification toggle and offsets, and
  per-event-type hiding
- Disclaimer and FRED attribution on both the popup and the options page

## Preferences

Stored in `chrome.storage.sync`, so they follow a signed-in Chrome profile.

| Pref | Default | Notes |
|---|---|---|
| `timeZone` | `null` | `null` uses the browser zone; otherwise an IANA name such as `America/Denver` |
| `viewMinImpact` | `medium` | Filters the popup list only |
| `notifyMinImpact` | `medium` | Notification threshold, set independently |
| `alarmOffsets` | `[30, 5]` | Minutes before the event, up to four |
| `notificationsEnabled` | `true` | |
| `hiddenTypes` | `[]` | Event types removed from the list and never notified |
| `allDayNotifications` | `true` | Morning-of nudge for all-day events |
| `allDayHour` | `8` | Local hour for that nudge |

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

## Store submission

Privacy policy is published at
<https://compasseconomiccalendar.github.io/compasseconomiccalendar/privacy.html> —
that URL goes in the Web Store listing's *Privacy policy* field. Its
"Permissions and why each is needed" table doubles as the source text for the
per-permission justifications the review asks for. Source lives in
`web/privacy.html`.

Data-handling disclosures to tick in the developer dashboard: **no** data
collected in any category, **no** sale or transfer to third parties, **no**
use for purposes unrelated to core functionality, **no** use for
creditworthiness or lending.

### Building the upload zip

```bash
python scripts/package_extension.py           # writes dist/compass-economic-calendar-vX.Y.Z.zip
python scripts/package_extension.py --check   # validate only; also runs in CI
```

Development files are excluded — `package.json`, `test/`, the icon generators
and the promo tile. Before zipping it checks that every file the manifest
references is present, that every relative import resolves to a packaged file,
and that no HTML loads a remote script or stylesheet (MV3 forbids remote code,
and it is a known rejection reason).

The 440×280 promo tile is at `icons/promo_440x280.png`, regenerated with
`python icons/generate_promo.py`. It is uploaded to the listing separately,
not bundled in the extension.

### Not done yet

- Screenshots (1280×800 or 640×400) — needs a human at a browser
- $5 developer registration
- Paste the permission justifications into the dashboard
### Verified in a real browser

Loaded unpacked 2026-07-28. The service worker logged
`[compass] refreshed; 18 notification(s) scheduled`, which confirms the feed
fetch, both storage areas, `chrome.alarms.create`, and badge painting (it is
awaited before that line). That load is also what surfaced the view/notify
pref coupling, since 18 alarms is the `low` threshold rather than the default.

Still unexercised: popup, options and detail rendering, and whether a
notification actually displays with its buttons.

**Vanilla JS is settled** — decided 2026-07-28, recorded in `docs/RESEARCH.md`
§4.4, which originally specified React. Revisit only if the UI grows enough
state to justify a build step.
