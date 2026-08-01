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
- Popup lists upcoming events grouped by day (Today / Tomorrow / weekday),
  filtered by a multi-select **event type** dropdown (FOMC / Data / Treasury /
  Futures / Market). The selection persists; nothing ticked means everything
- **Events stay listed for 90 minutes after they start**, under "Happening
  now" — an FOMC statement should not vanish at 2:00:01
- Warns above the list when the cache is over 10 days old or the feed was
  built with a failing source — reserved for things that are actually wrong
- **Coverage tab**: per-source horizons from the feed's `coverage` block,
  marked computed or reported, so an unpublished date range does not read as
  an empty one. Informational, so it lives here rather than nagging above the
  list
- All-day events (futures rolls, FOMC day 1) get a morning-of nudge instead of
  a meaningless "30 minutes before midnight"
- Notification buttons to verify at source or snooze for an hour
- Arrow keys move between events; Escape leaves the detail view
- Event detail view: click any event for the full note, source-specific
  metadata (contract code, CUSIP, GDP estimate, meeting span…) and the time in
  your zone, Eastern and UTC. Escape or ← returns to the list
- **Hours tab**: live session status for both **equities** (pre-market / open /
  after hours / closed, with holidays and half days accounted for) and **CME
  equity index futures** (open / daily halt / weekend), session times **in your
  own timezone**, and upcoming market closures
- **Keyboard shortcut** (`Alt+Shift+C` by default) opens the popup from
  anywhere; the options page reads the *live* binding from Chrome and links to
  `chrome://extensions/shortcuts` to rebind it
- **Test notification button** in options — fires one immediately and reports
  the failure reason in the page, since a blocked notification otherwise
  produces nothing on screen and nothing in the console
- Options page (⚙ in the popup): timezone override, separate list and
  notification impact thresholds, notification toggle and offsets, and
  per-event-type hiding
- Disclaimer and FRED attribution on both the popup and the options page

## Preferences

Stored in `chrome.storage.sync`, so they follow a signed-in Chrome profile.

| Pref | Default | Notes |
|---|---|---|
| `timeFormat` | `auto` | `auto` follows the locale; `12h` or `24h` force it |
| `timeZone` | `null` | `null` uses the browser zone; otherwise an IANA name such as `America/Denver` |
| `selectedGroups` | `[]` | Ticked event types; empty means all |
| `notifyGroups` | `["fomc", "data"]` | Event types that notify; empty means all |
| `viewHorizonDays` | `90` | How far ahead the list reaches |
| `theme` | `dark` | `dark` or `light`; set explicitly, not from the OS |
| `alarmOffsets` | `[30, 5]` | Minutes before the event, up to four |
| `notificationsEnabled` | `true` | |
| `hiddenTypes` | `[]` | Event types removed from the list and never notified |
| `allDayNotifications` | `true` | Morning-of nudge for all-day events |
| `allDayHour` | `8` | Local hour for that nudge |

The keyboard shortcut is **not** a stored preference — Chrome owns it. An
extension cannot set its own binding, so the manifest declares a suggestion
and the user rebinds it on Chrome's shortcuts page.

Saving from the options page messages the service worker to rebuild its alarm
schedule immediately, rather than waiting for the next 12-hour refresh.

## Design notes

The MV3 service worker is evicted after ~30s idle, so **no state lives in
module scope** — every handler re-reads `chrome.storage`. Notification alarms
are capped (`MAX_SCHEDULED_ALARMS`, 72h horizon) and rebuilt from scratch on
every refresh and every fired alarm, rather than scheduling one alarm per
event across the whole year.

All selection logic lives in `src/filters.js` and `src/sessions.js` as pure
functions — no `chrome.*` calls and no clock reads — which is what makes it
testable under plain node, and lets the popup and the service worker share one
implementation.

**Session state is decided in Eastern, displayed in the viewer's zone.** Asking
"is it between 9:30 and 16:00" against local wall-clock would open the market
two hours late in Denver. Display conversion resolves against today's date
rather than a stored offset, because the gap from ET is not constant: US and UK
daylight saving shift on different dates, so 9:30am ET is 13:30 in London
during part of March and 14:30 in July.

The service worker imports the same session module, so market state is known
for the badge tooltip without the popup being opened. The computation is *not*
delegated to the worker — MV3 evicts it after ~30s idle, so the popup would
have to wake it and wait on a message round-trip to run a few comparisons.

## Store submission

Privacy policy is published at
<https://compasseconomiccalendar.github.io/privacy.html> —
that URL goes in the Web Store listing's *Privacy policy* field. Its
"Permissions and why each is needed" table doubles as the source text for the
per-permission justifications the review asks for. Source lives in
`web/privacy.html`.

### Listing copy

**Short description** (132 char limit — comes from `manifest.json`):

> Never get caught off guard by a market-moving event. FOMC, CPI, jobs,
> Treasury auctions, and futures rolls — in your timezone.

**Detailed description** (paste into the dashboard; the manifest cannot hold
this length):

> Never get caught off guard by a market-moving event. Compass tracks FOMC
> meetings, CPI, jobs reports, Treasury auctions, and futures contract rolls —
> all in your local timezone with advance notifications. Not investment advice.

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
After the split, the same profile reports 12 — the migration was verified on
the real stored prefs, not just in tests.

Still unexercised: popup, options and detail rendering, and whether a
notification actually displays with its buttons.

**Vanilla JS is settled** — decided 2026-07-28, recorded in `docs/RESEARCH.md`
§4.4, which originally specified React. Revisit only if the UI grows enough
state to justify a build step.
