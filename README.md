# Compass Economic Calendar

A free, machine-readable calendar of the scheduled events that move U.S. index
futures: FOMC decisions, macro data releases, Treasury auctions, and CME
futures roll/expiration dates — normalized into one JSON file and one
subscribable `.ics` feed.

The normalized JSON is the crown jewel. The ICS feeds and the Chrome extension
are both just consumers of it.

See [`docs/RESEARCH.md`](docs/RESEARCH.md) for the sourcing, licensing and
architecture research behind this design.

---

## Status

| Phase | Scope | State |
|---|---|---|
| **0** | Python ingestion job → `output/calendar.json` | ✅ Built |
| **1** | ICS feeds → `compass_calendar.ics` + high-impact variant | ✅ Built |
| **2** | MV3 Chrome extension (`extension/`) | ✅ Built — not yet submitted |
| **3** | "Typical move" context | ✅ Built |
| **3+** | Webhooks, PWA dashboard | ⬜ Not started |

---

## What's in the feed

| Source | Events |
|---|---|
| federalreserve.gov (scraped) | FOMC meeting day 1, statement (2:00pm ET), Chair press conference (2:30pm ET), SEP / dot plot, minutes |
| FRED API | Employment Situation, CPI, PPI, GDP, Personal Income & Outlays, Initial Jobless Claims (weekly), Retail Sales (8:30am ET); Factory Orders M3, JOLTS (10:00am ET) |
| Computed (exchange rules) | NYSE/Nasdaq closures and 1:00pm early closes — federal holidays *minus* Columbus and Veterans Day, *plus* Good Friday, with the NYSE Saturday-New-Year exception |
| Computed (ISM pattern) | ISM Manufacturing PMI (1st business day) and Services PMI (3rd business day), 10:00am ET — **flagged `approximate`** |
| bea.gov (enrichment) | Differentiates GDP advance / second / third estimates so only the advance print is rated high impact |
| TreasuryDirect | Bill/note/bond/TIPS auctions, plus computed quarterly refunding announcements |
| Computed (CME rules) | Liquidity roll, CME official roll, futures expiration, quad witching, monthly OPEX for /ES, /NQ, /MES, /MNQ |

---

## Published feed

- Landing page: <https://compasseconomiccalendar.github.io/compasseconomiccalendar/>
- JSON: <https://compasseconomiccalendar.github.io/compasseconomiccalendar/calendar.json>
- ICS, full: <https://compasseconomiccalendar.github.io/compasseconomiccalendar/compass_calendar.ics>
- ICS, high impact only: <https://compasseconomiccalendar.github.io/compasseconomiccalendar/compass_calendar_high_impact.ics>
- Privacy policy: <https://compasseconomiccalendar.github.io/compasseconomiccalendar/privacy.html>

Subscribe to either ICS URL in Google Calendar, Apple Calendar or Outlook. The
high-impact feed carries FOMC, CPI, jobs, PCE, advance GDP and quad witching —
about half the events, without the routine bill auctions. The two feeds use
distinct event UIDs, so subscribing to both is safe.

**Google Calendar:** desktop only — sidebar → **Other calendars → + → From
URL**. Google refreshes subscriptions on its own schedule (typically 8–24
hours) and ignores the `REFRESH-INTERVAL:PT12H` in the file. **Apple
Calendar:** use the same URL with `webcal://` and set auto-refresh to Daily.

Neither feed ships reminders by default. Set them per-calendar in your client,
or regenerate with `--alarm-minutes 30 --alarm-minutes 5` to bake them in.

---

## Setup

```bash
git clone https://github.com/compasseconomiccalendar/compasseconomiccalendar.git
cd compasseconomiccalendar

python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # then paste in your FRED API key
```

A free FRED key takes about a minute to get:
<https://fredaccount.stlouisfed.org/apikeys>

## Usage

```bash
# Full build (needs FRED_API_KEY in .env)
python ingestion/build_calendar.py

# Everything except FRED — no key required
python ingestion/build_calendar.py --skip-fred

# Then render the calendar feed
python ingestion/generate_ics.py

# High-impact-only variant (as published)
python ingestion/generate_ics.py \
  --min-impact high \
  --out output/compass_calendar_high_impact.ics \
  --calname "Compass Economic Calendar (High Impact)" \
  --uid-suffix high

# With reminders baked into the ICS
python ingestion/generate_ics.py --alarm-minutes 30 --alarm-minutes 5

python -m unittest discover -s ingestion -p 'test_*.py'
```

Useful `build_calendar.py` flags:

