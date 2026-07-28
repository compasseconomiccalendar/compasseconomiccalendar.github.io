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
- Advance notifications at 30 and 5 minutes; clicking one opens the event's
  `source_url` so the time can be verified against the official source
- Popup lists upcoming events in the viewer's local timezone with an impact
  filter, and surfaces the feed's `coverage` warnings so an unpublished date
  range does not read as an empty one
- Disclaimer and FRED attribution on the popup

## Design notes

The MV3 service worker is evicted after ~30s idle, so **no state lives in
module scope** — every handler re-reads `chrome.storage`. Notification alarms
are capped (`MAX_SCHEDULED_ALARMS`, 72h horizon) and rebuilt from scratch on
every refresh and every fired alarm, rather than scheduling one alarm per
event across the whole year.

All selection logic lives in `src/filters.js` as pure functions — no `chrome.*`
calls and no clock reads — which is what makes it testable under plain node.

## Not done yet

- Options page (offsets, hidden event types, timezone override)
- Timezone selector in the popup (currently always the browser's zone)
- Event detail view
- Store listing: privacy policy URL, screenshots, permission justifications
- Decide whether to keep vanilla JS or move the popup to React
  (`docs/RESEARCH.md` §4.4 assumes React; there is currently no build step to
  support it)
