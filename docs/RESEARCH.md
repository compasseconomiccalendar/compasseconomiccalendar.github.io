# Economic Calendar Chrome Extension — Feasibility & Build Research

> **Purpose:** This document is the source-of-truth reference for building the Market Calendar Extension. It covers data sources, licensing, technical architecture, regulatory considerations, and the recommended build plan. Hand this to Claude Code at the start of each session.

---

## TL;DR

- **Feasibility: Yes.** The core scheduling data (FOMC, jobs, CPI/PPI, GDP/PCE, Treasury auctions, futures roll dates) is available for free from authoritative U.S. government sources. The single biggest risk is the "market effect / consensus forecast" layer — that's where the good data is paywalled and redistribution-restricted.
- **Best execution path: thin backend + lightweight MV3 extension.** Build a scheduled Python job that publishes one normalized static JSON to a CDN (GitHub Pages or Cloudflare). The Chrome extension only consumes that JSON. Do NOT fetch government sites directly from the browser.
- **Ship the ICS feed first.** A subscribable Google Calendar / ICS feed is the fastest distribution path — no store review, works on every device, generated from the same JSON.
- **Compute futures roll dates algorithmically.** They follow a deterministic CME rule — no API or license needed.
- **Stay generic on "market effect" commentary** to remain within the SEC publisher's exclusion (Lowe v. SEC, 472 U.S. 181 (1985)). Use a clear "not investment advice" disclaimer throughout.

---

## 1. Data Sources

### 1.1 The Two Licensing Worlds

| Data type | Licensing status | Redistribution |
|---|---|---|
| Release **dates/times** (government-origin) | Public domain facts, non-copyrightable | ✅ Free to redistribute |
| **Consensus forecasts** and actual values (ISM, ADP, U-Mich, aggregators) | Private/licensed | ⚠️ Restricted — date only is safe |

Design the product so the free, redistributable schedule is the backbone. Any licensed value/forecast content is either omitted, shown as date-only, or properly licensed.

---

### 1.2 FRED API — Primary Backbone

The Federal Reserve Bank of St. Louis FRED API is the best single free source for macro release schedules.

**Key endpoint:** `fred/releases/dates`
- Set `include_release_dates_with_no_data=true` to include future/scheduled release dates (the default `false` excludes them)
- Each `release_date` carries a `release_last_updated` attribute to distinguish scheduled-but-unreleased dates from posted data
- Set `sort_order=asc` and an appropriate `realtime_end` to see forward dates

**Rate limits:**
- 30 requests/minute without a registered API key
- 120 requests/minute with a key
- No documented per-day cap

**Required release IDs:**

| Release | FRED ID |
|---|---|
| Employment Situation (jobs report) | 50 |
| CPI | 10 |
| PPI | 46 |
| GDP | 53 |
| Personal Income & Outlays (PCE) | 54 |

> ⚠️ Do NOT confuse release ID 11 (Employment Cost Index) with the monthly jobs report (ID 50).

**Licensing requirements for FRED data:**
FRED's copyright restrictions apply only to certain third-party data *series* marked "Copyright" in their notes (e.g., S&P/Dow Jones indices). BLS/BEA release schedules are U.S. federal statistical products in the public domain.

**Required attribution notice (verbatim):**
> "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."

Additional FRED ToS requirements:
- Do not use FRED/ALFRED/Federal Reserve marks in branding or hostname
- Do not build an app that "replicates or attempts to replace the essential user experience" of FRED
- Link users to the FRED API Terms of Use

---

### 1.3 Event-by-Event Source Reference

#### FOMC Meetings + SEP/Projection Meetings + Press Conferences
- **Source:** `federalreserve.gov/monetarypolicy/fomccalendars.htm`
- **Format:** HTML (no clean JSON); Fed offers RSS feeds
- **Volume:** 8 meetings/year; SEP released at 4 (Mar/Jun/Sep/Dec)
- **Times:** Statement at 2:00pm ET; Press conference at 2:30pm ET
- **Recommended approach:** Hand-curate annually (small volume), scrape as a check
- **License:** Public domain

