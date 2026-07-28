# Feasibility & Execution Path: An Economic Calendar Chrome Extension for Traders

## TL;DR
- **Yes, it's clearly feasible.** The core scheduling data (FOMC, jobs, CPI/PPI, GDP/PCE, Treasury auctions, futures roll dates) is available for free from authoritative U.S. government sources whose *schedules* are non-copyrightable, public-domain facts. The single biggest risk is not the calendar itself but the "market effect / consensus forecast" layer, where the good data is paywalled and redistribution-restricted.
- **The best execution path is NOT a pure client-side Chrome extension.** Build a thin backend (a scheduled Python job that publishes one normalized static JSON to a CDN) that a lightweight Manifest V3 extension consumes — and publish a subscribable ICS/Google Calendar feed as the true "hero" distribution channel, since it reaches far more traders with far less maintenance than a browser extension alone.
- **Compute futures roll dates algorithmically** (they follow a deterministic CME rule), rely on FRED's `releases/dates` endpoint plus direct BLS/BEA/Fed/Treasury schedules for macro events, keep all "impact" commentary generic and impersonal to stay within the SEC publisher's exclusion, and put a prominent "not investment advice / verify times independently" disclaimer on everything.

## Key Findings

### "Schedule" data and "value/forecast" data are two different licensing worlds
The dates and times of releases are factual, government-origin data you can freely redistribute. The *consensus forecast* and *actual-vs-expected* numbers — the part that conveys "market effect" — are where the licensing traps are (ISM, University of Michigan, ADP, and aggregators like Trading Economics that restrict redistribution on cheap tiers). Design the product so the free, redistributable schedule is the backbone and any licensed value/forecast content is either omitted, shown as date-only, or properly licensed.

### FRED is your best single free backbone
The Federal Reserve Bank of St. Louis FRED API has a `fred/releases/dates` endpoint that returns **future/scheduled** release dates — but only if you set `include_release_dates_with_no_data=true`. The official docs state the default `false` value "excludes release dates that do not have data. In particular, this excludes future release dates which may be available in the FRED release calendar." When the flag is true, each `release_date` carries an extra `release_last_updated` attribute so you can distinguish a scheduled-but-unreleased date from one where data has posted. Set `sort_order=asc` and an appropriate `realtime_end` to see forward dates.

Rate limit: **FRED allows 30 requests/minute without a registered API key and 120 requests/minute with one** (the `fredr` R package source hardcodes the error string "the rate limit of 120 requests / minute"; exceeding it returns HTTP 429). No documented per-day cap. Confirmed release IDs you'll need: **Employment Situation = 50, CPI = 10, PPI = 46, GDP = 53, Personal Income & Outlays (PCE) = 54.** (Do not confuse release 11, which is the *Employment Cost Index*, with the monthly jobs report.)

FRED's copyright restrictions apply only to certain third-party data *series* (values marked with the word "Copyright" in their notes — e.g., S&P/Dow Jones indices), not to the release-date schedule. The releases you care about (BLS jobs/CPI/PPI, BEA GDP/PCE) are U.S. federal statistical products in the public domain, and factual release dates are not copyrightable. You may redistribute the schedule to end users — provided you meet FRED's requirements: display the verbatim notice **"This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis,"** don't use FRED/ALFRED/Federal Reserve marks in your branding or hostname, don't build an app that "replicates or attempts to replace the essential user experience" of FRED, and link users to the FRED API Terms of Use.

### Futures roll dates are computed, not fetched
Per CME Group's official "Equity Index Roll Dates" page: *"Equity products roll date is the Monday prior to the third Friday of the expiration month. After the roll date, it is customary to identify the second nearest expiration month as the 'lead month.'"* That is CME's official *listing-change* date. The **liquidity roll that traders actually act on is the second Thursday before the third Friday** (≈8 calendar days before expiry), when volume/open interest migrates to the back month. Quarterly cycle: Mar (H), Jun (M), Sep (U), Dec (Z); contracts expire the third Friday of the delivery month. All of this is deterministic — you compute it in code with no API or license needed. This applies equally to /NQ and the /MNQ micros he trades.

### Manifest V3 constrains background work (but not fatally)
Per Chrome for Developers, the extension service worker terminates "after 30 seconds of inactivity," when "a single request… takes longer than 5 minutes to process," or when "a fetch() response takes more than 30 seconds to arrive." `chrome.alarms` is throttled: "Chrome limits alarms to at most once every 30 seconds… Before Chrome 120, this limit was one minute." **Remotely-hosted code is banned** — all logic must be bundled in the package; you may fetch remote *data* (JSON) but not remote *logic*. This is precisely why a thin-extension + static-JSON-backend architecture is the correct pattern: the extension only fetches data and ships all logic in-package.

