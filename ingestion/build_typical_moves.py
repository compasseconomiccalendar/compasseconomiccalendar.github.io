#!/usr/bin/env python3
"""Compute how much the market has historically moved on each kind of event day.

docs/RESEARCH.md section 2 proposes this as the product's differentiator, and
section 9 is explicit that the figures quoted there come from one analyst over
a ~12-event window and must be recomputed from primary data before publishing.
This does that.

Method
------
For each event type, take every historical occurrence, find that day's
close-to-close percentage change in the index, and summarise the absolute
moves. An 8:30am release and a 2:00pm FOMC decision are both captured by the
same session's close-to-close return.

The headline number is the **ratio to baseline**, not the raw percentage. On
its own "CPI day moves 0.64%" says nothing -- a typical day moves something
too. The ratio says how much more than usual, which is the question a trader
actually has.

Licensing
---------
Only aggregate statistics are published: means, medians, percentiles and
counts. No price series is ever written to the output. The underlying FRED
series carry an S&P Dow Jones copyright notice (docs/RESEARCH.md 1.2), which
restricts redistributing the series -- not facts derived from it.

Usage:
    python ingestion/build_typical_moves.py
    python ingestion/build_typical_moves.py --years 10 --min-sample 12
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_calendar import (  # noqa: E402
    FRED_API_BASE,
    FRED_ATTRIBUTION,
    FRED_RELEASES,
    HTTP_TIMEOUT,
    USER_AGENT,
    build_futures_events,
    fetch_fomc_events,
    iso_z,
    parse_date,
    resolve_fred_release_ids,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "data" / "typical_moves.json"

UTC = timezone.utc

# FRED daily index closes. Both are marked copyright by S&P Dow Jones, so only
# derived statistics leave this script.
INDICES = {
    "SPX": {"series_id": "SP500", "label": "S&P 500"},
    "NDX": {"series_id": "NASDAQ100", "label": "Nasdaq 100"},
}

# Event types worth characterising. Treasury auctions are excluded: a bill
# auction has no reliable same-day equity signature, and pretending otherwise
# would be the kind of spurious number this script exists to replace.
FUTURES_EVENT_TYPES = ("quad_witching", "monthly_opex")


def fetch_series(
    session: requests.Session, api_key: str, series_id: str, start: date
) -> Dict[date, float]:
    """Daily closes for a FRED series, keyed by date. Missing values dropped."""
    response = session.get(
        f"{FRED_API_BASE}/series/observations",
        params={
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "observation_start": start.isoformat(),
            "limit": 100000,
        },
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code == 400:
        raise RuntimeError(
            f"FRED rejected series {series_id}: {response.text[:200]}"
        )
    response.raise_for_status()

    closes: Dict[date, float] = {}
    for entry in response.json().get("observations", []):
        day = parse_date(entry.get("date"))
        raw = entry.get("value")
        if day is None or raw in (None, "", "."):
            continue
        try:
            closes[day] = float(raw)
        except ValueError:
            continue

    if not closes:
        raise RuntimeError(f"FRED returned no usable observations for {series_id}")
    return closes


def daily_returns(closes: Dict[date, float]) -> Dict[date, float]:
    """Close-to-close percentage change, keyed by the later of the two days."""
    ordered = sorted(closes)
    returns: Dict[date, float] = {}
    for previous, current in zip(ordered, ordered[1:]):
        before = closes[previous]
        if before:
            returns[current] = (closes[current] / before - 1.0) * 100.0
    return returns


def summarise(moves: List[float]) -> Optional[Dict[str, Any]]:
    """Summary statistics for a list of signed percentage moves."""
    if not moves:
        return None
    absolute = sorted(abs(move) for move in moves)
    return {
        "n": len(absolute),
        "mean_abs_pct": round(statistics.fmean(absolute), 3),
        "median_abs_pct": round(statistics.median(absolute), 3),
        "p90_abs_pct": round(percentile(absolute, 0.90), 3),
        "max_abs_pct": round(absolute[-1], 3),
        # Directional bias is usually noise at these sample sizes, but it is
        # cheap to expose and lets a reader see if it is wildly one-sided.
        "share_up": round(sum(1 for move in moves if move > 0) / len(moves), 3),
    }


def percentile(sorted_values: List[float], fraction: float) -> float:
    """Linear-interpolated percentile of an already-sorted list."""
    if not sorted_values:
        raise ValueError("percentile of an empty list")
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = fraction * (len(sorted_values) - 1)
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def moves_for_dates(returns: Dict[date, float], days: List[date]) -> List[float]:
    """The returns for the given dates, skipping days the market was shut."""
    return [returns[day] for day in days if day in returns]


def historical_release_dates(
    session: requests.Session, api_key: str, release_id: int, start: date, end: date
) -> List[date]:
    response = session.get(
        f"{FRED_API_BASE}/release/dates",
        params={
            "release_id": release_id,
            "api_key": api_key,
            "file_type": "json",
            "sort_order": "asc",
            "realtime_start": start.isoformat(),
            "realtime_end": end.isoformat(),
            "limit": 10000,
        },
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    days = []
    for entry in response.json().get("release_dates", []):
        day = parse_date(entry.get("date"))
        if day and start <= day <= end:
            days.append(day)
    return sorted(set(days))


def collect_event_dates(
    session: requests.Session, api_key: str, start: date, end: date
) -> Dict[str, List[date]]:
    """Historical occurrence dates, keyed by event_type."""
    by_type: Dict[str, List[date]] = {}

    for release_id, meta in resolve_fred_release_ids(session, api_key):
        event_type = f"macro_release_{meta['slug'].replace('-', '_')}"
        days = historical_release_dates(session, api_key, release_id, start, end)
        by_type[event_type] = days
        print(f"  {event_type}: {len(days)} historical dates")

    # The FOMC calendar page carries several past years of meetings.
    fomc = fetch_fomc_events(session, (start, end))
    statements = sorted(
        {
            parse_date(event["date_et"])
            for event in fomc
            if event["event_type"] == "fomc_statement"
        }
        - {None}
    )
    by_type["fomc_statement"] = statements
    print(f"  fomc_statement: {len(statements)} historical dates")

    # Expiration dates follow published rules, so history is computable.
    futures = build_futures_events((start, end))
    for event_type in FUTURES_EVENT_TYPES:
        days = sorted(
            {
                parse_date(event["date_et"])
                for event in futures
                if event["event_type"] == event_type
            }
            - {None}
        )
        by_type[event_type] = days
        print(f"  {event_type}: {len(days)} historical dates")

    return by_type


def build_document(
    by_type: Dict[str, List[date]],
    returns_by_index: Dict[str, Dict[date, float]],
    window: Tuple[date, date],
    min_sample: int,
) -> Dict[str, Any]:
    baseline: Dict[str, Any] = {}
    for index, returns in returns_by_index.items():
        baseline[index] = summarise(list(returns.values()))

    results: Dict[str, Any] = {}
    for event_type, days in sorted(by_type.items()):
        entry: Dict[str, Any] = {}
        for index, returns in returns_by_index.items():
            stats = summarise(moves_for_dates(returns, days))
            # Too few observations is worse than none: it invites a confident
            # reading of noise.
            if not stats or stats["n"] < min_sample:
                continue
            base = baseline[index]["mean_abs_pct"]
            stats["ratio_to_baseline"] = (
                round(stats["mean_abs_pct"] / base, 2) if base else None
            )
            entry[index] = stats
        if entry:
            results[event_type] = entry

    return {
        "schema_version": "1.0.0",
        "generated_at_utc": iso_z(datetime.now(UTC)),
        "sample_period": {"start": window[0].isoformat(), "end": window[1].isoformat()},
        "method": (
            "Absolute close-to-close percentage change of the index on each "
            "historical occurrence of the event. ratio_to_baseline compares the "
            "mean absolute move on those days with the mean absolute move on "
            "every trading day in the same period."
        ),
        "caveat": (
            "Past behaviour over a limited sample. Not a forecast, not "
            "investment advice, and no indication of direction."
        ),
        "indices": {key: value["label"] for key, value in INDICES.items()},
        "min_sample": min_sample,
        "baseline": baseline,
        "attribution": FRED_ATTRIBUTION,
        "by_event_type": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compute typical move statistics.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--years", type=int, default=10, help="years of history")
    parser.add_argument(
        "--min-sample", type=int, default=12,
        help="drop any event type with fewer observations than this",
    )
    args = parser.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    api_key = os.environ.get("FRED_API_KEY", "").strip()
    if not api_key:
        print("FRED_API_KEY is not set (see .env.example).", file=sys.stderr)
        return 1

    end = datetime.now(UTC).date()
    start = end - timedelta(days=int(args.years * 365.25))
    print(f"Sampling {start} .. {end}")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    print("- index history")
    returns_by_index: Dict[str, Dict[date, float]] = {}
    for index, meta in INDICES.items():
        closes = fetch_series(session, api_key, meta["series_id"], start)
        returns = daily_returns(closes)
        returns_by_index[index] = returns
        print(f"  {index} ({meta['series_id']}): {len(returns)} trading days")

    print("- event history")
    by_type = collect_event_dates(session, api_key, start, end)

    document = build_document(by_type, returns_by_index, (start, end), args.min_sample)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"\nWrote {len(document['by_event_type'])} event type(s) to {args.out}\n")
    for index in INDICES:
        base = document["baseline"][index]
        print(f"  baseline {index}: {base['mean_abs_pct']}% mean abs move (n={base['n']})")
    print()
    for event_type, entry in document["by_event_type"].items():
        for index, stats in entry.items():
            print(
                f"  {event_type:<34} {index}  {stats['mean_abs_pct']:>5.2f}%  "
                f"{stats['ratio_to_baseline']:>4}x baseline  (n={stats['n']})"
            )
    print(f"\n{FRED_ATTRIBUTION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