#### BLS Employment Situation, CPI, PPI
- **Source:** `bls.gov/schedule` + BLS Public Data API (JSON)
- **FRED IDs:** 50 / 10 / 46
- **Release time:** 8:30am ET
- **License:** U.S. government work, public domain, no redistribution restriction

#### BEA (GDP, PCE / Personal Income & Outlays)
- **Source:** `bea.gov/news/schedule` + BEA API (JSON)
- **FRED IDs:** 53 / 54
- **Note:** PCE is the Fed's preferred inflation gauge
- **Release time:** 8:30am ET
- **License:** Public domain
- **⚠️ Risk:** BEA rescheduled and cancelled releases around the 2025 government shutdown. Build a "schedule may have changed" fallback and a manual-override layer.

#### Census Bureau (Retail Sales, Durable Goods)
- **Source:** Census release schedule + free Census API
- **License:** Public domain

#### ISM PMI (Manufacturing & Services)
- **Source:** ISM (private organization)
- **License:** ⚠️ **RESTRICTED.** ISM ToS grants only "a limited, revocable, nonsublicensable license… solely for your personal, non-commercial use." You may show the *date* (a fact) but must NOT redistribute ISM's values commercially.
- **Release pattern:** ~1st business day (Manufacturing), ~3rd business day (Services) of the month

#### University of Michigan Sentiment & ADP Employment
- **License:** ⚠️ Private sources — treat like ISM. Date is safe; values are licensed.
- **Note:** ADP National Employment Report publishes two days before the BLS jobs report.

#### Treasury Auctions + Quarterly Refunding Announcements
- **Source:** TreasuryDirect XML feed + `data.gov` dataset
- **License:** Creative Commons CC0 (public domain, "intended for public access and use")
- **Quarterly refunding:** First Wednesday of Feb/May/Aug/Nov
- **TreasuryDirect API:** Available at `treasurydirect.gov/auctions/announcements-data-results/`

#### Futures Contract Roll Dates (CME NQ, ES, MNQ, MES)
- **Source:** Computed algorithmically — no API or license needed
- **CME official rule:** "Equity products roll date is the Monday prior to the third Friday of the expiration month."
- **Trader liquidity roll:** Second Thursday before the third Friday (~8 calendar days before expiry) — when volume/OI migrates to the back month
- **Quarterly cycle:** Mar (H), Jun (M), Sep (U), Dec (Z)
- **Expiration:** Third Friday of the delivery month
- **Quad witching:** Third Friday of Mar/Jun/Sep/Dec
- **Monthly OPEX:** Third Friday of each month
- **Applies to:** /NQ, /MNQ micros, /ES, /MES micros

#### Fed Speakers + Chair Press Conferences
- **Source:** `federalreserve.gov` events calendar
- **License:** Public domain

#### OPEC Meetings
- **Source:** `opec.org`

#### Mega-Cap Earnings (index movers)
- **Source:** Finnhub or FMP free tiers — verify redistribution terms before shipping to end users

---

### 1.4 Third-Party Aggregator API Comparison

| Provider | Free Tier | Rate Limit | Has Consensus Forecasts | Redistribution |
|---|---|---|---|---|
| **FRED** | ✅ Free | 120 req/min (w/ key) | ❌ No | ✅ OK (with attribution) |
| **BLS Public Data API** | ✅ Free | Generous | ❌ No | ✅ Public domain |
| **BEA API** | ✅ Free | Generous | ❌ No | ✅ Public domain |
| **TreasuryDirect XML** | ✅ Free | No cap | N/A | ✅ CC0 |
| **Finnhub** | Limited free | 60 calls/min | ⚠️ Gated to paid | ❓ Verify before distributing |
| **Trading Economics** | `guest:guest` (testing only) | Very limited | ✅ Yes (best in class) | ⚠️ Distribution-based pricing |
| **Forex Factory** | Unofficial JSON/ICS export | N/A | ✅ Yes | ❌ ToS does not authorize commercial redistribution |
| **FMP / Marketaux / Alpha Vantage** | Various free tiers | Varies | Partial | ❓ Verify ToS at build time |
| **Nasdaq Data Link** | Limited free | Varies | Partial | ❓ Verify ToS at build time |

