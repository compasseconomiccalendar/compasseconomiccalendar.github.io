"""Tests for the date and timezone math in build_calendar.py.

docs/RESEARCH.md section 7 flags DST transitions and CME holiday edge cases as
the maintenance risk in this job, so those are what is covered here.

Run with:
    python -m unittest discover -s ingestion -p 'test_*.py'
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_calendar import (  # noqa: E402
    _parse_fomc_row_dates,
    build_coverage,
    build_futures_events,
    enrich_from_bea,
    et_to_utc,
    first_wednesday,
    good_friday,
    iso_z,
    make_event,
    parse_bea_schedule,
    parse_clock,
    third_friday,
)


class TestEasternToUtc(unittest.TestCase):
    def test_summer_release_is_utc_minus_four(self):
        # EDT: 8:30am ET -> 12:30 UTC
        self.assertEqual(iso_z(et_to_utc(date(2026, 7, 2), "08:30")), "2026-07-02T12:30:00Z")

    def test_winter_release_is_utc_minus_five(self):
        # EST: 8:30am ET -> 13:30 UTC
        self.assertEqual(iso_z(et_to_utc(date(2026, 1, 9), "08:30")), "2026-01-09T13:30:00Z")

    def test_fomc_statement_across_dst(self):
        # 2:00pm ET is 18:00 UTC in summer and 19:00 UTC in winter.
        self.assertEqual(iso_z(et_to_utc(date(2026, 9, 16), "14:00")), "2026-09-16T18:00:00Z")
        self.assertEqual(iso_z(et_to_utc(date(2026, 12, 9), "14:00")), "2026-12-09T19:00:00Z")

    def test_day_after_dst_transitions(self):
        # DST starts the second Sunday in March (2026-03-08) and ends the first
        # Sunday in November (2026-11-01).
        self.assertEqual(iso_z(et_to_utc(date(2026, 3, 6), "08:30")), "2026-03-06T13:30:00Z")
        self.assertEqual(iso_z(et_to_utc(date(2026, 3, 9), "08:30")), "2026-03-09T12:30:00Z")
        self.assertEqual(iso_z(et_to_utc(date(2026, 10, 30), "08:30")), "2026-10-30T12:30:00Z")
        self.assertEqual(iso_z(et_to_utc(date(2026, 11, 2), "08:30")), "2026-11-02T13:30:00Z")


class TestExpirationDates(unittest.TestCase):
    def test_third_friday(self):
        self.assertEqual(third_friday(2026, 9), date(2026, 9, 18))
        self.assertEqual(third_friday(2026, 12), date(2026, 12, 18))
        # Month starting on a Friday: the 1st is the first Friday.
        self.assertEqual(third_friday(2026, 5), date(2026, 5, 15))

    def test_roll_offsets(self):
        # Liquidity roll is the second Thursday before the third Friday;
        # CME's official roll is the Monday prior to it.
        expiry = third_friday(2026, 9)
        liquidity_roll = expiry.toordinal() - 8
        official_roll = expiry.toordinal() - 4
        self.assertEqual(date.fromordinal(liquidity_roll).weekday(), 3)  # Thursday
        self.assertEqual(date.fromordinal(official_roll).weekday(), 0)  # Monday
        self.assertEqual(date.fromordinal(liquidity_roll), date(2026, 9, 10))
        self.assertEqual(date.fromordinal(official_roll), date(2026, 9, 14))

    def test_good_friday(self):
        self.assertEqual(good_friday(2026), date(2026, 4, 3))
        self.assertEqual(good_friday(2027), date(2027, 3, 26))
        self.assertEqual(good_friday(2024), date(2024, 3, 29))

    def test_good_friday_can_land_on_a_third_friday(self):
        # 2025-04-18 was both Good Friday and the third Friday of April, so that
        # month's OPEX moved to Thursday the 17th. This is the case the shift
        # exists to handle; it recurs in 2030, 2033 and 2044.
        for year in (2025, 2030, 2033):
            self.assertEqual(good_friday(year), third_friday(year, good_friday(year).month))

    def test_opex_shifts_off_good_friday(self):
        events = build_futures_events((date(2025, 4, 1), date(2025, 4, 30)))
        opex = [event for event in events if event["event_type"] == "monthly_opex"]
        self.assertEqual(len(opex), 1)
        self.assertEqual(opex[0]["date_et"], "2025-04-17")
        self.assertTrue(opex[0]["holiday_adjusted"])

    def test_normal_month_opex_is_not_shifted(self):
        events = build_futures_events((date(2025, 8, 1), date(2025, 8, 31)))
        opex = [event for event in events if event["event_type"] == "monthly_opex"]
        self.assertEqual(len(opex), 1)
        self.assertEqual(opex[0]["date_et"], "2025-08-15")
        self.assertFalse(opex[0]["holiday_adjusted"])

    def test_quarterly_month_emits_roll_expiry_and_quad_witching(self):
        events = build_futures_events((date(2026, 9, 1), date(2026, 9, 30)))
        by_type = {event["event_type"]: event for event in events}
        self.assertEqual(
            set(by_type),
            {
                "futures_liquidity_roll",
                "futures_official_roll",
                "futures_expiration",
                "quad_witching",
            },
        )
        self.assertEqual(by_type["futures_liquidity_roll"]["date_et"], "2026-09-10")
        self.assertEqual(by_type["futures_official_roll"]["date_et"], "2026-09-14")
        self.assertEqual(by_type["futures_expiration"]["date_et"], "2026-09-18")
        self.assertEqual(by_type["futures_expiration"]["contract_code"], "U6")
        # Quarterly months must not also emit a plain monthly OPEX entry.
        self.assertNotIn("monthly_opex", by_type)

    def test_first_wednesday(self):
        self.assertEqual(first_wednesday(2026, 8), date(2026, 8, 5))
        self.assertEqual(first_wednesday(2026, 11), date(2026, 11, 4))
        self.assertEqual(first_wednesday(2027, 2), date(2027, 2, 3))


class TestFomcRowParsing(unittest.TestCase):
    def test_single_month_two_day_meeting(self):
        self.assertEqual(
            _parse_fomc_row_dates(2026, "March", "17-18*"),
            (date(2026, 3, 17), date(2026, 3, 18)),
        )

    def test_meeting_spanning_a_month_boundary(self):
        self.assertEqual(
            _parse_fomc_row_dates(2025, "Apr/May", "30-1"),
            (date(2025, 4, 30), date(2025, 5, 1)),
        )

    def test_meeting_spanning_a_year_boundary(self):
        self.assertEqual(
            _parse_fomc_row_dates(2024, "Dec/Jan", "31-1"),
            (date(2024, 12, 31), date(2025, 1, 1)),
        )

    def test_parenthetical_is_ignored(self):
        self.assertEqual(
            _parse_fomc_row_dates(2025, "August", "22 (notation vote)"),
            (date(2025, 8, 22), date(2025, 8, 22)),
        )

    def test_unparseable_row_returns_none(self):
        self.assertIsNone(_parse_fomc_row_dates(2026, "Someday", "TBD"))


BEA_HTML = """
<table>
  <tr><th>Year 2026</th><th></th><th>Release</th></tr>
  <tr><td>July 30 8:30 AM</td><td>News</td>
      <td>GDP (Advance Estimate), 2nd Quarter 2026</td></tr>
  <tr><td>July 30 8:30 AM</td><td>News</td>
      <td>Personal Income and Outlays, June 2026</td></tr>
  <tr><td>August 26 8:30 AM</td><td>News</td>
      <td>GDP (Second Estimate) and Corporate Profits, 2nd Quarter 2026</td></tr>
  <tr><td>September 30 8:30 AM</td><td>News</td>
      <td>GDP (Third Estimate), Industries, Corporate Profits</td></tr>
  <tr><td>October 6 10:00 AM</td><td>News</td>
      <td>Services Supplied Through Affiliates, 2024</td></tr>
  <tr><td>To Be Announced 2026</td><td>News</td>
      <td>Outdoor Recreation Economic Statistics</td></tr>