### Regulatory exposure is low if you stay generic
Providing impersonal, general-circulation commentary on economic data falls under the "publisher's exclusion" of Section 202(a)(11)(D) of the Investment Advisers Act. In **Lowe v. SEC, 472 U.S. 181 (1985)**, the Supreme Court held the exclusion covers "the publisher of any bona fide newspaper, news magazine or business or financial publication of general and regular circulation," reasoning that "Because the content of petitioners' newsletters was completely disinterested and because they were offered to the general public on a regular schedule, they are described by the plain language of [the] exclusion." As long as you never give personalized buy/sell advice, you are a publisher, not an adviser. Still, use a clear "informational/educational purposes only, not investment advice" disclaimer.

### The competitive gap is real
TradingView, Investing.com, Forex Factory, and Myfxbook all have economic calendars (some with Chrome extensions and embeddable widgets), and there's an existing "Economic Calendar, Market & News" Chrome extension rated 4.3★. But they're forex-centric, and none cleanly combine **futures contract roll/expiration dates + U.S. macro releases + Treasury auctions** in one trader-focused, timezone-aware (Mountain Time) view. That combination — plus honest "typical move" educational context — is the differentiation.

## Details

### 1. Data sources by category

**FOMC meetings + SEP/projection meetings + press conferences** — federalreserve.gov publishes the FOMC calendar in HTML (`fomccalendars.htm`); no clean JSON, but the Fed offers RSS feeds. Only 8 meetings/year; the Summary of Economic Projections is released at 4 (Mar/Jun/Sep/Dec), the statement at 2:00pm ET and the press conference at 2:30pm ET. Given the tiny, stable volume, hand-curate annually and scrape as a check. Public domain.

**BLS Employment Situation, CPI, PPI** — BLS publishes annual schedules (HTML/PDF) at bls.gov/schedule and offers the free **BLS Public Data API** (JSON; registration encouraged; open for public use; U.S. government work with no redistribution restriction). Employment Situation and CPI release at 8:30am ET. Also reachable via FRED release IDs 50/10/46.

**BEA (GDP, PCE / Personal Income & Outlays)** — bea.gov/news/schedule; free **BEA API** (JSON). PCE is the Fed's preferred inflation gauge, released in the Personal Income and Outlays report (8:30am ET). FRED IDs 53/54. Public domain.

**Census (retail sales, durable goods)** — Census release schedule + free Census API; public domain.

**ISM PMI (Manufacturing/Services)** — ⚠️ **PRIVATE org with a restrictive license**: "ISM hereby grants you a limited, revocable, nonsublicensable license to access and display… solely for your personal, non-commercial use." You may show the *date* (a fact) but must NOT redistribute ISM's values/content commercially. Releases ~1st (Manufacturing) and 3rd (Services) business day of the month.

**University of Michigan sentiment, ADP employment** — private sources; treat exactly like ISM (date is fine, values are licensed). ADP National Employment Report publishes two days before the BLS jobs report.

**Treasury auctions + quarterly refunding** — TreasuryDirect publishes the Tentative Auction Schedule in PDF and **XML**; data.gov lists it under **Creative Commons CC0** (public domain, "intended for public access and use"). Quarterly refunding announcements fall on the first Wednesday of Feb/May/Aug/Nov. A TreasuryDirect API is also available.

**Futures roll/expiration (CME NQ/ES + MNQ/MES micros)** — computed algorithmically (see Key Findings). Quad witching = third Friday of Mar/Jun/Sep/Dec; monthly OPEX = third Friday. Crude (CL) rolls monthly — different cadence — if you ever add it. No license needed for computed dates.

**OPEC, mega-cap earnings, Fed speakers** — OPEC meeting dates from opec.org; index-mover earnings dates from Finnhub/FMP free tiers (verify redistribution); Fed speaker calendar and Chair pressers from the federalreserve.gov events calendar.