> **Note:** Aggregator free-tier limits and redistribution terms change frequently. Re-verify each provider's ToS at build time — especially Finnhub's economic-calendar gating and Trading Economics' distribution pricing.

---

## 2. The "Market Effect" Layer

The deviation between forecast and actual — not the absolute number — drives the immediate move. For a free, redistributable product there are two honest approaches:

### Option A — Static educational context (recommended for MVP)
Skip live consensus. Show historically-computed typical move context:

| Event | Avg absolute move (SPX) | Avg absolute move (NDX) |
|---|---|---|
| CPI day | ±0.64% | ±0.98% |
| FOMC day | ±1.19% | ±1.67% |

*Source: Russell Rhoads, illustrative ~12-event window. Recompute from primary price data before publishing.*

Academic backing:
- VIX rises into FOMC/PPI/CPI events and drops afterward (ScienceDirect study)
- NBER working paper w28306 on event-day options confirms elevated implied volatility pattern

This approach is fully redistributable and is the primary differentiator — no existing free calendar combines futures roll dates + macro releases + typical move context.

### Option B — License consensus data
Evaluate a paid Trading Economics distribution license only if users demand it and you have monetization to cover distribution-based pricing.

### Required Disclaimer (use verbatim or close equivalent)
> *"For informational and educational purposes only. Not investment advice. Times are subject to change; verify against official sources before trading."*

---

## 3. Regulatory Considerations

Publishing impersonal, general-circulation commentary on economic data falls under the **"publisher's exclusion"** of Section 202(a)(11)(D) of the Investment Advisers Act.

**Lowe v. SEC, 472 U.S. 181 (1985):** The Supreme Court held the exclusion covers publishers of bona fide business or financial publications of general and regular circulation, reasoning that "completely disinterested" content "offered to the general public on a regular schedule" fits the plain language of the exclusion.

**Safe harbor conditions:**
- Content must be impersonal (no personalized buy/sell signals)
- General circulation (not tailored to specific individuals)
- Regular schedule

If you ever add anything resembling personalized signals or move into paid advisory territory, consult a securities attorney.

---

## 4. Technical Architecture

### 4.1 Why NOT a pure client-side extension

Manifest V3 constraints make a pure client-side extension fragile:
- Service worker terminates after 30 seconds of inactivity, after 5 minutes per request, or if a fetch takes >30 seconds
- `chrome.alarms` throttled to minimum 30 seconds (was 60 seconds before Chrome 120)
- **Remote code execution is banned** — all logic must be bundled; fetching remote *data* (JSON) is explicitly permitted
- CORS issues fetching government sites directly from the browser
- More `host_permissions` = more friction in Web Store review

### 4.2 Recommended Architecture — Thin Client + Static Backend

```
┌─────────────────────────────────────────┐
│         Python Ingestion Job            │
│  (GitHub Actions cron, daily/weekly)    │
│                                         │
│  • FRED releases/dates (IDs 50,10,46,  │
│    53,54) w/ include_no_data=true       │
│  • federalreserve.gov FOMC calendar     │
│  • TreasuryDirect XML                   │
│  • Computed CME roll/expiry dates       │
│  • Normalize → UTC timestamps           │
└──────────────────┬──────────────────────┘
                   │ publishes
                   ▼
┌─────────────────────────────────────────┐
│     Static JSON on GitHub Pages /       │
│     Cloudflare (free tier)              │
│     calendar.json  (UTF-8, UTC)         │
│     + CORS headers you control          │
└──────────┬──────────────────┬───────────┘
           │                  │
           ▼                  ▼
┌──────────────────┐  ┌───────────────────┐
│  MV3 Chrome      │  │  ICS/Google Cal   │
│  Extension       │  │  Feed (.ics)      │
│                  │  │  (ship this first)│
│  React popup     │  └───────────────────┘
│  chrome.alarms   │
│  Notifications   │
│  tz-aware        │
└──────────────────┘
```