</table>
"""


def _macro_event(event_type, day, time_et="08:30", impact="medium"):
    return make_event(
        event_id=f"fred-x-{day}", event_type=event_type, title="GDP",
        day=date.fromisoformat(day), time_et=time_et, market_impact=impact,
        source="FRED", source_url="https://fred.stlouisfed.org/releases/53",
        note="placeholder",
    )


class TestBeaSchedule(unittest.TestCase):
    def test_parses_dates_titles_and_variants(self):
        schedule = parse_bea_schedule(BEA_HTML)
        self.assertEqual(
            {str(day) for day in schedule},
            {"2026-07-30", "2026-08-26", "2026-09-30", "2026-10-06"},
        )
        # "To Be Announced" rows carry no date and must be dropped.
        self.assertEqual(len(schedule[date(2026, 7, 30)]), 2)
        self.assertEqual(schedule[date(2026, 8, 26)][0]["variant"], "second")
        self.assertEqual(schedule[date(2026, 10, 6)][0]["time_et"], "10:00")
        self.assertIsNone(schedule[date(2026, 10, 6)][0]["variant"])

    def test_gdp_impact_is_differentiated(self):
        schedule = parse_bea_schedule(BEA_HTML)
        events = [
            _macro_event("macro_release_gdp", "2026-07-30"),
            _macro_event("macro_release_gdp", "2026-08-26"),
            _macro_event("macro_release_gdp", "2026-09-30"),
        ]
        self.assertEqual(enrich_from_bea(events, schedule), 3)
        self.assertEqual(
            [(event["release_variant"], event["market_impact"]) for event in events],
            [("advance", "high"), ("second", "medium"), ("third", "low")],
        )
        self.assertEqual(events[0]["title"], "GDP (Advance Estimate)")

    def test_pce_is_matched_but_not_retitled(self):
        schedule = parse_bea_schedule(BEA_HTML)
        events = [_macro_event("macro_release_pce", "2026-07-30", impact="high")]
        self.assertEqual(enrich_from_bea(events, schedule), 1)
        self.assertEqual(events[0]["market_impact"], "high")
        self.assertNotIn("release_variant", events[0])
        self.assertIn("Personal Income", events[0]["bea_release_title"])

    def test_event_with_no_bea_match_is_left_alone(self):
        schedule = parse_bea_schedule(BEA_HTML)
        events = [_macro_event("macro_release_gdp", "2026-11-11")]
        self.assertEqual(enrich_from_bea(events, schedule), 0)
        self.assertEqual(events[0]["market_impact"], "medium")

    def test_bea_time_correction_recomputes_utc(self):
        schedule = parse_bea_schedule(BEA_HTML)
        # A GDP event we assumed at 08:30 that BEA actually lists at 10:00.
        events = [_macro_event("macro_release_gdp", "2026-10-06")]
        # 10-06 has no GDP row, so inject one to exercise the retime path.
        schedule[date(2026, 10, 6)].insert(
            0, {"title": "GDP (Advance Estimate)", "time_et": "10:00", "variant": "advance"}
        )
        enrich_from_bea(events, schedule)
        self.assertEqual(events[0]["time_et"], "10:00")
        self.assertEqual(events[0]["start_utc"], "2026-10-06T14:00:00Z")  # EDT
        self.assertEqual(events[0]["end_utc"], "2026-10-06T14:30:00Z")


class TestCoverage(unittest.TestCase):
    def test_computed_family_is_complete_and_reported_gap_warns(self):
        window = (date(2026, 7, 28), date(2027, 8, 28))
        events = build_futures_events(window)
        events.append(_macro_event("macro_release_cpi", "2026-12-10"))
        coverage = build_coverage(events, window)

        self.assertTrue(coverage["families"]["futures"]["complete_to_window_end"])
        macro = coverage["families"]["macro_releases"]
        self.assertFalse(macro["complete_to_window_end"])
        self.assertEqual(macro["confirmed_through"], "2026-12-10")
        self.assertTrue(any("macro_releases" in w for w in coverage["warnings"]))

    def test_empty_family_reports_zero_not_crash(self):
        window = (date(2026, 7, 28), date(2027, 8, 28))
        coverage = build_coverage([], window)
        self.assertEqual(coverage["families"]["fomc"]["event_count"], 0)
        self.assertIsNone(coverage["families"]["fomc"]["confirmed_through"])


class TestClockParsing(unittest.TestCase):
    def test_treasury_closing_times(self):
        self.assertEqual(parse_clock("11:30 AM"), "11:30")
        self.assertEqual(parse_clock("1:00 PM"), "13:00")
        self.assertEqual(parse_clock("12:00 PM"), "12:00")
        self.assertEqual(parse_clock("12:30 AM"), "00:30")

    def test_missing_or_bad_values(self):
        self.assertIsNone(parse_clock(""))
        self.assertIsNone(parse_clock(None))
        self.assertIsNone(parse_clock("noon"))


if __name__ == "__main__":
    unittest.main()
