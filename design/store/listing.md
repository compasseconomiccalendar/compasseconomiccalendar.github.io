# Chrome Web Store listing — v1.1.0

Everything to paste or upload in the developer dashboard for this release.
Regenerate the images with `design/logo/render.sh` (icons, promo tile) and
`design/store/screenshots/render.sh` (screenshots).

## Package

`dist/compass-economic-calendar-v1.1.0.zip`, built from `main` with
`python scripts/package_extension.py`.

## Short description

Comes from `manifest.json` (132-character limit, currently 124):

> Market-moving events, counted down: FOMC, CPI, jobs, Fed Chair remarks and
> Treasury auctions, with alerts in your time zone.

## Detailed description

Paste into the dashboard; the manifest cannot hold this length.

```
Never get caught off guard by a market-moving event.

Compass counts down to the next high-impact US release and lays out the week ahead, in your own time zone. Built for traders who need to know when, not what.

WHAT'S COVERED
• FOMC: rate decisions, press conferences, projections (dot plot), minutes and the Beige Book
• Fed Chair speeches and congressional testimony
• Economic data: jobs report, CPI, PPI, PCE, GDP, retail sales, jobless claims, JOLTS, ISM, industrial production, housing starts, employment cost index, factory orders
• Treasury auctions and quarterly refunding
• CME index futures rolls and expirations, monthly options expiration and quad witching
• Market holidays and early closes

FEATURES
• Live countdown to the next high-impact event
• Week at a glance: the next five trading days, busy days marked
• Filter by FOMC, Data, Treasury, Futures or Market
• Typical move: how much the S&P 500 and Nasdaq 100 have moved on each kind of release, measured over years of past releases, with sample sizes shown
• Notifications before the events you choose, at the offsets you choose
• Remind me on any single event
• Morning brief: one weekday notification listing the day's key releases
• Add any event to Google Calendar or download it as .ics
• Equity and CME futures session hours in your time zone
• Toolbar countdown badge, keyboard shortcut (Alt+Shift+C), dark and light themes

PRIVACY
No account, no analytics, no tracking. Compass reads one public schedule file and keeps your settings on your device.

Schedule data comes from official public sources: the Federal Reserve, BLS, BEA, Census, Treasury and CME. Times are subject to change; verify against the official source (one click from any event) before trading.

For informational and educational purposes only. Not investment advice.

This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.

Note: desktop notifications need notification permission for your browser in your operating system's settings. The toolbar countdown works regardless.
```

## Screenshots (1280×800, upload in this order)

1. `screenshots/1-countdown.png`: next-event countdown and agenda
2. `screenshots/2-week.png`: week at a glance with filters (light theme)
3. `screenshots/3-detail.png`: event detail, typical move, reminder and calendar actions
4. `screenshots/4-hours.png`: market hours (light theme)
5. `screenshots/5-alerts.png`: notification settings with a morning brief

## Promo tile (440×280)

`promo_440x280.png`

## Privacy practices tab

Unchanged from 1.0.0. Tick **no** data collected in any category, **no** sale
or transfer, **no** use unrelated to core functionality, **no**
creditworthiness use. The privacy policy at
https://compasseconomiccalendar.github.io/privacy.html already covers the
1.1.0 additions (reminder ids in sync storage, the Google Calendar button).

No new permissions in 1.1.0, so the permission justifications are unchanged
and the update should not trigger a permission warning for existing users.
