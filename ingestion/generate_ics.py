#!/usr/bin/env python3
"""Render output/calendar.json as a subscribable iCalendar feed.

The JSON produced by build_calendar.py is the source of truth; this script is
a pure transform over it and performs no network calls.

Usage:
    python ingestion/generate_ics.py
    python ingestion/generate_ics.py --min-impact high --out output/high_impact.ics
    python ingestion/generate_ics.py --alarm-minutes 30 --alarm-minutes 5
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

from icalendar import Alarm, Calendar, Event, vDuration

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = REPO_ROOT / "output" / "calendar.json"
DEFAULT_OUT = REPO_ROOT / "output" / "compass_calendar.ics"

UTC = timezone.utc
PRODID = "-//Compass Economic Calendar//compasseconomiccalendar//EN"
UID_DOMAIN = "compasseconomiccalendar.github.io"

IMPACT_RANK = {"low": 0, "medium": 1, "high": 2}


def parse_utc(value: str) -> datetime:
    """Parse the ``...Z`` timestamps written by build_calendar.py."""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def build_description(event: Dict[str, Any], document: Dict[str, Any]) -> str:
    """Compose the event body: context, then verification links, then legal."""
    lines: List[str] = [event["note"], ""]
    lines.append(f"Market impact: {event['market_impact'].upper()}")

    if event.get("time_et"):
        lines.append(f"Scheduled: {event['time_et']} ET on {event['date_et']}")

    if event.get("contract_code"):
        symbols = ", ".join(f"/{symbol}" for symbol in event.get("symbols", []))
        lines.append(f"Contract: {event['contract_code']} ({symbols})")
    if event.get("security_term"):
        lines.append(f"Security: {event['security_term']} {event.get('security_type', '')}".strip())
    if event.get("cusip"):
        lines.append(f"CUSIP: {event['cusip']}")
    if event.get("has_sep"):
        lines.append("Includes the Summary of Economic Projections (dot plot).")
    if event.get("holiday_adjusted"):
        lines.append("Date shifted for a market holiday.")
    if event.get("manually_overridden"):
        lines.append("This entry was manually corrected against the official source.")

    lines.append("")
    lines.append(f"Verify: {event['source_url']}")
    if event.get("primary_source_url"):
        lines.append(f"Primary source: {event['primary_source_url']}")
    if event.get("attribution"):
        lines.append("")
        lines.append(event["attribution"])

    lines.append("")
    lines.append(document["disclaimer"])
    return "\n".join(lines)


def build_calendar(
    document: Dict[str, Any],
    min_impact: str,
    alarm_minutes: List[int],
    calname: str = "Compass Economic Calendar",
    uid_suffix: str = "",
) -> Calendar:
    scope = (
        "US macro releases, FOMC, Treasury auctions and CME futures roll dates."
        if min_impact == "low"
        else f"Only {min_impact}-impact events: FOMC, CPI, jobs, PCE, advance GDP "
             "and quad witching."
    )

    calendar = Calendar()
    calendar.add("prodid", PRODID)
    calendar.add("version", "2.0")
    calendar.add("calscale", "GREGORIAN")
    calendar.add("method", "PUBLISH")
    calendar.add("x-wr-calname", calname)
    calendar.add("x-wr-timezone", "UTC")
    calendar.add("x-wr-caldesc", f"{scope} {document['disclaimer']}")
    # Ask subscribing clients to re-poll twice a day. These must serialize as
    # ISO durations (PT12H), which means wrapping them in vDuration explicitly.
    calendar.add(
        "refresh-interval",
        vDuration(timedelta(hours=12)),
        parameters={"VALUE": "DURATION"},
    )
    calendar.add("x-published-ttl", vDuration(timedelta(hours=12)))

    stamp = parse_utc(document["generated_at_utc"])
    threshold = IMPACT_RANK[min_impact]
    written = 0

    for event in document["events"]:
        if IMPACT_RANK.get(event["market_impact"], 0) < threshold:
            continue

        entry = Event()
        # The suffix keeps the filtered feed's UIDs distinct from the full
        # feed's, so subscribing to both does not collide in clients that
        # dedupe by UID across calendars.
        local_part = f"{event['id']}-{uid_suffix}" if uid_suffix else event["id"]
        entry.add("uid", f"{local_part}@{UID_DOMAIN}")
        entry.add("dtstamp", stamp)
        entry.add("summary", event["title"])
        entry.add("description", build_description(event, document))
        entry.add("categories", [event["event_type"], f"impact-{event['market_impact']}"])
        entry.add("url", event["source_url"])
        entry.add("status", "CONFIRMED")
        # Calendar events here are informational, so they should not make the
        # subscriber look busy.
        entry.add("transp", "TRANSPARENT")

        start = parse_utc(event["start_utc"])
        if event["all_day"]:
            entry.add("dtstart", start.date())
            entry.add("dtend", start.date() + timedelta(days=1))
        else:
            entry.add("dtstart", start)
            entry.add("dtend", parse_utc(event["end_utc"]) if event.get("end_utc")
                      else start + timedelta(minutes=30))
            for minutes in alarm_minutes:
                alarm = Alarm()
                alarm.add("action", "DISPLAY")
                alarm.add("description", f"{event['title']} in {minutes} minutes")
                alarm.add("trigger", timedelta(minutes=-minutes))
                entry.add_component(alarm)

        calendar.add_component(entry)
        written += 1

    print(f"Wrote {written} of {len(document['events'])} events (min impact: {min_impact})")
    return calendar


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate an ICS feed from calendar.json.")
    parser.add_argument("--in", dest="source", type=Path, default=DEFAULT_IN)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--min-impact", choices=("low", "medium", "high"), default="low",
        help="drop events below this impact level",
    )
    parser.add_argument(
        "--alarm-minutes", type=int, action="append", default=[],
        help="add a reminder N minutes before each timed event (repeatable)",
    )
    parser.add_argument(
        "--calname", default="Compass Economic Calendar",
        help="display name shown by subscribing calendar clients",
    )
    parser.add_argument(
        "--uid-suffix", default="",
        help="suffix event UIDs, so parallel feeds stay distinct",
    )
    args = parser.parse_args()

    if not args.source.exists():
        print(
            f"{args.source} not found -- run ingestion/build_calendar.py first.",
            file=sys.stderr,
        )
        return 1

    with args.source.open(encoding="utf-8") as handle:
        document = json.load(handle)

    calendar = build_calendar(
        document, args.min_impact, args.alarm_minutes, args.calname, args.uid_suffix
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("wb") as handle:
        handle.write(calendar.to_ical())

    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
