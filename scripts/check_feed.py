#!/usr/bin/env python3
"""Health-check the published Compass Economic Calendar feed.

The extension is a thin client over one static JSON (docs/RESEARCH.md section
4.2), so the feed *is* the product: if the weekly refresh silently stops or
publishes a malformed file, every install shows an empty or stale calendar and
nothing in the repo goes red. This script is the missing alarm.

Two modes, same checks:

    python scripts/check_feed.py                      # live, published feed
    python scripts/check_feed.py --file output/calendar.json --skip-ics

The ``--file`` form runs in the refresh workflow between the build and the
Pages upload, so a bad build fails the job instead of shipping. The URL form
runs on its own daily schedule, which is what catches the failure modes a
build-time gate cannot see: the workflow never ran, Pages served a stale copy,
or the deploy silently dropped a file.

Only the standard library is used, so the health job needs no pip install and
stays independent of the ingestion dependencies.

Exit codes: 0 = healthy (warnings allowed), 1 = one or more failed checks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Matches ingestion/build_calendar.py: the repo targets Python 3.9+, where
# datetime.UTC does not exist yet.
UTC = timezone.utc

DEFAULT_FEED_BASE = "https://compasseconomiccalendar.github.io"

# extension/src/config.js pins the client to schema 1.x. A major bump means the
# client needs a release before the feed carrying it goes live.
EXPECTED_SCHEMA_MAJOR = 1

# The refresh runs weekly and extension/src/filters.js `isStale` warns the user
# at 10 days. Alerting at 9 leaves one missed build of slack and still fires
# before anyone sees a stale badge.
DEFAULT_MAX_AGE_DAYS = 9

REQUIRED_TOP_LEVEL = (
    "schema_version",
    "generated_at_utc",
    "window",
    "disclaimer",
    "attribution",
    "sources",
    "counts",
    "coverage",
    "market_hours",
    "events",
)

REQUIRED_EVENT_FIELDS = (
    "id",
    "event_type",
    "title",
    "start_utc",
    "all_day",
    "date_et",
    "market_impact",
    "source",
    "source_url",
)

VALID_IMPACTS = {"low", "medium", "high"}

# Mirrors `groupOf` in extension/src/filters.js. Anything outside this set
# falls through to the "Futures" chip in the popup, so a new event_type that
# lands here is a silent mislabel in the UI, not a crash -- which is exactly
# why it needs a check rather than a bug report.
KNOWN_TYPE_PREFIXES = ("fomc_", "macro_release_", "ism_", "treasury_", "market_", "futures_")
KNOWN_EXACT_TYPES = {"monthly_opex", "quad_witching"}

# Verbatim FRED terms-of-use string (see the licensing note in RESEARCH.md).
# Dropping it from the payload is a terms violation, not a cosmetic bug.
FRED_ATTRIBUTION = (
    "This product uses the FRED® API but is not endorsed or certified by "
    "the Federal Reserve Bank of St. Louis."
)

USER_AGENT = "compass-feed-healthcheck/1.0 (+https://github.com/acloutiernate/compasseconomiccalendar)"


class Report:
    """Collects check results so one run reports every problem, not just the first."""

    def __init__(self) -> None:
        self.failures: List[str] = []
        self.warnings: List[str] = []
        self.notes: List[str] = []
        self.passed = 0

    def check(self, ok: bool, message: str) -> bool:
        if ok:
            self.passed += 1
        else:
            self.failures.append(message)
        return ok

    def warn(self, ok: bool, message: str) -> bool:
        if ok:
            self.passed += 1
        else:
            self.warnings.append(message)
        return ok

    def note(self, message: str) -> None:
        self.notes.append(message)

    @property
    def ok(self) -> bool:
        return not self.failures


def parse_iso_z(value: str) -> Optional[datetime]:
    """Parse the feed's ``...Z`` timestamps. Returns None when unparseable."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch(url: str, timeout: int) -> Tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def load_document(
    report: Report, *, url: Optional[str], path: Optional[Path], timeout: int
) -> Optional[Dict[str, Any]]:
    """Fetch or read the feed. Returns None when it cannot be parsed at all."""
    if path is not None:
        if not report.check(path.is_file(), f"{path} does not exist"):
            return None
        raw = path.read_bytes()
        source = str(path)
    else:
        assert url is not None
        try:
            status, raw = fetch(url, timeout)
        except urllib.error.HTTPError as error:
            report.check(False, f"GET {url} returned HTTP {error.code}")
            return None
        except (urllib.error.URLError, TimeoutError) as error:
            report.check(False, f"GET {url} failed: {error}")
            return None
        if not report.check(status == 200, f"GET {url} returned HTTP {status}"):
            return None
        source = url

    report.check(len(raw) > 10_000, f"{source} is only {len(raw)} bytes; expected a feed of ~200KB")

    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        report.check(False, f"{source} is not valid JSON: {error}")
        return None

    if not report.check(isinstance(document, dict), f"{source} is not a JSON object"):
        return None
    return document


