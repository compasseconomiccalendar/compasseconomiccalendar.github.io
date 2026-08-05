"""Tests for the feed health check.

check_feed.py gates the publish step in the refresh workflow, so a checker that
silently passes everything is worse than no checker at all: it would block
nothing while looking green. Each test here breaks a healthy feed in one way
and asserts the check notices.

Run with:
    python -m unittest discover -s scripts -p 'test_*.py'
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_feed import (  # noqa: E402
    FRED_ATTRIBUTION,
    Report,
    check_envelope,
    check_events,
    load_document,
    parse_iso_z,
)

UTC = timezone.utc
NOW = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)


class Args:
    """Stand-in for the argparse namespace the check functions read."""

    min_events = 60
    min_future_events = 20
    min_horizon_days = 45


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def healthy_feed() -> dict:
    """A minimal feed shaped like the real one: 80 events spread over a year."""
    events = []
    for index in range(80):
        start = NOW + timedelta(days=index * 5 - 5)
        events.append(
            {
                "id": f"event-{index}",
                "event_type": "macro_release_cpi" if index % 2 else "fomc_statement",
                "title": f"Event {index}",
                "start_utc": iso(start),
                "end_utc": None,
                "all_day": False,
                "date_et": start.date().isoformat(),
                "time_et": "08:30",
                "market_impact": "high" if index % 3 == 0 else "medium",
                "source": "example.gov",
                "source_url": "https://example.gov/schedule",
                "note": "",
            }
        )
    return {
        "schema_version": "1.0.0",
        "generated_at_utc": iso(NOW - timedelta(hours=2)),
        "window": {"start": "2026-08-04", "end": "2027-09-04"},
        "disclaimer": "For informational and educational purposes only.",
        "attribution": {"fred": FRED_ATTRIBUTION},
        "sources": [{"name": "FRED API", "url": "https://fred.stlouisfed.org/"}],
        "counts": {"total": len(events)},
        "coverage": {"window_end": "2027-09-04", "families": {}, "warnings": []},
        "market_hours": {"timezone": "America/New_York"},
        "events": events,
    }


def run_checks(document: dict, max_age_days: int = 9) -> Report:
    report = Report()
    check_envelope(report, document, max_age_days, NOW)
    check_events(report, document, NOW, Args())
    return report


class HealthyFeedTest(unittest.TestCase):
    def test_healthy_feed_passes(self) -> None:
        report = run_checks(healthy_feed())
        self.assertEqual(report.failures, [], f"healthy feed reported failures: {report.failures}")
        self.assertTrue(report.ok)
        self.assertGreater(report.passed, 10)


class BrokenFeedTest(unittest.TestCase):
    def assert_fails(self, document: dict, needle: str, **kwargs) -> None:
        report = run_checks(document, **kwargs)
        self.assertFalse(report.ok, "expected a failure but the feed passed")
        joined = " | ".join(report.failures)
        self.assertIn(needle, joined, f"expected {needle!r} in failures: {joined}")

    def test_stale_feed(self) -> None:
        # The refresh stopped running: the classic silent failure.
        feed = healthy_feed()
        feed["generated_at_utc"] = iso(NOW - timedelta(days=12))
        self.assert_fails(feed, "days old")

    def test_future_timestamp(self) -> None:
        feed = healthy_feed()
        feed["generated_at_utc"] = iso(NOW + timedelta(days=3))
        self.assert_fails(feed, "in the future")

    def test_empty_events(self) -> None:
        feed = healthy_feed()
        feed["events"] = []
        self.assert_fails(feed, "events is missing or empty")

    def test_all_events_in_the_past(self) -> None:
        feed = healthy_feed()
        for offset, event in enumerate(feed["events"]):
            event["start_utc"] = iso(NOW - timedelta(days=offset + 1))
        feed["events"].reverse()
        self.assert_fails(feed, "in the future")

    def test_short_horizon(self) -> None:
        feed = healthy_feed()
        feed["events"] = [
            event for event in feed["events"] if parse_iso_z(event["start_utc"]) < NOW + timedelta(days=30)
        ]
        feed["counts"]["total"] = len(feed["events"])
        self.assert_fails(feed, "days out")

    def test_near_term_hole(self) -> None:
        # Technically fresh and forward-looking, but empty for the next month.
        feed = healthy_feed()
        feed["events"] = [
            event for event in feed["events"] if parse_iso_z(event["start_utc"]) > NOW + timedelta(days=20)
        ]
        feed["counts"]["total"] = len(feed["events"])
        self.assert_fails(feed, "next 14 days")

    def test_major_schema_bump(self) -> None:
        feed = healthy_feed()
        feed["schema_version"] = "2.0.0"
        self.assert_fails(feed, "schema_version")

    def test_missing_fred_attribution(self) -> None:
        feed = healthy_feed()
        feed["attribution"]["fred"] = "uses FRED"
        self.assert_fails(feed, "FRED attribution")

    def test_unknown_event_type(self) -> None:
        # Would render under the wrong filter chip instead of erroring.
        feed = healthy_feed()
        feed["events"][4]["event_type"] = "bls_jobs_report"
        self.assert_fails(feed, "cannot group")

    def test_known_odd_types_are_accepted(self) -> None:
        feed = healthy_feed()
        feed["events"][4]["event_type"] = "quad_witching"
        feed["events"][5]["event_type"] = "monthly_opex"
        self.assertTrue(run_checks(feed).ok)

    def test_missing_required_event_field(self) -> None:
        feed = healthy_feed()
        del feed["events"][7]["source_url"]
        self.assert_fails(feed, "missing required fields")

    def test_invalid_market_impact(self) -> None:
        feed = healthy_feed()
        feed["events"][7]["market_impact"] = "critical"
        self.assert_fails(feed, "invalid market_impact")

    def test_duplicate_ids(self) -> None:
        feed = healthy_feed()
        feed["events"][3]["id"] = feed["events"][2]["id"]
        self.assert_fails(feed, "duplicate event ids")

    def test_unsorted_events(self) -> None:
        feed = healthy_feed()
        feed["events"][10], feed["events"][60] = feed["events"][60], feed["events"][10]
        self.assert_fails(feed, "not sorted")

    def test_unparseable_timestamp(self) -> None:
        feed = healthy_feed()
        feed["events"][9]["start_utc"] = "2026-13-45 not a date"
        self.assert_fails(feed, "unparseable start_utc")

    def test_count_mismatch(self) -> None:
        feed = healthy_feed()
        feed["counts"]["total"] = 999
        self.assert_fails(feed, "counts.total")

    def test_missing_top_level_key(self) -> None:
        feed = healthy_feed()
        del feed["market_hours"]
        self.assert_fails(feed, "missing top-level keys")


class LoadDocumentTest(unittest.TestCase):
    def test_truncated_json_is_reported(self) -> None:
        # A deploy that copied half a file.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calendar.json"
            path.write_text(json.dumps(healthy_feed())[:5000], encoding="utf-8")
            report = Report()
            self.assertIsNone(load_document(report, url=None, path=path, timeout=5))
            self.assertIn("not valid JSON", " | ".join(report.failures))

    def test_missing_file_is_reported(self) -> None:
        report = Report()
        path = Path("/nonexistent/calendar.json")
        self.assertIsNone(load_document(report, url=None, path=path, timeout=5))
        self.assertIn("does not exist", " | ".join(report.failures))


if __name__ == "__main__":
    unittest.main()
