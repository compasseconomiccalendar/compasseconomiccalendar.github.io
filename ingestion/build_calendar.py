#!/usr/bin/env python3
"""Build the Compass Economic Calendar normalized event feed.

Pulls five sources into a single ``output/calendar.json``:

  1. FOMC meetings, statements, press conferences, SEP releases and minutes
     (scraped from federalreserve.gov, with a manual override layer)
  2. Macro release dates from the FRED API (jobs, CPI, PPI, GDP, PCE, jobless
     claims, retail sales, factory orders, JOLTS)
  3. Treasury auctions + computed quarterly refunding announcements
     (TreasuryDirect web service)
  4. CME equity-index futures roll / expiration / quad-witching dates
     (computed algorithmically -- no API needed)
  5. ISM PMI dates, computed from the published pattern and flagged
     ``approximate`` because ISM publishes no machine-readable schedule

Events are then annotated with typical-move context from
``data/typical_moves.json`` when that file is present.

The BEA schedule page is then used to sharpen the GDP releases FRED reports
under a single name, so the advance estimate is not rated the same as the
third estimate. BLS is deliberately not scraped: it returns HTTP 403 and
prohibits automated retrieval in its usage policy.

Every timestamp is stored in UTC. Eastern-time release times are converted
through the IANA ``America/New_York`` zone so DST is handled correctly.

Usage:
    python ingestion/build_calendar.py
    python ingestion/build_calendar.py --months 18 --out output/calendar.json
    python ingestion/build_calendar.py --skip-fred      # no API key needed

See docs/RESEARCH.md for the sourcing and licensing rationale.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

SCHEMA_VERSION = "1.0.0"

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "output" / "calendar.json"
OVERRIDES_PATH = REPO_ROOT / "data" / "overrides.json"

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

USER_AGENT = (
    "CompassEconomicCalendar/1.0 "
    "(+https://github.com/compasseconomiccalendar/compasseconomiccalendar)"
)
HTTP_TIMEOUT = 30

FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
FRED_API_BASE = "https://api.stlouisfed.org/fred"
TREASURY_BASE = "https://www.treasurydirect.gov/TA_WS/securities"

# Verbatim, required by the FRED API terms of use. Do not reword.
FRED_ATTRIBUTION = (
    "This product uses the FRED® API but is not endorsed or certified "
    "by the Federal Reserve Bank of St. Louis."
)
FRED_TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html"

DISCLAIMER = (
    "For informational and educational purposes only. Not investment advice. "
    "Times are subject to change; verify against official sources before trading."
)

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# Releases are matched against FRED's own release names rather than trusting a
# hardcoded number. `release_id` where present is an assertion: if FRED's id for
# that name ever differs, the build fails instead of silently pulling the wrong
# release. Releases without an id are resolved at build time.
#
# Release ID 11 is the Employment Cost Index -- it is NOT the monthly jobs
# report (that is 50). See docs/RESEARCH.md 1.2.
FRED_RELEASES = [
    {
        "slug": "employment-situation",
        "release_id": 50,
        "match": r"^Employment Situation$",
        "title": "Employment Situation (Nonfarm Payrolls)",
        "time_et": "08:30",
        "market_impact": "high",
        "primary_source": "https://www.bls.gov/schedule/news_release/empsit.htm",
        "note": (
            "Monthly jobs report from the BLS: nonfarm payrolls, unemployment "
            "rate and average hourly earnings. Typically the highest-volatility "
            "scheduled release of the month for index futures."
        ),
    },
    {
        "slug": "cpi",
        "release_id": 10,
        "match": r"^Consumer Price Index$",
        "title": "Consumer Price Index (CPI)",
        "time_et": "08:30",
        "market_impact": "high",
        "primary_source": "https://www.bls.gov/schedule/news_release/cpi.htm",
        "note": (
            "Headline and core consumer inflation from the BLS. The core "
            "month-over-month print drives the immediate rates and equity "
            "reaction."
        ),
    },
    {
        "slug": "ppi",
        "release_id": 46,
        "match": r"^Producer Price Index$",
        "title": "Producer Price Index (PPI)",
        "time_et": "08:30",
        "market_impact": "medium",
        "primary_source": "https://www.bls.gov/schedule/news_release/ppi.htm",
        "note": (
            "Wholesale/producer inflation from the BLS. Watched as a lead-in to "
            "CPI and for the PPI components that feed the PCE calculation."
        ),
    },
    {
        "slug": "gdp",
        "release_id": 53,
        "match": r"^Gross Domestic Product$",
        "title": "Gross Domestic Product (GDP)",
        "time_et": "08:30",
        "market_impact": "medium",
        "primary_source": "https://www.bea.gov/news/schedule",
        "note": (
            "Quarterly output from the BEA, released in advance, second and "
            "third estimates. The advance estimate is the market-moving one."
        ),
    },
    {
        "slug": "pce",
        "release_id": 54,
        "match": r"^Personal Income and Outlays$",
        "title": "Personal Income & Outlays (PCE)",
        "time_et": "08:30",
        "market_impact": "high",
        "primary_source": "https://www.bea.gov/news/schedule",
        "note": (
            "BEA report containing core PCE, the Fed's preferred inflation "
            "gauge. Watched closely into FOMC meetings."
        ),
    },
    {
        "slug": "jobless-claims",
        # Anchored: there is also a "State Unemployment Insurance Weekly Claims
        # Report", and the national one is what moves markets.
        "match": r"^Unemployment Insurance Weekly Claims Report$",
        "title": "Initial Jobless Claims",
        "time_et": "08:30",
        "market_impact": "medium",
        "primary_source": "https://www.dol.gov/ui/data.pdf",
        "note": (
            "Weekly initial and continuing unemployment claims, released every "
            "Thursday at 8:30am ET. The highest-frequency read on the labour "
            "market; the four-week average is what traders watch for a trend."
        ),
    },
    {
        "slug": "retail-sales",
        "match": r"Advance Monthly Sales for Retail",
        "title": "Retail Sales (Advance)",
        "time_et": "08:30",
        "market_impact": "high",
        "primary_source": "https://www.census.gov/retail/index.html",
        "note": (
            "Census Bureau advance estimate of monthly retail and food service "
            "sales. Consumer spending is roughly two-thirds of GDP, so the "
            "control-group figure moves growth expectations and index futures."
        ),
    },
    {
        "slug": "factory-orders",
        # FRED carries no release named "Durable Goods" -- the Census figures
        # arrive under the M3 survey name, which is the full factory orders
        # report. The advance durable goods report lands a couple of days
        # earlier and is not separately scheduled on FRED.
        "match": r"Shipments, Inventories, and Orders \(M3\)",
        "title": "Factory Orders (M3)",
        "time_et": "10:00",
        "market_impact": "medium",
        "primary_source": "https://www.census.gov/manufacturing/m3/index.html",
        "note": (
            "Census Bureau M3 survey: shipments, inventories and new orders for "
            "manufactured goods, released at 10:00am ET. Core capital goods "
            "orders are read as a proxy for business investment intentions. The "
            "advance durable goods report precedes this by a few days."
        ),
    },
    {
        "slug": "jolts",
        "match": r"Job Openings and Labor Turnover",
        "title": "JOLTS Job Openings",
        "time_et": "10:00",
        "market_impact": "medium",
        "primary_source": "https://www.bls.gov/schedule/news_release/jolts.htm",
        "note": (
            "BLS survey of job openings, hires and quits, released at 10:00am ET "
            "-- note the later time than most BLS releases. The openings-to-"
            "unemployed ratio is a labour-market tightness gauge the Fed cites."
        ),
    },
]

# BEA publishes its own schedule page, which distinguishes the three GDP
# estimates that FRED release 53 lumps together. Only the advance estimate
# really moves the market, so this is used to sharpen market_impact rather
# than to add events. Note it buys no extra forward coverage -- BEA's page
# ends on the same date FRED's last GDP entry does.
BEA_SCHEDULE_URL = "https://www.bea.gov/news/schedule"

# (needle in the BEA release title, variant tag, market impact)
GDP_VARIANTS = (
    ("advance estimate", "advance", "high"),
    ("second estimate", "second", "medium"),
    ("third estimate", "third", "low"),
)
GDP_VARIANT_NOTES = {
    "advance": (
        "First (advance) estimate of quarterly GDP from the BEA. The advance "
        "print is the market-moving one -- it is the first read on the quarter."
    ),
    "second": (
        "Second estimate of quarterly GDP, incorporating more complete source "
        "data. Revisions are usually small and the reaction is muted."
    ),
    "third": (
        "Third estimate of quarterly GDP. The quarter is three months stale by "
        "now; this rarely moves index futures."
    ),
}

# CME equity-index futures on the quarterly cycle.
FUTURES_SYMBOLS = ["ES", "NQ", "MES", "MNQ"]
QUARTERLY_MONTHS = {3: "H", 6: "M", 9: "U", 12: "Z"}

TREASURY_IMPACT = {
    "Bill": "low",
    "Note": "medium",
    "Bond": "high",
    "TIPS": "medium",
    "FRN": "low",
    "CMB": "low",
}
# Long-end supply moves the curve; treat these terms as high impact.
TREASURY_HIGH_IMPACT_TERMS = {"10-Year", "20-Year", "30-Year"}


# --------------------------------------------------------------------------
# Time helpers
# --------------------------------------------------------------------------

def et_to_utc(day: date, hhmm: str) -> datetime:
    """Convert a wall-clock Eastern time on ``day`` to an aware UTC datetime.

    Uses the IANA zone rather than a fixed offset so the March/November DST
    transitions are handled correctly (8:30am ET is 12:30 UTC in summer and
    13:30 UTC in winter).
    """
    hour, minute = (int(part) for part in hhmm.split(":"))
    local = datetime.combine(day, time(hour, minute), tzinfo=ET)
    return local.astimezone(UTC)


def iso_z(moment: datetime) -> str:
    """Render an aware datetime as an ISO 8601 string with a trailing Z."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """Return the nth ``weekday`` (Mon=0) of a month, e.g. the 3rd Friday."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def third_friday(year: int, month: int) -> date:
    return nth_weekday(year, month, weekday=4, n=3)