def check_envelope(report: Report, document: Dict[str, Any], max_age_days: int, now: datetime) -> None:
    missing = [key for key in REQUIRED_TOP_LEVEL if key not in document]
    report.check(not missing, f"missing top-level keys: {', '.join(missing)}")

    schema = document.get("schema_version", "")
    major = schema.split(".")[0] if isinstance(schema, str) else ""
    report.check(
        major == str(EXPECTED_SCHEMA_MAJOR),
        f"schema_version is {schema!r}; the extension expects {EXPECTED_SCHEMA_MAJOR}.x "
        "(ship a client release before publishing a major bump)",
    )

    generated = parse_iso_z(document.get("generated_at_utc", ""))
    if report.check(generated is not None, f"generated_at_utc is unparseable: {document.get('generated_at_utc')!r}"):
        age = now - generated
        report.check(
            age <= timedelta(days=max_age_days),
            f"feed is {age.days} days old (generated {document['generated_at_utc']}); "
            f"the weekly refresh has likely stopped -- users see a stale warning at 10 days",
        )
        report.check(
            age >= timedelta(minutes=-10),
            f"generated_at_utc is in the future ({document['generated_at_utc']}); clock or build bug",
        )
        report.note(f"feed generated {document['generated_at_utc']} ({age.days}d ago)")

    attribution = document.get("attribution") or {}
    report.check(
        attribution.get("fred") == FRED_ATTRIBUTION,
        "the verbatim FRED attribution string is missing or altered; it is a terms-of-use requirement",
    )
    report.check(
        bool(document.get("disclaimer")),
        "the disclaimer is missing from the payload",
    )


def check_events(report: Report, document: Dict[str, Any], now: datetime, args: argparse.Namespace) -> None:
    events = document.get("events")
    if not report.check(isinstance(events, list) and bool(events), "events is missing or empty"):
        return

    counts = document.get("counts") or {}
    report.check(
        counts.get("total") == len(events),
        f"counts.total is {counts.get('total')} but there are {len(events)} events",
    )
    report.check(
        len(events) >= args.min_events,
        f"only {len(events)} events; expected at least {args.min_events}",
    )

    missing_fields: Dict[str, int] = {}
    bad_timestamps: List[str] = []
    bad_impacts: List[str] = []
    unknown_types: Dict[str, int] = {}
    seen_ids: Dict[str, int] = {}
    parsed: List[datetime] = []

    for index, event in enumerate(events):
        if not isinstance(event, dict):
            bad_timestamps.append(f"event[{index}] is not an object")
            continue

        for field in REQUIRED_EVENT_FIELDS:
            if field not in event:
                missing_fields[field] = missing_fields.get(field, 0) + 1

        identifier = event.get("id", f"index {index}")
        seen_ids[identifier] = seen_ids.get(identifier, 0) + 1

        start = parse_iso_z(event.get("start_utc", ""))
        if start is None:
            bad_timestamps.append(f"{identifier}: start_utc={event.get('start_utc')!r}")
        else:
            parsed.append(start)

        if event.get("market_impact") not in VALID_IMPACTS:
            bad_impacts.append(f"{identifier}: {event.get('market_impact')!r}")

        event_type = event.get("event_type", "")
        if not (
            isinstance(event_type, str)
            and (event_type.startswith(KNOWN_TYPE_PREFIXES) or event_type in KNOWN_EXACT_TYPES)
        ):
            unknown_types[str(event_type)] = unknown_types.get(str(event_type), 0) + 1

    report.check(
        not missing_fields,
        "events are missing required fields: "
        + ", ".join(f"{field} ({count} events)" for field, count in sorted(missing_fields.items())),
    )
    report.check(not bad_timestamps, "unparseable start_utc: " + "; ".join(bad_timestamps[:5]))
    report.check(not bad_impacts, "invalid market_impact: " + "; ".join(bad_impacts[:5]))

    duplicates = [identifier for identifier, count in seen_ids.items() if count > 1]
    report.check(not duplicates, f"duplicate event ids: {', '.join(duplicates[:5])}")

    report.check(
        not unknown_types,
        "event types the extension cannot group (they silently render under the "
        "Futures chip -- update groupOf in extension/src/filters.js): "
        + ", ".join(sorted(unknown_types)),
    )

    report.check(
        parsed == sorted(parsed),
        "events are not sorted by start_utc; the popup renders them in feed order",
    )

    if not parsed:
        return

    future = [start for start in parsed if start >= now]
    report.check(
        len(future) >= args.min_future_events,
        f"only {len(future)} events are in the future; expected at least {args.min_future_events} "
        "(the feed may be publishing a stale window)",
    )

    if future:
        horizon = (max(future) - now).days
        report.check(
            horizon >= args.min_horizon_days,
            f"the furthest event is only {horizon} days out; expected at least {args.min_horizon_days}",
        )
        report.note(f"{len(future)} future events, horizon {horizon}d")

    soon = [start for start in future if start <= now + timedelta(days=14)]
    report.check(
        bool(soon),
        "no events in the next 14 days; there is a hole at the near end of the feed "
        "even though later events exist",
    )

    high_impact_soon = [
        event
        for event in events
        if isinstance(event, dict)
        and event.get("market_impact") == "high"
        and (start := parse_iso_z(event.get("start_utc", ""))) is not None
        and now <= start <= now + timedelta(days=30)
    ]
    report.warn(
        bool(high_impact_soon),
        "no high-impact events in the next 30 days; the toolbar badge will stay blank",
    )

    for warning in (document.get("coverage") or {}).get("warnings") or []:
        report.note(f"coverage: {warning}")