**Third-party aggregator APIs (for the forecast/consensus/actual layer):**
- **FRED** — free; 30 req/min without a key, 120 with one; best for schedule + actual values (public-domain series); no consensus forecasts.
- **Finnhub** — free tier 60 calls/min; has an economic-calendar endpoint, but the economic calendar has historically been gated to paid plans; verify redistribution terms before shipping to end users.
- **Trading Economics** — the best calendar with consensus forecasts ("survey consensus figures… the average forecast among a representative group of economists"), reachable via a heavily-limited `guest:guest` tier for testing; but paid API pricing scales with your *volume and distribution*, and terms restrict redistribution — expensive against a free user base.
- **Forex Factory** — exports the current week as ICS/CSV/JSON/XML and has a widely-used unofficial JSON feed, but its ToS does not authorize commercial redistribution and scraping is fragile/legally gray.
- **FMP, Marketaux, Alpha Vantage, Nasdaq Data Link** — assorted free tiers; all require careful reading of redistribution terms before use.

### 2. The "market effect" layer
Consensus/forecast plus prior values are the paywalled part; the *deviation* between forecast and actual — not the absolute number — drives the immediate move. For a free, redistributable product you have two honest options:

1. **Skip live consensus** and show *static, educational* context you compute yourself: e.g., the historical average absolute move. Documented illustrative figures (Russell Rhoads, over a ~12-event window): SPX averaged ±0.64% on CPI days and ±1.19% on FOMC days; NDX (directly relevant to /NQ) averaged ±0.98% on CPI days and ±1.67% on FOMC days. Academic work (ScienceDirect study of VIX around FOMC/PPI/CPI; NBER working paper w28306 on event-day options) confirms implied volatility rises into FOMC/employment/CPI and drops afterward. This is your differentiator and it's redistributable if computed from your own price data.
2. **License consensus** from Trading Economics if you're willing to pay distribution-based pricing.

**Regulatory:** stay impersonal and you're a publisher, not an adviser (Lowe v. SEC). Suggested disclaimer: *"For informational and educational purposes only. Not investment advice. Times are subject to change; verify against official sources before trading."*

### 3. Technical execution path
**MV3 realities:** non-persistent service workers (30s idle / 5-min hard cap), `chrome.alarms` ≥30s, no remote code. The Notifications API works, but the service worker must be alive to fire; use `chrome.alarms` to wake it, read from `chrome.storage`, and fire notifications. Don't rely on the SW for long-running fetches.

**Recommended architecture — thin client + static backend:**
- A **Python job** (leans on his Pandas skills) runs daily on a scheduler (GitHub Actions cron, Cloudflare Workers Cron, or a small Supabase/Render task). It pulls FRED `releases/dates` (with `include_release_dates_with_no_data=true`), BLS/BEA/Treasury schedules, computes CME roll/expiry dates, normalizes everything into one JSON (UTC timestamps + event metadata + generic impact tags), and publishes it to a CDN / GitHub Pages / Cloudflare KV.
- The **MV3 extension** just fetches that one static JSON. Because you control the host, you set CORS headers yourself and never hit government sites directly from the browser — this sidesteps CORS problems and minimizes `host_permissions`, which eases Chrome Web Store review. It caches to `chrome.storage`, renders a React popup, and schedules `chrome.alarms` + notifications.
- **Timezone handling:** store everything in UTC; convert to the user's local zone (default to the browser zone, allow override for his Mountain Time). Convert carefully for 8:30am ET data, 2:00pm ET FOMC statement, and 2:30pm ET presser, accounting for DST transitions.

**Alternatives/complements (important):** a **subscribable ICS / Google Calendar feed** is arguably the single best distribution vehicle — it works on every phone and desktop calendar, needs no store review, and is trivially generated from the same JSON. A PWA and a Discord/Slack webhook bot are cheap add-ons from the same backend. **Recommendation: ship the ICS feed first** (fastest value, widest reach), then the Chrome extension for the always-on popup/notification experience.

**Stack given his skills:** Python/Pandas for ingestion; static JSON on GitHub Pages or Cloudflare (free tiers); React for the extension popup; optionally Streamlit or a static site for a web dashboard.

### 4. Chrome Web Store / distribution
- One-time **$5 developer fee** (non-refundable, per account, covers all your extensions).
- Per the Chrome Web Store Developer FAQ: "You can upload as many items… as you like, but by default, you are limited to having a total of **20 published items** at any one time… you may request a limit increase."
- Review typically **1–3 business days** for simple extensions.
- **Privacy policy URL required**; you must justify each permission and request minimal `host_permissions`.
- **Remote code execution is banned in MV3** (the "Blue Argon" rejection). You cannot ship dynamically-loaded logic; fetching remote JSON *data* is explicitly fine. This is fully compatible with the recommended architecture.
- Finance extensions are allowed; gambling/prediction-market content is prohibited (irrelevant here). Keep the disclaimer visible to build user and reviewer trust. Note Chrome Web Store Payments is deprecated — use external payment processing if you ever monetize.