def first_wednesday(year: int, month: int) -> date:
    return nth_weekday(year, month, weekday=2, n=1)


def easter_sunday(year: int) -> date:
    """Anonymous Gregorian computus."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    lam = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * lam) // 451
    month = (h + lam - 7 * m + 114) // 31
    day = ((h + lam - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def good_friday(year: int) -> date:
    return easter_sunday(year) - timedelta(days=2)


def _observed(day: date) -> date:
    """Federal holidays falling on a weekend are observed on the nearest weekday."""
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def last_weekday(year: int, month: int, weekday: int) -> date:
    """The last given weekday of a month, e.g. the last Monday in May."""
    if month == 12:
        last_day = date(year, 12, 31)
    else:
        last_day = date(year, month + 1, 1) - timedelta(days=1)
    return last_day - timedelta(days=(last_day.weekday() - weekday) % 7)


def us_federal_holidays(year: int) -> set:
    """The eleven federal holidays, as observed. Markets and agencies are shut."""
    return {
        _observed(date(year, 1, 1)),                      # New Year's Day
        nth_weekday(year, 1, weekday=0, n=3),             # MLK Day
        nth_weekday(year, 2, weekday=0, n=3),             # Presidents' Day
        last_weekday(year, 5, weekday=0),                 # Memorial Day
        _observed(date(year, 6, 19)),                     # Juneteenth
        _observed(date(year, 7, 4)),                      # Independence Day
        nth_weekday(year, 9, weekday=0, n=1),             # Labor Day
        nth_weekday(year, 10, weekday=0, n=2),            # Columbus Day
        _observed(date(year, 11, 11)),                    # Veterans Day
        nth_weekday(year, 11, weekday=3, n=4),            # Thanksgiving
        _observed(date(year, 12, 25)),                    # Christmas Day
    }


def nth_business_day(year: int, month: int, n: int) -> date:
    """The nth weekday of a month that is not a federal holiday."""
    holidays = us_federal_holidays(year)
    day = date(year, month, 1)
    count = 0
    while True:
        if day.weekday() < 5 and day not in holidays:
            count += 1
            if count == n:
                return day
        day += timedelta(days=1)


def parse_date(value: Optional[str]) -> Optional[date]:
    """Parse the date-ish strings the upstream feeds hand back."""
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if "T" in text:
        text = text.split("T", 1)[0]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_clock(value: Optional[str]) -> Optional[str]:
    """Normalize TreasuryDirect's ``11:30 AM`` style strings to ``HH:MM``."""
    if not value:
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$", value)
    if not match:
        return None
    hour, minute, meridiem = int(match.group(1)), match.group(2), match.group(3).lower()
    if meridiem == "p" and hour != 12:
        hour += 12
    if meridiem == "a" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute}"


# --------------------------------------------------------------------------
# Event construction
# --------------------------------------------------------------------------

def make_event(
    *,
    event_id: str,
    event_type: str,
    title: str,
    day: date,
    time_et: Optional[str],
    market_impact: str,
    source: str,
    source_url: str,
    note: str,
    duration_minutes: int = 30,
    **extra: Any,
) -> Dict[str, Any]:
    """Build one normalized event record.

    ``time_et`` of ``None`` produces an all-day event anchored at 00:00 UTC on
    the given date, which is how the ICS writer decides between a DATE and a
    DATE-TIME value.
    """
    if time_et is None:
        start = datetime.combine(day, time(0, 0), tzinfo=UTC)
        all_day = True
    else:
        start = et_to_utc(day, time_et)
        all_day = False

    event: Dict[str, Any] = {
        "id": event_id,
        "event_type": event_type,
        "title": title,
        "start_utc": iso_z(start),
        "end_utc": iso_z(start + timedelta(minutes=duration_minutes)) if not all_day else None,
        "all_day": all_day,
        "date_et": day.isoformat(),
        "time_et": time_et,
        "market_impact": market_impact,
        "source": source,
        "source_url": source_url,
        "note": note,
    }
    event.update(extra)
    return event