def check_ics(report: Report, base: str, timeout: int) -> None:
    """The ICS feeds are subscribed to by URL, so a 404 breaks silently for the subscriber."""
    counts: Dict[str, int] = {}
    for name in ("compass_calendar.ics", "compass_calendar_high_impact.ics"):
        url = f"{base}/{name}"
        try:
            status, raw = fetch(url, timeout)
        except urllib.error.HTTPError as error:
            report.check(False, f"GET {url} returned HTTP {error.code}")
            continue
        except (urllib.error.URLError, TimeoutError) as error:
            report.check(False, f"GET {url} failed: {error}")
            continue

        if not report.check(status == 200, f"GET {url} returned HTTP {status}"):
            continue

        text = raw.decode("utf-8", errors="replace")
        report.check(text.lstrip().startswith("BEGIN:VCALENDAR"), f"{name} is not an iCalendar file")
        count = text.count("BEGIN:VEVENT")
        counts[name] = count
        report.check(count > 0, f"{name} contains no VEVENTs")

    if len(counts) == 2:
        full, high = counts["compass_calendar.ics"], counts["compass_calendar_high_impact.ics"]
        report.check(
            high <= full,
            f"the high-impact ICS has more events ({high}) than the full one ({full})",
        )
        report.note(f"ICS: {full} events, {high} high-impact")


def check_site(report: Report, base: str, timeout: int) -> None:
    """The Chrome Web Store listing links to these pages; a 404 is a review risk."""
    for name in ("index.html", "privacy.html"):
        url = f"{base}/{name}"
        try:
            status, _ = fetch(url, timeout)
            report.check(status == 200, f"GET {url} returned HTTP {status}")
        except urllib.error.HTTPError as error:
            report.check(False, f"GET {url} returned HTTP {error.code}")
        except (urllib.error.URLError, TimeoutError) as error:
            report.check(False, f"GET {url} failed: {error}")


def emit(report: Report, target: str) -> None:
    """Print a human summary and, under Actions, annotate + write the job summary."""
    lines: List[str] = []
    status = "healthy" if report.ok else "UNHEALTHY"
    lines.append(f"Compass feed health: {status} -- {target}")
    lines.append(f"{report.passed} checks passed, {len(report.failures)} failed, {len(report.warnings)} warnings")

    for note in report.notes:
        lines.append(f"  note: {note}")
    for warning in report.warnings:
        lines.append(f"  WARN: {warning}")
    for failure in report.failures:
        lines.append(f"  FAIL: {failure}")

    print("\n".join(lines))

    if os.environ.get("GITHUB_ACTIONS") != "true":
        return

    for failure in report.failures:
        print(f"::error title=Feed health::{failure}")
    for warning in report.warnings:
        print(f"::warning title=Feed health::{warning}")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        rows = [f"### Feed health: {status}", "", f"`{target}`", ""]
        rows += [f"- {note}" for note in report.notes]
        rows += [f"- :warning: {warning}" for warning in report.warnings]
        rows += [f"- :x: {failure}" for failure in report.failures]
        if report.ok and not report.warnings:
            rows.append(f"- :white_check_mark: all {report.passed} checks passed")
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(rows) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Health-check the published calendar feed.")
    parser.add_argument("--base", default=DEFAULT_FEED_BASE, help="published site base URL")
    parser.add_argument("--file", type=Path, help="check a local calendar.json instead of the live feed")
    parser.add_argument(
        "--max-age-days",
        type=int,
        default=DEFAULT_MAX_AGE_DAYS,
        help=f"fail when generated_at_utc is older than this (default {DEFAULT_MAX_AGE_DAYS})",
    )
    parser.add_argument("--min-events", type=int, default=60, help="minimum total events")
    parser.add_argument("--min-future-events", type=int, default=20, help="minimum events still ahead of now")
    parser.add_argument("--min-horizon-days", type=int, default=45, help="minimum days to the furthest event")
    parser.add_argument("--skip-ics", action="store_true", help="skip the ICS and site page checks")
    parser.add_argument("--timeout", type=int, default=30, help="per-request timeout in seconds")
    args = parser.parse_args()

    base = args.base.rstrip("/")
    now = datetime.now(UTC)
    report = Report()

    url = None if args.file else f"{base}/calendar.json"
    target = str(args.file) if args.file else url
    document = load_document(report, url=url, path=args.file, timeout=args.timeout)

    if document is not None:
        check_envelope(report, document, args.max_age_days, now)
        check_events(report, document, now, args)

    if not args.skip_ics and not args.file:
        check_ics(report, base, args.timeout)
        check_site(report, base, args.timeout)

    emit(report, target or "")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