| Flag | Effect |
|---|---|
| `--months N` | Forward coverage window (default 13) |
| `--past-days N` | Retain N days of history (default 0) |
| `--skip-fred` / `--skip-treasury` / `--skip-fomc` | Skip a source |
| `--skip-bea` | Skip the BEA GDP-estimate enrichment |
| `--skip-ism` | Skip the computed (approximate) ISM dates |
| `--allow-partial` | Publish even if a source fails (default: fail the build) |

By default **any source failure fails the whole build** rather than silently
publishing a calendar with holes in it.

---

## Event schema

```json
{
  "id": "fomc-statement-2026-09-16",
  "event_type": "fomc_statement",
  "title": "FOMC Statement & Rate Decision",
  "start_utc": "2026-09-16T18:00:00Z",
  "end_utc": "2026-09-16T18:30:00Z",
  "all_day": false,
  "date_et": "2026-09-16",
  "time_et": "14:00",
  "market_impact": "high",
  "source": "federalreserve.gov",
  "source_url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  "note": "Interest rate decision and policy statement released at 2:00pm ET...",
  "has_sep": true
}
```

Every event carries `event_type`, `market_impact` (`high`/`medium`/`low`),
`source_url` for verification, and a plain-English `note`. Source-specific
extras (`cusip`, `contract_code`, `fred_release_id`, `has_sep`,
`holiday_adjusted`, …) are added where they apply.

**All timestamps are UTC.** Eastern release times are converted through the
IANA `America/New_York` zone, so DST is handled correctly — 8:30am ET is
12:30Z in summer and 13:30Z in winter. This is covered by tests.

### Coverage block

Computed events (futures, refunding) run to the end of the window by
construction. Reported events only reach as far as the upstream agency has
published. `calendar.json` says which is which, so a sparse far-future month
reads as an unpublished schedule rather than missing data:

```json
"coverage": {
  "window_end": "2027-08-28",
  "families": {
    "macro_releases": {
      "horizon": "reported",
      "event_count": 27,
      "first_event": "2026-07-30",
      "confirmed_through": "2026-12-23",
      "complete_to_window_end": false
    },
    "futures": { "horizon": "computed", "complete_to_window_end": true }
  },
  "warnings": ["macro_releases: upstream has published dates only through ..."]
}
```

**Consumers should read `coverage` before rendering a date range.** A month
past a family's `confirmed_through` is not empty — it is unpublished.

### Typical-move context

`ingestion/build_typical_moves.py` computes, from ten years of FRED daily
index history, how much SPX and NDX actually moved on each kind of event day.
`data/typical_moves.json` is regenerated monthly by its own workflow, and
`build_calendar.py` attaches a compact `typical_move` to each event.

**The ratio to baseline is the number that matters**, not the raw percentage.
A typical SPX day moves 0.49% (median), so "CPI day moves 0.51%" means CPI day
is an ordinary day. Ratios are computed on medians because the baseline *mean*
is inflated by a few crisis sessions unrelated to any event.

Measured over the trailing 3-year window:

| Event | Ratio | Shown? |
|---|---|---|
| Employment Situation | 1.69× | ✅ badge |
| FOMC statement | 1.49× | ✅ badge |
| Monthly OPEX | 1.40× | ✅ badge |
| CPI | 1.20× | — |
| GDP | 0.86× | — |

Realized move is only half of it. Close-to-close cannot see an 8:30am release
that spikes pre-open and mean-reverts by the close, so a second measure —
**vol crush**, how much more VIX falls than on an ordinary day (Cboe data,
free and keyless) — runs alongside. GDP moves *less* than a normal day yet has
the 4th-deepest crush; it would have been invisible otherwise.

A number is only surfaced at **≥1.25×, ≤0.85×, or a vol crush ≥1.0% deeper
than normal**. Everything else says it
moves about as much as a normal day, rather than presenting 1.02× as insight.
Event types with fewer than `--min-sample` observations are dropped entirely.

Only aggregates are published — means, medians, percentiles, counts. No price
series is written out; the FRED index series carry an S&P Dow Jones copyright
note (§1.2 of the research doc) restricting redistribution of the series, not
of facts derived from it. A test asserts the output keys stay inside that
allowlist.

### BEA enrichment

FRED release 53 reports all three GDP estimates under one name, so the advance
print is indistinguishable from the third. The BEA schedule page spells the
difference out, and the job uses it to correct `market_impact`:

| BEA release title | `release_variant` | Impact |
|---|---|---|
| GDP (Advance Estimate) | `advance` | high |
| GDP (Second Estimate) and Corporate Profits | `second` | medium |
| GDP (Third Estimate), Industries… | `third` | low |

Enriched events gain `bea_release_title` and `confirmed_by: "bea.gov"`, and
BEA's stated release time overrides the assumed 8:30am ET if they differ.
This step is **non-fatal** — if BEA is unreachable the calendar is still
complete, just with coarser GDP ratings. Disable with `--skip-bea`.