# --------------------------------------------------------------------------
# Source 1: FOMC
# --------------------------------------------------------------------------

def _parse_fomc_row_dates(year: int, month_text: str, date_text: str) -> Optional[Tuple[date, date]]:
    """Resolve one calendar row's month/day cells into (start, end) dates.

    Handles the two shapes the Fed publishes:
      ``March`` + ``17-18*``       -> single-month, two-day meeting
      ``Apr/May`` + ``30-1``       -> meeting spanning a month boundary
    """
    month_names = [part.strip().lower().rstrip(".") for part in month_text.split("/") if part.strip()]
    months = [MONTHS[name] for name in month_names if name in MONTHS]
    if not months:
        return None

    # Strip the SEP asterisk and any parenthetical such as "(notation vote)".
    cleaned = re.sub(r"\([^)]*\)", " ", date_text)
    days = [int(match) for match in re.findall(r"\d{1,2}", cleaned)]
    if not days:
        return None

    start_month = months[0]
    end_month = months[-1]
    start_year = year
    end_year = year
    # A Dec/Jan row rolls into the following year.
    if end_month < start_month:
        end_year = year + 1

    try:
        start = date(start_year, start_month, days[0])
        end = date(end_year, end_month, days[-1])
    except ValueError:
        return None
    if end < start:
        return None
    return start, end


def fetch_fomc_events(session: requests.Session, window: Tuple[date, date]) -> List[Dict[str, Any]]:
    """Scrape the FOMC calendar page for meetings, statements and pressers.

    docs/RESEARCH.md recommends hand-curating this small dataset with the
    scrape as a check; data/overrides.json provides that manual layer.
    """
    response = session.get(FOMC_URL, timeout=HTTP_TIMEOUT)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    events: List[Dict[str, Any]] = []
    start_bound, end_bound = window

    for panel in soup.select("div.panel"):
        heading = panel.select_one(".panel-heading")
        if not heading:
            continue
        year_match = re.search(r"(\d{4})\s+FOMC Meetings", heading.get_text(" ", strip=True))
        if not year_match:
            continue
        year = int(year_match.group(1))

        for row in panel.select("div.row.fomc-meeting"):
            month_cell = row.select_one(".fomc-meeting__month")
            date_cell = row.select_one(".fomc-meeting__date")
            if not month_cell or not date_cell:
                continue

            month_text = month_cell.get_text(" ", strip=True)
            date_text = date_cell.get_text(" ", strip=True)
            parsed = _parse_fomc_row_dates(year, month_text, date_text)
            if not parsed:
                print(f"  ! could not parse FOMC row: {month_text!r} {date_text!r}", file=sys.stderr)
                continue
            meeting_start, meeting_end = parsed

            row_text = row.get_text(" ", strip=True)
            # The asterisk on the date is the Fed's own SEP marker; fall back to
            # the Mar/Jun/Sep/Dec convention if the page drops it.
            has_star = "*" in date_text
            has_projections = "Projection Materials" in row_text
            is_sep = has_star or has_projections or meeting_end.month in QUARTERLY_MONTHS
            sep_signal = (
                "asterisk" if has_star
                else "projection-materials" if has_projections
                else "quarterly-month-heuristic"
            )
            is_notation_vote = "notation vote" in row_text.lower()
            # The Chair has held a press conference after every meeting since
            # 2019, but the page only links one once it has been scheduled --
            # so the link is a confirmation signal, not a precondition.
            presser_confirmed = "Press Conference" in row_text
            is_multi_day = meeting_end > meeting_start

            # The meeting itself may sit outside the window while its minutes
            # (released ~3 weeks later) land inside it, so both are checked
            # against the window independently.
            slug = meeting_end.isoformat()

            if start_bound <= meeting_end <= end_bound and not is_notation_vote:
                if is_multi_day and start_bound <= meeting_start <= end_bound:
                    events.append(make_event(
                        event_id=f"fomc-meeting-day1-{meeting_start.isoformat()}",
                        event_type="fomc_meeting_day_1",
                        title="FOMC Meeting Begins (Day 1)",
                        day=meeting_start,
                        time_et=None,
                        market_impact="low",
                        source="federalreserve.gov",
                        source_url=FOMC_URL,
                        note=(
                            "First day of the two-day FOMC meeting. No statement "
                            "is released today; the decision comes tomorrow at "
                            "2:00pm ET."
                        ),
                        meeting_start_date=meeting_start.isoformat(),
                        meeting_end_date=meeting_end.isoformat(),
                    ))

                events.append(make_event(
                    event_id=f"fomc-statement-{slug}",
                    event_type="fomc_statement",
                    title="FOMC Statement & Rate Decision",
                    day=meeting_end,
                    time_et="14:00",
                    market_impact="high",
                    source="federalreserve.gov",
                    source_url=FOMC_URL,
                    note=(
                        "Interest rate decision and policy statement released at "
                        "2:00pm ET. Expect a sharp repricing in index futures on "
                        "the release and again during the 2:30pm press conference."
                    ),
                    meeting_start_date=meeting_start.isoformat(),
                    meeting_end_date=meeting_end.isoformat(),
                    has_sep=is_sep,
                ))

                if is_sep:
                    events.append(make_event(
                        event_id=f"fomc-sep-{slug}",
                        event_type="fomc_sep",
                        title="FOMC Summary of Economic Projections (Dot Plot)",
                        day=meeting_end,
                        time_et="14:00",
                        market_impact="high",
                        source="federalreserve.gov",
                        source_url=FOMC_URL,
                        note=(
                            "Quarterly Summary of Economic Projections, including "
                            "the dot plot of participants' rate expectations, "
                            "published alongside the 2:00pm ET statement."
                        ),
                        sep_signal=sep_signal,
                    ))

                events.append(make_event(
                    event_id=f"fomc-presser-{slug}",
                    event_type="fomc_press_conference",
                    title="FOMC Chair Press Conference",
                    day=meeting_end,
                    time_et="14:30",
                    market_impact="high",
                    source="federalreserve.gov",
                    source_url=FOMC_URL,
                    note=(
                        "Chair's press conference begins at 2:30pm ET. The Q&A "
                        "regularly moves markets more than the statement itself."
                        + ("" if presser_confirmed else
                           " Not yet confirmed on the Fed's calendar; a presser has "
                           "followed every meeting since 2019.")
                    ),
                    duration_minutes=60,
                    confirmed=presser_confirmed,
                ))

            # Minutes for a past meeting are released three weeks later at
            # 2:00pm ET and are themselves a scheduled market event.
            minutes_match = re.search(r"\(Released\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\)", row_text)
            if minutes_match:
                month_name = minutes_match.group(1).lower()
                if month_name in MONTHS:
                    minutes_day = date(
                        int(minutes_match.group(3)), MONTHS[month_name], int(minutes_match.group(2))
                    )
                    if start_bound <= minutes_day <= end_bound:
                        events.append(make_event(
                            event_id=f"fomc-minutes-{minutes_day.isoformat()}",
                            event_type="fomc_minutes",
                            title=f"FOMC Minutes ({meeting_end.strftime('%b %d')} meeting)",
                            day=minutes_day,
                            time_et="14:00",
                            market_impact="medium",
                            source="federalreserve.gov",
                            source_url=FOMC_URL,
                            note=(
                                "Minutes of the prior FOMC meeting, released at "
                                "2:00pm ET roughly three weeks after the decision."
                            ),
                            meeting_end_date=meeting_end.isoformat(),
                        ))

    return events