**Why this works:**
- Extension fetches one static JSON — no CORS issues, no live API calls from the browser
- CORS headers are set on your own CDN, not on government sites
- Minimal `host_permissions` (just your CDN domain) → easier Web Store review
- ICS feed is generated from the same JSON → zero extra maintenance
- GitHub Actions cron + GitHub Pages = $0 hosting through early scale

### 4.3 Timezone Handling
- Store all events in UTC in the JSON
- Convert to user's local browser timezone by default
- Allow timezone override (Mountain Time for Nate's use)
- Critical conversions to get right:
  - 8:30am ET → data releases (jobs, CPI, PPI, GDP, PCE)
  - 2:00pm ET → FOMC statement
  - 2:30pm ET → FOMC press conference
  - Handle DST transitions for ET (second Sunday in March, first Sunday in November)

### 4.4 Recommended Stack

| Layer | Tech | Rationale |
|---|---|---|
| Ingestion job | Python + Pandas + `requests` | Nate's existing skills |
| Static hosting | GitHub Pages or Cloudflare (free) | Zero cost, CORS-controllable |
| ICS generation | Python `icalendar` library | Simple, no dependencies |
| Extension popup | React (MV3 manifest) | Nate's existing skills |
| Background logic | `chrome.alarms` + service worker | MV3-compliant |
| Scheduling | GitHub Actions cron | Free, version-controlled |

---

## 5. Chrome Web Store / Distribution

| Item | Detail |
|---|---|
| Developer registration fee | $5 one-time, non-refundable, per account |
| Published item limit | 20 by default; increase available on request |
| Review timeline | Typically 1–3 business days for simple extensions |
| Privacy policy | Required — must be a real URL |
| Remote code | **Banned in MV3.** Fetching remote JSON *data* is fine; loading remote *logic* is not. |
| Permission justification | Must justify each `host_permissions` entry |
| Finance content | Allowed; gambling/prediction markets prohibited (not relevant here) |
| Monetization | Chrome Web Store Payments deprecated — use external payment processing if monetizing |

**Common rejection patterns to avoid:**
- Remote code execution (the "Blue Argon" rejection) — not a risk with static JSON architecture
- Overly broad `host_permissions` — mitigated by using your own CDN domain only
- Missing or vague privacy policy

---

## 6. Competitive Landscape

| Product | Has FOMC/CPI/Jobs | Has Futures Roll Dates | Has Treasury Auctions | Futures-trader focused | Local time notifications |
|---|---|---|---|---|---|
| TradingView calendar | ✅ | ❌ | Partial | ❌ Forex-first | ❌ |
| Investing.com widget | ✅ | ❌ | ❌ | ❌ Forex-first | ❌ |
| Forex Factory ICS | ✅ | ❌ | ❌ | ❌ Forex-first | ❌ |
| "Economic Calendar, Market & News" extension (4.3★) | ✅ | ❌ | ❌ | ❌ | Partial |
| **This product** | ✅ | ✅ | ✅ | ✅ | ✅ |

**Differentiation:** The combination of futures contract roll/expiration dates + U.S. macro releases + Treasury auctions + computed "typical move" educational context in one timezone-aware, trader-focused view is genuinely underserved.

---

## 7. Big Issues / Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Data licensing / redistribution** | 🔴 High | Use only government public-domain sources for the schedule; never redistribute ISM, U-Mich, ADP, or aggregator values commercially without a license |
| **Scraping fragility + government shutdowns** | 🟡 Medium | Prefer APIs (FRED/BLS/BEA/Treasury) over HTML scraping; build a "schedule may have changed" fallback; manual override layer for FOMC dates |
| **Accuracy liability (wrong time → trading loss)** | 🟡 Medium | Strong disclaimer; per-event "verify at official source" links; never present times as guaranteed |
| **Cost at scale (paid aggregators)** | 🟡 Medium | Keep MVP on free public data; only license consensus if monetization covers distribution-based pricing |
| **Annual maintenance burden** | 🟡 Medium | Automate ingestion job; add tests for CME holiday edge cases and DST transitions |
| **Chrome Web Store policy risk** | 🟢 Low | Avoid remote code; justify permissions; keep disclaimer visible |
| **Securities regulation exposure** | 🟢 Low | Stay impersonal + disclaimed; publisher's exclusion (Lowe v. SEC) applies |
| **BEA schedule instability** | 🟡 Medium | BEA cancelled releases during 2025 shutdown; cross-check BEA directly, don't rely solely on FRED |

---

## 8. Build Plan

### Phase 0 — Core data asset (≈1 weekend)
Build the Python ingestion job that outputs a normalized JSON for the next 12 months:
- FOMC meetings + SEP dates (hand-curated from federalreserve.gov, with scrape as check)
- FRED `releases/dates` for IDs 50, 10, 46, 53, 54 (with `include_release_dates_with_no_data=true`)
- TreasuryDirect XML for auction schedule and quarterly refunding dates
- Computed CME NQ/ES/MNQ/MES roll dates, expiration dates, and quad-witching dates
- All normalized to UTC timestamps with event metadata and generic impact tags

**This JSON is the crown jewel.** Everything else is a consumer of it.

### Phase 1 — ICS feed (≈1 additional day)
Generate a `.ics` file from the normalized JSON using the Python `icalendar` library. Publish to GitHub Pages. Share the subscribe link to validate demand before investing in the extension.

### Phase 2 — MV3 Chrome extension (≈2–3 weeks)
- React popup with upcoming events list, timezone selector, and event detail view
- `chrome.alarms` + notification API for advance warnings (e.g., 30 min and 5 min before each event)
- Fetch from GitHub Pages JSON; cache in `chrome.storage`
- Include FRED required attribution notice
- Include disclaimer on every view
- Submit to Chrome Web Store

### Phase 3 — Expansion
- Computed "typical move" educational context (from primary price data)
- PWA/web dashboard from the same backend
- Discord/Slack webhook alerts
- Optional: licensed consensus/forecast data if demand justifies cost

### Cost Model

| Item | Cost |
|---|---|
| Chrome Web Store registration | $5 one-time |
| GitHub Pages hosting | $0 |
| Custom domain (optional) | ~$12/year |
| GitHub Actions cron | $0 (within free tier) |
| Paid consensus data (if needed) | TBD — Trading Economics distribution pricing |
| **Total MVP** | **~$5** |

**Estimated effort:** 4–6 weekends to a polished v1.

---

## 9. Caveats

- The "typical move" statistics cited are from a single analyst's published analysis over a limited ~12-event window. Treat as illustrative; recompute from primary price data before publishing in-product.
- Aggregator free-tier limits and redistribution terms change frequently — re-verify each provider's ToS at build time (especially Finnhub's economic-calendar gating and Trading Economics' distribution pricing).
- FRED release-date coverage depends on upstream sources reporting to FRED. FRED notes that "release dates are published by data sources and do not necessarily represent when data will be available." Always cross-check FOMC and Treasury dates against primary government sites.
- The publisher's-exclusion analysis is general information, not legal advice. If you monetize heavily or add anything resembling personalized signals, consult a securities attorney.

---

*Last updated: July 2026. Research conducted for the Market Calendar Chrome Extension project.*