---

## Manual overrides

Scraped schedules break and shutdowns reschedule releases, so
`data/overrides.json` always wins over the fetched data:

```json
{
  "remove": ["fred-gdp-2026-10-29"],
  "upsert": [{ "id": "fomc-statement-2026-09-16", "time_et": "14:00" }]
}
```

An `upsert` merges over a matching event id, or is appended whole if the id is
new. Anything touched is tagged `"manually_overridden": true` in the output.

---

## Automation

`.github/workflows/refresh_calendar.yml` runs Sundays at 13:00 UTC (6:00am MST
/ 7:00am MDT — GitHub cron doesn't follow DST), and also on any push that
touches `ingestion/`. It runs the tests, rebuilds both artifacts, commits them,
and deploys `calendar.json` + `compass_calendar.ics` + a landing page to GitHub
Pages.

**Two things to configure once in the repo settings:**

1. **Secrets → Actions →** add `FRED_API_KEY`. Without it the build fails by
   design rather than publishing a partial calendar.
2. **Pages → Source →** set to **GitHub Actions**.

`output/` is gitignored for local builds; the workflow force-adds the two
published artifacts so the feed stays versioned.

---

## Known limitations

- **Treasury forward coverage is short.** Treasury only announces auctions
  about one to two weeks ahead, so the feed typically holds ~10–15 upcoming
  auctions at a time. The quarterly refunding announcements are computed and
  extend across the full window.
- **TreasuryDirect is JSON, not XML.** The research doc refers to an XML feed,
  but `?format=xml` and an XML `Accept` header both return HTTP 406 as of
  July 2026. The service is JSON-only and the job parses JSON.
- **Press conferences are asserted, not scraped.** The Fed only links a press
  conference once it is scheduled, which means the link is missing on future
  meetings. A presser has followed every meeting since 2019, so one is emitted
  for every meeting and flagged `"confirmed": false` until the Fed lists it.
- **Macro releases only reach ~5 months out, and no automated source fixes
  that.** Measured 2026-07-28: FRED returns 5–6 scheduled dates per release,
  ending 2026-12-23, while FOMC and futures events run to 2027-08. Both
  alternatives were investigated and neither helps:
  - **BLS cannot be scraped.** Every path (`/schedule/`, the annual schedule
    pages, the RSS feed, `download.bls.gov`) returns HTTP 403 with an explicit
    policy statement that "bot activity that doesn't conform to BLS usage
    policy is prohibited." `api.bls.gov` is reachable but serves time-series
    data only — it has no release-schedule endpoint.
  - **BEA adds no horizon.** Its schedule page is scrapeable and permitted,
    but its last dated row is 2026-12-23 — the same date FRED already gives.
    It is used for precision instead (see below), not for coverage.

  The only real fix is hand-curation once the agencies publish next-year
  schedules (typically late in the prior year). Drop those dates into
  `data/overrides.json`; the merge mechanism already exists. Until then the
  `coverage` block tells consumers exactly where the data stops.
- **FRED release dates are upstream-reported.** FRED notes that release dates
  come from the data sources and don't necessarily reflect when data will be
  available. Cross-check FOMC and Treasury dates against the primary sites.
- **SEP detection** keys off the Fed's own asterisk, falling back to the
  Mar/Jun/Sep/Dec convention; the signal used is recorded in `sep_signal`.
- **ISM dates are estimates.** ISM publishes no machine-readable schedule and
  FRED dropped the series over licensing, so the dates are computed from the
  usual pattern (1st and 3rd business day, federal holidays excluded). Every
  ISM event carries `"approximate": true` and says so in its title and note.
  ISM's *values* are licensed and are never published here — only dates, which
  are facts (`docs/RESEARCH.md` §1.1).

### FRED release IDs are resolved, not hardcoded

The job looks each release up by name against `fred/releases` and treats any
`release_id` in the config as an assertion. If FRED's id for a name ever
changes, or a pattern matches zero or several releases, the build fails with
the candidates listed rather than silently publishing the wrong release. This
matters because ID 11 is the Employment Cost Index, not the jobs report.

---

## Legal

> For informational and educational purposes only. Not investment advice.
> Times are subject to change; verify against official sources before trading.

> This product uses the FRED® API but is not endorsed or certified by the
> Federal Reserve Bank of St. Louis.

FRED API [Terms of Use](https://fred.stlouisfed.org/docs/api/terms_of_use.html).
FOMC and Treasury schedule data are U.S. government works in the public domain.
No licensed third-party values (ISM, U-Mich, ADP, consensus forecasts) are
redistributed — see `docs/RESEARCH.md` §1.1.