# --------------------------------------------------------------------------
# Source 2: FRED
# --------------------------------------------------------------------------

def resolve_fred_release_ids(
    session: requests.Session, api_key: str
) -> List[Tuple[int, Dict[str, Any]]]:
    """Map each configured release onto FRED's own release list by name.

    Hardcoding numeric ids is how you silently end up publishing the wrong
    release (id 11 is the Employment Cost Index, not the jobs report). So the
    ids are resolved from the names FRED reports, and any ``release_id`` in the
    config is treated as an assertion rather than an input.
    """
    response = session.get(
        f"{FRED_API_BASE}/releases",
        params={"api_key": api_key, "file_type": "json", "limit": 1000},
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    catalogue = response.json().get("releases", [])
    if not catalogue:
        raise RuntimeError("FRED returned an empty release catalogue")

    resolved: List[Tuple[int, Dict[str, Any]]] = []
    problems: List[str] = []

    for meta in FRED_RELEASES:
        pattern = re.compile(meta["match"], re.IGNORECASE)
        matches = [
            entry for entry in catalogue if pattern.search(entry.get("name", ""))
        ]

        if not matches:
            # Suggest near misses so a wrong pattern is diagnosable from the
            # failure alone, without another round trip.
            words = {
                word.lower()
                for word in re.findall(r"[A-Za-z]{5,}", meta["match"])
            }
            near = [
                entry["name"]
                for entry in catalogue
                if words & {w.lower() for w in re.findall(r"[A-Za-z]{5,}", entry.get("name", ""))}
            ]
            hint = f" -- did you mean: {'; '.join(repr(n) for n in near[:5])}" if near else ""
            problems.append(
                f"{meta['slug']}: no FRED release matched /{meta['match']}/{hint}"
            )
            continue
        if len(matches) > 1:
            names = ", ".join(repr(entry["name"]) for entry in matches[:5])
            problems.append(
                f"{meta['slug']}: /{meta['match']}/ matched {len(matches)} "
                f"releases ({names}) -- tighten the pattern"
            )
            continue

        found = matches[0]
        found_id = int(found["id"])
        expected = meta.get("release_id")
        if expected is not None and expected != found_id:
            problems.append(
                f"{meta['slug']}: expected release id {expected} but FRED "
                f"reports {found_id} for {found['name']!r}"
            )
            continue

        if expected is None:
            print(f"  resolved {meta['slug']} -> id {found_id} ({found['name']})")
        resolved.append((found_id, meta))

    if problems:
        raise RuntimeError(
            "FRED release resolution failed:\n  " + "\n  ".join(problems)
        )
    return resolved


def fetch_fred_events(
    session: requests.Session, api_key: str, window: Tuple[date, date]
) -> List[Dict[str, Any]]:
    """Pull scheduled release dates for each tracked FRED release.

    ``include_release_dates_with_no_data=true`` is what surfaces future,
    scheduled-but-unpublished dates; the default of ``false`` only returns
    dates that already have data attached.
    """
    start_bound, end_bound = window
    events: List[Dict[str, Any]] = []

    for release_id, meta in resolve_fred_release_ids(session, api_key):
        params = {
            "release_id": release_id,
            "api_key": api_key,
            "file_type": "json",
            "include_release_dates_with_no_data": "true",
            "sort_order": "asc",
            "realtime_start": start_bound.isoformat(),
            "realtime_end": "9999-12-31",
            "limit": 10000,
        }
        response = session.get(f"{FRED_API_BASE}/release/dates", params=params, timeout=HTTP_TIMEOUT)
        if response.status_code == 400:
            raise RuntimeError(
                f"FRED rejected the request for release {release_id}: {response.text[:200]}"
            )
        response.raise_for_status()
        payload = response.json()

        seen: set = set()
        for entry in payload.get("release_dates", []):
            day = parse_date(entry.get("date"))
            if not day or not (start_bound <= day <= end_bound) or day in seen:
                continue
            seen.add(day)
            events.append(make_event(
                event_id=f"fred-{meta['slug']}-{day.isoformat()}",
                event_type=f"macro_release_{meta['slug'].replace('-', '_')}",
                title=meta["title"],
                day=day,
                time_et=meta["time_et"],
                market_impact=meta["market_impact"],
                source="FRED",
                source_url=f"https://fred.stlouisfed.org/releases/{release_id}",
                note=meta["note"],
                fred_release_id=release_id,
                primary_source_url=meta["primary_source"],
                attribution=FRED_ATTRIBUTION,
            ))
        print(f"  fred release {release_id} ({meta['slug']}): {len(seen)} dates in window")

    return events


# --------------------------------------------------------------------------
# Enrichment: BEA schedule
# --------------------------------------------------------------------------

def parse_bea_schedule(html: str) -> Dict[date, List[Dict[str, Any]]]:
    """Parse bea.gov/news/schedule into {date: [{title, time_et, variant}]}.

    The table has no year column; the year arrives in a section header row
    ("Year 2026") that the rows beneath it belong to. Rows dated "To Be
    Announced" are skipped.
    """
    soup = BeautifulSoup(html, "html.parser")
    schedule: Dict[date, List[Dict[str, Any]]] = {}
    year: Optional[int] = None

    for row in soup.select("table tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["th", "td"])]
        if not cells:
            continue

        year_match = re.match(r"^Year\s+(\d{4})$", cells[0])
        if year_match:
            year = int(year_match.group(1))
            continue
        if year is None or len(cells) < 3:
            continue

        when, title = cells[0], cells[-1]
        # "October 29 8:30 AM" -> month, day, time
        match = re.match(
            r"^([A-Za-z]+)\s+(\d{1,2})\s+(\d{1,2}:\d{2}\s*[APap]\.?[Mm]\.?)$", when
        )
        if not match:
            continue  # "To Be Announced 2026" and similar
        month_name = match.group(1).lower()
        if month_name not in MONTHS:
            continue
        try:
            day = date(year, MONTHS[month_name], int(match.group(2)))
        except ValueError:
            continue

        lowered = title.lower()
        variant = next(
            (tag for needle, tag, _ in GDP_VARIANTS if needle in lowered), None
        )
        schedule.setdefault(day, []).append({
            "title": title,
            "time_et": parse_clock(match.group(3)) or "08:30",
            "variant": variant,
        })

    return schedule


def enrich_from_bea(
    events: List[Dict[str, Any]], schedule: Dict[date, List[Dict[str, Any]]]
) -> int:
    """Sharpen GDP/PCE events using BEA's own schedule listing.

    FRED release 53 reports every GDP estimate under one name, so the advance
    estimate (which moves markets) is indistinguishable from the third estimate
    (which does not). BEA spells the difference out in the release title.
    """
    impact_by_variant = {tag: impact for _, tag, impact in GDP_VARIANTS}
    enriched = 0

    for event in events:
        if event["event_type"] not in ("macro_release_gdp", "macro_release_pce"):
            continue
        day = parse_date(event.get("date_et"))
        entries = schedule.get(day) if day else None
        if not entries:
            continue

        is_gdp = event["event_type"] == "macro_release_gdp"
        if is_gdp:
            match = next((entry for entry in entries if entry["variant"]), None)
        else:
            match = next(
                (entry for entry in entries
                 if "personal income and outlays" in entry["title"].lower()),
                None,
            )
        if not match:
            continue

        event["bea_release_title"] = match["title"]
        event["source_url"] = BEA_SCHEDULE_URL
        event["confirmed_by"] = "bea.gov"

        if is_gdp:
            variant = match["variant"]
            event["release_variant"] = variant
            event["market_impact"] = impact_by_variant[variant]
            event["title"] = f"GDP ({variant.title()} Estimate)"
            event["note"] = GDP_VARIANT_NOTES[variant]

        # BEA states the release time directly; prefer it over our assumed 8:30.
        if match["time_et"] != event["time_et"]:
            retime_event(event, match["time_et"])

        enriched += 1

    return enriched


def retime_event(event: Dict[str, Any], time_et: str) -> None:
    """Move an event to a new Eastern wall-clock time, recomputing UTC."""
    day = parse_date(event["date_et"])
    if day is None:
        return
    start = et_to_utc(day, time_et)
    duration = timedelta(minutes=30)
    if event.get("end_utc"):
        duration = (
            datetime.strptime(event["end_utc"], "%Y-%m-%dT%H:%M:%SZ")
            - datetime.strptime(event["start_utc"], "%Y-%m-%dT%H:%M:%SZ")
        )
    event["time_et"] = time_et
    event["start_utc"] = iso_z(start)
    event["end_utc"] = iso_z(start + duration)


# --------------------------------------------------------------------------
# Source 3: Treasury
# --------------------------------------------------------------------------

def _treasury_impact(security_type: str, security_term: str) -> str:
    if security_term in TREASURY_HIGH_IMPACT_TERMS:
        return "high"
    return TREASURY_IMPACT.get(security_type, "low")


def fetch_treasury_events(
    session: requests.Session, window: Tuple[date, date]
) -> List[Dict[str, Any]]:
    """Fetch upcoming Treasury auctions and compute refunding announcements.

    Note: the TreasuryDirect web service used to serve XML, but ``?format=xml``
    and an XML ``Accept`` header both return HTTP 406 as of this writing. The
    service is JSON-only, so that is what we parse.
    """
    start_bound, end_bound = window
    records: Dict[str, Dict[str, Any]] = {}

    for endpoint in ("upcoming", "auctioned"):
        try:
            response = session.get(
                f"{TREASURY_BASE}/{endpoint}",
                params={"format": "json"},
                timeout=HTTP_TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            print(f"  ! TreasuryDirect /{endpoint} failed: {exc}", file=sys.stderr)
            continue

        for item in payload:
            auction_day = parse_date(item.get("auctionDate"))
            if not auction_day or not (start_bound <= auction_day <= end_bound):
                continue
            key = f"{item.get('cusip', '')}-{auction_day.isoformat()}"
            records.setdefault(key, item)
        print(f"  treasurydirect /{endpoint}: {len(payload)} records fetched")

    # The refunding announcement is the first Wednesday of Feb/May/Aug/Nov.
    refunding_days = set()
    for year in range(start_bound.year, end_bound.year + 1):
        for month in (2, 5, 8, 11):
            refunding_days.add(first_wednesday(year, month))

    events: List[Dict[str, Any]] = []
    for item in records.values():
        auction_day = parse_date(item.get("auctionDate"))
        if auction_day is None:
            continue
        security_type = (item.get("securityType") or "Security").strip()
        security_term = (item.get("securityTerm") or "").strip()
        cusip = (item.get("cusip") or "").strip()
        announcement_day = parse_date(item.get("announcementDate"))
        close_time = parse_clock(item.get("closingTimeCompetitive")) or "13:00"
        label = f"{security_term} {security_type}".strip()

        events.append(make_event(
            event_id=f"treasury-auction-{cusip or security_term.lower()}-{auction_day.isoformat()}",
            event_type="treasury_auction",
            title=f"Treasury Auction: {label}",
            day=auction_day,
            time_et=close_time,
            market_impact=_treasury_impact(security_type, security_term),
            source="TreasuryDirect",
            source_url="https://www.treasurydirect.gov/auctions/announcements-data-results/",
            note=(
                f"Competitive bidding for the {label} closes at "
                f"{close_time} ET. A weak auction (low bid-to-cover, high tail) "
                "pushes yields up and typically pressures index futures."
            ),
            security_type=security_type,
            security_term=security_term,
            cusip=cusip or None,
            announcement_date=announcement_day.isoformat() if announcement_day else None,
            part_of_quarterly_refunding=bool(announcement_day and announcement_day in refunding_days),
        ))

    for day in sorted(refunding_days):
        if not (start_bound <= day <= end_bound):
            continue
        events.append(make_event(
            event_id=f"treasury-refunding-{day.isoformat()}",
            event_type="treasury_quarterly_refunding",
            title="Treasury Quarterly Refunding Announcement",
            day=day,
            time_et="08:30",
            market_impact="high",
            source="computed",
            source_url="https://home.treasury.gov/news/press-releases",
            note=(
                "Treasury announces the size and composition of the coming "
                "quarter's coupon auctions at 8:30am ET. Changes to long-end "
                "issuance move yields and, through them, equity futures. "
                "Computed as the first Wednesday of Feb/May/Aug/Nov -- verify "
                "against Treasury's press release schedule."
            ),
            computed=True,
        ))

    return events


# --------------------------------------------------------------------------
# Source 5: ISM PMI (computed, approximate)
# --------------------------------------------------------------------------

def build_ism_events(window: Tuple[date, date]) -> List[Dict[str, Any]]:
    """Approximate the ISM PMI release dates.

    ISM is a private organisation; its ToS permits personal use only, so its
    *values* must never be redistributed (docs/RESEARCH.md 1.1 and 1.3). Dates
    are facts and are safe -- but ISM does not publish a machine-readable
    schedule and FRED dropped the series over licensing, so there is nothing to
    fetch. These are computed from the published pattern instead: manufacturing
    on the first business day of the month, services on the third.

    They are flagged ``approximate`` so consumers can mark them as estimates.
    ISM does move them, and a wrong time presented as fact is exactly the
    accuracy risk in docs/RESEARCH.md 7.
    """
    start_bound, end_bound = window
    specs = (
        (
            1, "ism_manufacturing_pmi", "ISM Manufacturing PMI (estimated)", "high",
            "Purchasing managers' index for manufacturing, normally released on "
            "the first business day of the month at 10:00am ET. A sub-50 print "
            "reads as contraction. Date is estimated from ISM's usual pattern -- "
            "confirm against ism.ws before trading it.",
        ),
        (
            3, "ism_services_pmi", "ISM Services PMI (estimated)", "high",
            "Purchasing managers' index for services, normally released on the "
            "third business day of the month at 10:00am ET. Services are the "
            "bulk of the US economy, so this often outweighs the manufacturing "
            "print. Date is estimated -- confirm against ism.ws before trading it.",
        ),
    )

    events: List[Dict[str, Any]] = []
    for year in range(start_bound.year, end_bound.year + 1):
        for month in range(1, 13):
            for nth, event_type, title, impact, note in specs:
                day = nth_business_day(year, month, nth)
                if not (start_bound <= day <= end_bound):
                    continue
                events.append(make_event(
                    event_id=f"{event_type.replace('_', '-')}-{day.isoformat()}",
                    event_type=event_type,
                    title=title,
                    day=day,
                    time_et="10:00",
                    market_impact=impact,
                    source="computed",
                    source_url="https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
                    note=note,
                    computed=True,
                    approximate=True,
                ))
    return events


# --------------------------------------------------------------------------
# Source 4: CME futures (computed)
# --------------------------------------------------------------------------

def build_futures_events(window: Tuple[date, date]) -> List[Dict[str, Any]]:
    """Compute roll, expiration, quad-witching and monthly OPEX dates.

    Rules (docs/RESEARCH.md 1.3):
      * quarterly cycle Mar (H), Jun (M), Sep (U), Dec (Z)
      * expiration on the third Friday of the delivery month
      * CME official roll date: the Monday prior to the third Friday
      * trader liquidity roll: the second Thursday before the third Friday,
        i.e. eight calendar days before expiry, when volume and open interest
        migrate to the back month
      * quad witching: the third Friday of Mar/Jun/Sep/Dec
      * monthly OPEX: the third Friday of every month

    Good Friday is the one U.S. market holiday that regularly lands on a third
    Friday; when it does, expiration moves to the preceding Thursday.
    """
    start_bound, end_bound = window
    events: List[Dict[str, Any]] = []
    symbol_list = ", ".join(f"/{symbol}" for symbol in FUTURES_SYMBOLS)

    for year in range(start_bound.year, end_bound.year + 1):
        for month in range(1, 13):
            opex = third_friday(year, month)
            expiry = opex
            holiday_shift = False
            if opex == good_friday(year):
                expiry = opex - timedelta(days=1)
                holiday_shift = True

            is_quarterly = month in QUARTERLY_MONTHS

            if is_quarterly:
                code = QUARTERLY_MONTHS[month]
                contract = f"{code}{str(year)[-1]}"
                liquidity_roll = opex - timedelta(days=8)
                official_roll = opex - timedelta(days=4)  # Monday prior to 3rd Friday

                if start_bound <= liquidity_roll <= end_bound:
                    events.append(make_event(
                        event_id=f"futures-liquidity-roll-{year}-{month:02d}",
                        event_type="futures_liquidity_roll",
                        title=f"Futures Liquidity Roll ({symbol_list}) → {contract} back month",
                        day=liquidity_roll,
                        time_et=None,
                        market_impact="medium",
                        source="computed",
                        source_url="https://www.cmegroup.com/trading/equity-index/rolldates.html",
                        note=(
                            "Volume and open interest migrate to the back-month "
                            "contract around this date (the second Thursday "
                            "before the third Friday). Quote the back month from "
                            "here on, and expect wider spreads in the front month."
                        ),
                        symbols=FUTURES_SYMBOLS,
                        contract_code=contract,
                        computed=True,
                    ))

                if start_bound <= official_roll <= end_bound:
                    events.append(make_event(
                        event_id=f"futures-official-roll-{year}-{month:02d}",
                        event_type="futures_official_roll",
                        title=f"CME Official Roll Date ({symbol_list})",
                        day=official_roll,
                        time_et=None,
                        market_impact="low",
                        source="computed",
                        source_url="https://www.cmegroup.com/trading/equity-index/rolldates.html",
                        note=(
                            "CME's stated roll date for equity index products: "
                            "the Monday prior to the third Friday. Most traders "
                            "have already rolled by now -- see the liquidity roll "
                            "the preceding Thursday."
                        ),
                        symbols=FUTURES_SYMBOLS,
                        contract_code=contract,
                        computed=True,
                    ))

                if start_bound <= expiry <= end_bound:
                    events.append(make_event(
                        event_id=f"futures-expiration-{year}-{month:02d}",
                        event_type="futures_expiration",
                        title=f"Futures Expiration ({symbol_list}) — {contract}",
                        day=expiry,
                        time_et="09:30",
                        market_impact="medium",
                        source="computed",
                        source_url="https://www.cmegroup.com/trading/equity-index/rolldates.html",
                        note=(
                            "Front-month contract expires, settling to the Special "
                            "Opening Quotation at the 9:30am ET cash open."
                            + (" Shifted one day earlier for Good Friday." if holiday_shift else "")
                        ),
                        symbols=FUTURES_SYMBOLS,
                        contract_code=contract,
                        computed=True,
                        holiday_adjusted=holiday_shift,
                    ))

                    events.append(make_event(
                        event_id=f"quad-witching-{year}-{month:02d}",
                        event_type="quad_witching",
                        title="Quad Witching",
                        day=expiry,
                        time_et="16:00",
                        market_impact="high",
                        source="computed",
                        source_url="https://www.cmegroup.com/trading/equity-index/rolldates.html",
                        note=(
                            "Index futures, index options, single-stock options "
                            "and single-stock futures all expire. Expect elevated "
                            "volume all session and a large closing auction."
                        ),
                        computed=True,
                        holiday_adjusted=holiday_shift,
                    ))
            elif start_bound <= expiry <= end_bound:
                events.append(make_event(
                    event_id=f"monthly-opex-{year}-{month:02d}",
                    event_type="monthly_opex",
                    title="Monthly Options Expiration (OPEX)",
                    day=expiry,
                    time_et="16:00",
                    market_impact="medium",
                    source="computed",
                    source_url="https://www.cmegroup.com/trading/equity-index/rolldates.html",
                    note=(
                        "Monthly equity and index options expire on the third "
                        "Friday. Dealer hedging into the expiry can pin price "
                        "near large open-interest strikes."
                        + (" Shifted one day earlier for Good Friday." if holiday_shift else "")
                    ),
                    computed=True,
                    holiday_adjusted=holiday_shift,
                ))

    return events


# --------------------------------------------------------------------------
# Overrides, assembly, output
# --------------------------------------------------------------------------

TYPICAL_MOVES_PATH = REPO_ROOT / "data" / "typical_moves.json"

# A ratio near 1.0 means the event day looks like any other day. Publishing
# "1.02x normal" on every event would be noise presented as insight, which is
# the failure mode this whole statistic exists to avoid, so only clearly
# elevated or clearly quiet events carry a number.
NOTABLE_ABOVE = 1.25
NOTABLE_BELOW = 0.85


def _index_stats(entry: Dict[str, Any], index: str) -> Optional[Dict[str, Any]]:
    stats = entry.get(index)
    if not stats or stats.get("ratio_median_to_baseline") is None:
        return None
    return {
        "median_abs_pct": stats["median_abs_pct"],
        "ratio": stats["ratio_median_to_baseline"],
        "n": stats["n"],
    }


def typical_move_for(event_type: str, moves: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Build the compact per-event summary attached to the feed.

    Prefers the trailing window, because which events move markets is
    regime-dependent, and falls back to the full sample when the trailing
    window has too few observations to say anything.
    """
    recent = moves.get("recent_window", {}).get("by_event_type", {}).get(event_type)
    full = moves.get("by_event_type", {}).get(event_type)

    source, window = (recent, "recent") if recent else (full, "full")
    if not source:
        return None

    spx = _index_stats(source, "SPX")
    ndx = _index_stats(source, "NDX")
    if not spx:
        return None

    ratio = spx["ratio"]
    notable = ratio >= NOTABLE_ABOVE or ratio <= NOTABLE_BELOW
    if ratio >= NOTABLE_ABOVE:
        summary = f"Historically moves about {ratio:.1f}x as much as a normal day."
    elif ratio <= NOTABLE_BELOW:
        summary = f"Historically moves less than a normal day ({ratio:.1f}x)."
    else:
        summary = "Historically moves about as much as a normal day."

    period = (
        moves.get("recent_window", {}).get("sample_period")
        if window == "recent"
        else moves.get("sample_period")
    )

    return {
        "ratio": ratio,
        "notable": notable,
        "summary": summary,
        "window": window,
        "sample_start": (period or {}).get("start"),
        "spx": spx,
        "ndx": ndx,
    }


def attach_typical_moves(events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Attach typical-move context to events, if the statistics exist.

    Absent or unreadable statistics are not an error: they are a separate,
    monthly job, and the calendar must still build without them.
    """
    if not TYPICAL_MOVES_PATH.exists():
        print("  no typical_moves.json; skipping move context")
        return None

    try:
        with TYPICAL_MOVES_PATH.open(encoding="utf-8") as handle:
            moves = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  ! could not read typical_moves.json: {exc}", file=sys.stderr)
        return None

    cache: Dict[str, Optional[Dict[str, Any]]] = {}
    attached = 0
    notable = 0
    for event in events:
        event_type = event["event_type"]
        if event_type not in cache:
            cache[event_type] = typical_move_for(event_type, moves)
        summary = cache[event_type]
        if summary:
            event["typical_move"] = summary
            attached += 1
            if summary["notable"]:
                notable += 1

    print(f"  attached move context to {attached} event(s); {notable} notable")
    return {
        "sample_period": moves.get("sample_period"),
        "recent_sample_period": moves.get("recent_window", {}).get("sample_period"),
        "indices": moves.get("indices"),
        "method": moves.get("method"),
        "caveat": moves.get("caveat"),
        "baseline": moves.get("baseline"),
        "generated_at_utc": moves.get("generated_at_utc"),
    }


def apply_overrides(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Apply the manual override layer from data/overrides.json.

    docs/RESEARCH.md 7 calls for this: scraped schedules break, and government
    shutdowns reschedule releases. The file supports two keys:

        {"remove": ["<event id>"], "upsert": [{<full or partial event>}]}

    An ``upsert`` entry whose id already exists is merged over the scraped
    event; otherwise it is added as-is.
    """
    if not OVERRIDES_PATH.exists():
        return events

    with OVERRIDES_PATH.open(encoding="utf-8") as handle:
        overrides = json.load(handle)

    removed = set(overrides.get("remove", []))
    if removed:
        events = [event for event in events if event["id"] not in removed]
        print(f"  overrides: removed {len(removed)} event(s)")

    by_id = {event["id"]: event for event in events}
    upserts = overrides.get("upsert", [])
    for patch in upserts:
        event_id = patch.get("id")
        if not event_id:
            print("  ! override upsert missing 'id', skipped", file=sys.stderr)
            continue
        if event_id in by_id:
            by_id[event_id].update(patch)
        else:
            patch.setdefault("source", "manual-override")
            events.append(patch)
            by_id[event_id] = patch
        patch_marker = by_id[event_id]
        patch_marker["manually_overridden"] = True
    if upserts:
        print(f"  overrides: upserted {len(upserts)} event(s)")

    return events


def validate(events: List[Dict[str, Any]]) -> None:
    """Fail loudly on malformed records rather than shipping a broken feed."""
    required = ("id", "event_type", "title", "start_utc", "market_impact", "source_url", "note")
    seen_ids: set = set()
    problems: List[str] = []

    for event in events:
        for field in required:
            if not event.get(field):
                problems.append(f"{event.get('id', '<no id>')}: missing {field}")
        if event["id"] in seen_ids:
            problems.append(f"duplicate id: {event['id']}")
        seen_ids.add(event["id"])
        if event.get("market_impact") not in ("high", "medium", "low"):
            problems.append(f"{event['id']}: bad market_impact {event.get('market_impact')!r}")
        if not str(event.get("start_utc", "")).endswith("Z"):
            problems.append(f"{event['id']}: start_utc is not UTC")

    if problems:
        raise ValueError("calendar validation failed:\n  " + "\n  ".join(problems[:25]))


def build_coverage(events: List[Dict[str, Any]], window: Tuple[date, date]) -> Dict[str, Any]:
    """Describe how far each family of events actually reaches.

    Computed families (futures, refunding) run to the end of the window by
    construction. Reported families only go as far as the upstream agency has
    published, which for macro releases is currently several months short of
    the window. Consumers need to know that, or a sparse far-future month
    looks like missing data instead of an unpublished schedule.
    """
    families = {
        "fomc": ("reported", lambda t: t.startswith("fomc_")),
        "macro_releases": ("reported", lambda t: t.startswith("macro_release_")),
        # Computed from ISM's usual pattern, so complete by construction -- but
        # every one is flagged approximate on the event itself.
        "ism": ("computed", lambda t: t.startswith("ism_")),
        "treasury_auctions": ("reported", lambda t: t == "treasury_auction"),
        "treasury_refunding": ("computed", lambda t: t == "treasury_quarterly_refunding"),
        "futures": (
            "computed",
            lambda t: t.startswith("futures_") or t in ("quad_witching", "monthly_opex"),
        ),
    }

    window_end = window[1]
    summary: Dict[str, Any] = {}
    warnings: List[str] = []

    for name, (horizon, matches) in families.items():
        dates = sorted(event["date_et"] for event in events if matches(event["event_type"]))
        if not dates:
            summary[name] = {
                "horizon": horizon, "event_count": 0,
                "first_event": None, "confirmed_through": None,
                "complete_to_window_end": False,
            }
            warnings.append(f"{name}: no events in the window.")
            continue

        last = parse_date(dates[-1])
        gap_days = (window_end - last).days if last else 0
        # Monthly-cadence sources are only "short" if they trail by more than a
        # release cycle or so.
        complete = horizon == "computed" or gap_days <= 45

        summary[name] = {
            "horizon": horizon,
            "event_count": len(dates),
            "first_event": dates[0],
            "confirmed_through": dates[-1],
            "complete_to_window_end": complete,
        }
        if not complete:
            warnings.append(
                f"{name}: upstream has published dates only through {dates[-1]}, "
                f"{gap_days} days short of the window end {window_end.isoformat()}. "
                "Treat later months as incomplete, not empty."
            )

    return {"window_end": window_end.isoformat(), "families": summary, "warnings": warnings}


def build_document(events: List[Dict[str, Any]], window: Tuple[date, date]) -> Dict[str, Any]:
    events.sort(key=lambda event: (event["start_utc"], event["id"]))

    counts: Dict[str, int] = {}
    impact_counts: Dict[str, int] = {}
    for event in events:
        counts[event["event_type"]] = counts.get(event["event_type"], 0) + 1
        impact_counts[event["market_impact"]] = impact_counts.get(event["market_impact"], 0) + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": iso_z(datetime.now(UTC)),
        "window": {"start": window[0].isoformat(), "end": window[1].isoformat()},
        "timezone_note": (
            "All timestamps are UTC. Eastern release times were converted via "
            "the IANA America/New_York zone, so DST is already accounted for."
        ),
        "disclaimer": DISCLAIMER,
        "attribution": {
            "fred": FRED_ATTRIBUTION,
            "fred_terms_url": FRED_TERMS_URL,
            "treasury": "TreasuryDirect auction data is public domain (CC0).",
            "federal_reserve": "FOMC calendar data is a U.S. government work in the public domain.",
        },
        "sources": [
            {"name": "Federal Reserve FOMC calendar", "url": FOMC_URL},
            {"name": "FRED API", "url": "https://fred.stlouisfed.org/docs/api/fred/"},
            {"name": "TreasuryDirect", "url": "https://www.treasurydirect.gov/auctions/announcements-data-results/"},
            {"name": "CME equity index roll dates", "url": "https://www.cmegroup.com/trading/equity-index/rolldates.html"},
        ],
        "counts": {"total": len(events), "by_event_type": counts, "by_market_impact": impact_counts},
        "coverage": build_coverage(events, window),
        "events": events,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Compass Economic Calendar JSON feed.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSON path")
    parser.add_argument("--months", type=int, default=13, help="months of forward coverage")
    parser.add_argument("--past-days", type=int, default=0, help="days of history to retain")
    parser.add_argument("--skip-fred", action="store_true", help="skip FRED (no API key needed)")
    parser.add_argument("--skip-treasury", action="store_true", help="skip TreasuryDirect")
    parser.add_argument("--skip-fomc", action="store_true", help="skip the FOMC scrape")
    parser.add_argument(
        "--skip-bea", action="store_true",
        help="skip the BEA schedule enrichment (GDP estimate differentiation)",
    )
    parser.add_argument(
        "--skip-ism", action="store_true",
        help="skip the computed (approximate) ISM PMI dates",
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="write output even if a source fails (default: fail the build)",
    )
    args = parser.parse_args()

    load_dotenv(REPO_ROOT / ".env")

    today = datetime.now(ET).date()
    window = (today - timedelta(days=args.past_days), today + timedelta(days=int(args.months * 30.5)))
    print(f"Building calendar for {window[0]} .. {window[1]}")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    events: List[Dict[str, Any]] = []
    failures: List[str] = []

    def run_source(name: str, fetch) -> None:
        print(f"- {name}")
        try:
            found = fetch()
        except Exception as exc:  # noqa: BLE001 - reported per-source below
            print(f"  ! {name} failed: {exc}", file=sys.stderr)
            failures.append(f"{name}: {exc}")
            return
        events.extend(found)
        print(f"  {len(found)} event(s)")

    if not args.skip_fomc:
        run_source("FOMC calendar", lambda: fetch_fomc_events(session, window))

    if not args.skip_fred:
        api_key = os.environ.get("FRED_API_KEY", "").strip()
        if not api_key:
            message = (
                "FRED_API_KEY is not set. Add it to .env (see .env.example) or "
                "pass --skip-fred."
            )
            print(f"  ! {message}", file=sys.stderr)
            failures.append(message)
        else:
            run_source("FRED releases", lambda: fetch_fred_events(session, api_key, window))

    if not args.skip_treasury:
        run_source("Treasury auctions", lambda: fetch_treasury_events(session, window))

    run_source("CME futures (computed)", lambda: build_futures_events(window))

    if not args.skip_ism:
        run_source("ISM PMI (computed, approximate)", lambda: build_ism_events(window))

    # BEA enrichment is deliberately non-fatal: if it fails the calendar is
    # still complete and correct, just with coarser GDP impact ratings.
    if not args.skip_bea:
        print("- BEA schedule (enrichment)")
        try:
            response = session.get(BEA_SCHEDULE_URL, timeout=HTTP_TIMEOUT)
            response.raise_for_status()
            enriched = enrich_from_bea(events, parse_bea_schedule(response.text))
            print(f"  refined {enriched} GDP/PCE event(s)")
        except Exception as exc:  # noqa: BLE001
            print(f"  ! BEA enrichment skipped: {exc}", file=sys.stderr)

    if failures and not args.allow_partial:
        print(
            "\nAborting: one or more sources failed. Re-run with --allow-partial "
            "to publish anyway.",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print("- typical move context")
    typical_moves_meta = attach_typical_moves(events)

    events = apply_overrides(events)
    validate(events)

    document = build_document(events, window)
    if typical_moves_meta:
        document["typical_moves"] = typical_moves_meta
    if failures:
        document["partial_build"] = True
        document["failed_sources"] = failures

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"\nWrote {len(events)} events to {args.out}")
    print(f"  by impact: {document['counts']['by_market_impact']}")
    for name, info in document["coverage"]["families"].items():
        print(f"  {name:20} {info['event_count']:3} events, through {info['confirmed_through']}")
    for warning in document["coverage"]["warnings"]:
        print(f"  ! {warning}")
    print(f"\n{FRED_ATTRIBUTION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