### 5. Competitive landscape
Existing players: TradingView calendar (plus embeddable widget), Investing.com widget, Forex Factory (ICS/JSON export), Myfxbook Chrome extension, and the "Economic Calendar, Market & News" extension (4.3★, 21 regions). Most are forex-first, and none integrate **futures roll dates + macro releases + Treasury auctions** into a single U.S.-futures-trader view with local-time notifications. That integration, plus computed "typical move" context, is where a new product wins.

### 6. Big issues / risks (bluntly)
1. **Data licensing/redistribution is the #1 risk.** Government schedules = safe. ISM, U-Mich, ADP values and aggregator consensus data = restricted. Never redistribute ISM or paid-aggregator content commercially; show date-only for licensed sources, or license properly.
2. **Scraping fragility + government shutdowns.** Gov sites change layouts and schedules shift — BEA rescheduled and even cancelled GDP/Personal Income releases around the 2025 shutdown. Prefer APIs (FRED/BLS/BEA/Treasury) over HTML scraping; build a "schedule may have changed" fallback and a manual-override layer.
3. **Accuracy liability.** A wrong time could cause a trading loss. Mitigate with a strong disclaimer, per-event "verify at official source" links, and never presenting times as guaranteed.
4. **Cost at scale.** FRED/BLS/BEA/Treasury are free. The cost bomb is paid aggregators with distribution-based pricing (Trading Economics) against a free user base. Keep the free product on free public data.
5. **Maintenance burden.** Annual schedule refreshes, CME holiday edge cases, DST. Automate the ingestion job and add tests.
6. **Chrome Web Store policy risk.** Low if you avoid remote code and justify permissions.
7. **Securities-regulation exposure.** Low under the publisher's exclusion if impersonal + disclaimed.

## Recommendations

**Phase 0 — validate the core asset (≈1 weekend):** Build the Python ingestion job that outputs a normalized JSON of FOMC/SEP, BLS jobs/CPI/PPI, BEA GDP/PCE, Treasury auctions, and computed CME NQ/ES/MNQ roll + quad-witching dates for the next 12 months. This is the crown jewel and proves feasibility end-to-end.

**Phase 1 — fastest reach (≈1 week):** Generate a subscribable ICS feed from that JSON and publish it. Zero store review, works on every calendar app, immediate value. Share it to validate demand before investing in the extension.

**Phase 2 — the extension (≈2–3 weeks):** Build the MV3 Chrome extension (React popup + `chrome.alarms` notifications) consuming the same JSON. Add timezone selection defaulting to the browser zone. Ship with the "not investment advice" disclaimer and the required FRED notice. Submit to the Web Store (expect 1–3 day review).

**Phase 3 — expansion:** Add computed "typical move" educational context (from your own price data), a PWA/web dashboard, and optional Discord/Slack alerts from the same backend. Only license paid consensus data if users demand it and you have monetization to cover distribution-based pricing.

**Benchmarks that change the plan:** If demand is strong and users insist on live consensus/forecast, evaluate a paid Trading Economics distribution license — this is the point where costs turn non-trivial. If Web Store permission review proves frictional, lean harder on the ICS feed and a PWA.

**Rough cost model:** $5 one-time (Web Store) + $0–20/month hosting (GitHub Pages / Cloudflare free tiers cover early scale) + optional domain (~$12/yr) for a verified-publisher badge. Paid data only if you choose to license consensus. Effort estimate: ~4–6 weekends to a polished v1.

## Caveats
- The "typical move" statistics cited come partly from a single analyst's published analysis over a limited ~12-event window; treat them as illustrative, not definitive, and recompute from primary price data before publishing them in-product.
- Aggregator free-tier limits and redistribution terms change frequently — re-verify each provider's ToS at build time (Finnhub's economic-calendar gating and Trading Economics' distribution pricing especially).
- FRED release-date coverage depends on upstream sources reporting to FRED, and FRED notes that "release dates are published by data sources and do not necessarily represent when data will be available"; always cross-check FOMC and Treasury dates against the primary government sites.
- The publisher's-exclusion analysis is general information, not legal advice. If you monetize heavily or add anything resembling personalized signals, consult a securities attorney.