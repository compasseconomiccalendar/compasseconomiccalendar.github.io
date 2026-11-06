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
    build_fed_board_events,
    build_futures_events,
    build_ism_events,
    build_market_calendar_events,
    enrich_from_bea,
    et_to_utc,
    expected_minutes_date,
    fetch_fomc_events,
    fetch_treasury_events,
    first_wednesday,
    good_friday,
    iso_z,
    last_weekday,
    make_event,
    nth_business_day,
    parse_bea_schedule,
    parse_clock,
    third_friday,
    us_federal_holidays,
    us_market_early_closes,
    us_market_holidays,
    treasury_auction_day,
    treasury_close_time,
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


class TestBusinessDays(unittest.TestCase):
    def test_federal_holidays_land_on_the_right_days(self):
        holidays = us_federal_holidays(2026)
        self.assertIn(date(2026, 1, 1), holidays)       # New Year's, a Thursday
        self.assertIn(date(2026, 1, 19), holidays)      # MLK, 3rd Monday
        self.assertIn(date(2026, 5, 25), holidays)      # Memorial, last Monday
        self.assertIn(date(2026, 11, 26), holidays)     # Thanksgiving, 4th Thursday
        self.assertIn(date(2026, 12, 25), holidays)     # Christmas, a Friday

    def test_weekend_holidays_are_observed_on_a_weekday(self):
        # 2027-07-04 is a Sunday, so it is observed on Monday the 5th.
        self.assertEqual(date(2027, 7, 4).weekday(), 6)
        self.assertIn(date(2027, 7, 5), us_federal_holidays(2027))
        self.assertNotIn(date(2027, 7, 4), us_federal_holidays(2027))
        # 2026-07-04 is a Saturday, observed on Friday the 3rd.
        self.assertIn(date(2026, 7, 3), us_federal_holidays(2026))

    def test_last_weekday(self):
        self.assertEqual(last_weekday(2026, 5, 0), date(2026, 5, 25))
        self.assertEqual(last_weekday(2026, 12, 4), date(2026, 12, 25))

    def test_nth_business_day_skips_weekends_and_holidays(self):
        # Sep 2026 starts on a Tuesday; Labor Day is Mon Sep 7.
        self.assertEqual(nth_business_day(2026, 9, 1), date(2026, 9, 1))
        self.assertEqual(nth_business_day(2026, 9, 3), date(2026, 9, 3))
        # Jan 2027 starts Fri Jan 1 (a holiday), so the 1st business day is Jan 4.
        self.assertEqual(nth_business_day(2027, 1, 1), date(2027, 1, 4))
        # Nov 2026 starts on a Sunday, so the 1st business day is Mon Nov 2.
        self.assertEqual(nth_business_day(2026, 11, 1), date(2026, 11, 2))

    def test_ism_events_are_flagged_approximate(self):
        events = build_ism_events((date(2026, 9, 1), date(2026, 9, 30)))
        self.assertEqual(len(events), 2)
        by_type = {event["event_type"]: event for event in events}
        self.assertEqual(by_type["ism_manufacturing_pmi"]["date_et"], "2026-09-01")
        self.assertEqual(by_type["ism_services_pmi"]["date_et"], "2026-09-03")
        for event in events:
            self.assertTrue(event["approximate"])
            self.assertEqual(event["time_et"], "10:00")
            # ISM values are licensed; only the date may be published.
            self.assertIn("estimated", event["title"].lower())


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




class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeSession:
    """Serves canned TreasuryDirect payloads keyed by endpoint name."""

    def __init__(self, upcoming, auctioned=()):
        self._payloads = {"upcoming": list(upcoming), "auctioned": list(auctioned)}

    def get(self, url, params=None, timeout=None):
        return _FakeResponse(self._payloads[url.rsplit("/", 1)[-1]])


# Trimmed from a live /upcoming record, November 2026 schema.
CURRENT_RECORD = {
    "cusip": "91282CRW3",
    "securityType": "Note",
    "securityTerm": "3-Year",
    "announcementDate": "2026-11-04T00:00:00",
    "competitiveAuctionCloseDate": "2026-11-09T00:00:00",
    "competitiveAuctionCloseTime": "01:00 PM",
}

# The same auction as the pre-October-2026 schema described it.
LEGACY_RECORD = {
    "cusip": "91282CRW3",
    "securityType": "Note",
    "securityTerm": "3-Year",
    "announcementDate": "2026-11-04T00:00:00",
    "auctionDate": "2026-11-09T00:00:00",
    "closingTimeCompetitive": "01:00 PM",
}


class TestTreasuryAuctions(unittest.TestCase):
    WINDOW = (date(2026, 11, 1), date(2027, 11, 1))

    def test_current_and_legacy_field_names_both_parse(self):
        for record in (CURRENT_RECORD, LEGACY_RECORD):
            self.assertEqual(treasury_auction_day(record), date(2026, 11, 9))
            self.assertEqual(treasury_close_time(record), "13:00")

    def test_empty_new_field_falls_back_to_the_old_one(self):
        record = {**LEGACY_RECORD, "competitiveAuctionCloseDate": ""}
        self.assertEqual(treasury_auction_day(record), date(2026, 11, 9))

    def test_current_schema_produces_auction_events(self):
        events = fetch_treasury_events(_FakeSession([CURRENT_RECORD]), self.WINDOW)
        auctions = [e for e in events if e["event_type"] == "treasury_auction"]
        self.assertEqual(len(auctions), 1)
        self.assertEqual(auctions[0]["date_et"], "2026-11-09")
        self.assertEqual(auctions[0]["time_et"], "13:00")
        self.assertEqual(auctions[0]["title"], "Treasury Auction: 3-Year Note")

    def test_records_without_any_readable_date_fail_the_source(self):
        # The October 2026 failure mode: records arrive, none can be dated.
        unreadable = {k: v for k, v in CURRENT_RECORD.items() if "Date" not in k}
        with self.assertRaises(RuntimeError):
            fetch_treasury_events(_FakeSession([unreadable] * 3), self.WINDOW)

    def test_no_records_at_all_is_not_a_schema_failure(self):
        events = fetch_treasury_events(_FakeSession([]), self.WINDOW)
        self.assertFalse([e for e in events if e["event_type"] == "treasury_auction"])


def _fomc_page(year, rows):
    """A minimal FOMC calendar page: one year panel of (month, date, text) rows."""
    body = "".join(
        f'<div class="row fomc-meeting"><div class="fomc-meeting__month">{month}</div>'
        f'<div class="fomc-meeting__date">{dates}</div><div>{extra}</div></div>'
        for month, dates, extra in rows
    )
    return (
        f'<div class="panel panel-default"><div class="panel-heading">'
        f"<h4>{year} FOMC Meetings</h4></div>{body}</div>"
    )


class _HtmlSession:
    def __init__(self, html):
        self.html = html

    def get(self, url, params=None, timeout=None, headers=None):
        html = self.html

        class Response:
            text = html
            content = html.encode()
            status_code = 200

            def raise_for_status(self):
                pass

        return Response()


class TestFomcMinutes(unittest.TestCase):
    def test_minutes_are_three_weeks_after_the_decision(self):
        # Every 2026 release: decision Wednesday + 21 days.
        self.assertEqual(expected_minutes_date(date(2026, 10, 28)), date(2026, 11, 18))
        self.assertEqual(expected_minutes_date(date(2026, 12, 9)), date(2026, 12, 30))

    def test_a_holiday_pushes_minutes_to_the_next_business_day(self):
        # Dec 4 2024 + 21 = Christmas Day.
        self.assertEqual(expected_minutes_date(date(2024, 12, 4)), date(2024, 12, 26))
        # Dec 11 2024 + 21 = New Year's Day 2025.
        self.assertEqual(expected_minutes_date(date(2024, 12, 11)), date(2025, 1, 2))

    def _minutes(self, rows, window):
        events = fetch_fomc_events(_HtmlSession(_fomc_page(2026, rows)), window)
        return {e["id"]: e for e in events if e["event_type"] == "fomc_minutes"}

    def test_released_minutes_use_the_feds_date(self):
        minutes = self._minutes(
            [("September", "15-16*", "Statement: PDF | HTML Minutes: PDF | HTML (Released October 07, 2026)")],
            (date(2026, 9, 1), date(2026, 12, 31)),
        )
        event = minutes["fomc-minutes-2026-09-16"]
        self.assertEqual(event["date_et"], "2026-10-07")
        self.assertTrue(event["confirmed"])
        self.assertNotIn("approximate", event)

    def test_upcoming_minutes_are_computed_and_flagged(self):
        # The October 2026 failure: a held meeting with no minutes line yet,
        # and a future meeting whose row is only a date.
        minutes = self._minutes(
            [("October", "27-28", "Statement: PDF | HTML Press Conference"),
             ("December", "8-9*", "")],
            (date(2026, 11, 6), date(2027, 11, 6)),
        )
        self.assertEqual(sorted(minutes), ["fomc-minutes-2026-10-28", "fomc-minutes-2026-12-09"])
        october = minutes["fomc-minutes-2026-10-28"]
        self.assertEqual((october["date_et"], october["time_et"]), ("2026-11-18", "14:00"))
        self.assertFalse(october["confirmed"])
        self.assertTrue(october["approximate"])
        self.assertEqual(minutes["fomc-minutes-2026-12-09"]["date_et"], "2026-12-30")

    def test_minutes_inside_the_window_appear_even_when_the_meeting_is_not(self):
        minutes = self._minutes(
            [("October", "27-28", "Statement: PDF | HTML")],
            (date(2026, 11, 6), date(2027, 11, 6)),
        )
        self.assertIn("fomc-minutes-2026-10-28", minutes)

    def test_notation_votes_get_no_minutes(self):
        minutes = self._minutes(
            [("November", "15 (notation vote)", "Statement: PDF | HTML")],
            (date(2026, 11, 1), date(2027, 11, 1)),
        )
        self.assertEqual(minutes, {})


class TestFedBoardCalendar(unittest.TestCase):
    WINDOW = (date(2026, 11, 1), date(2027, 11, 1))

    @staticmethod
    def entry(title, kind, month, days, time="10:00 a.m.", description=""):
        return {"title": title, "type": kind, "month": month, "days": days,
                "time": time, "description": description}

    def build(self, *entries):
        return build_fed_board_events(list(entries), self.WINDOW)

    def test_beige_book_and_industrial_production(self):
        events = self.build(
            self.entry("Beige Book", "Beige", "2026-11", "25", "2:00 p.m."),
            self.entry("G.17 - Industrial Production and Capacity Utilization", "Stat",
                       "2026-11", "17", "9:15 a.m."),
        )
        by_type = {e["event_type"]: e for e in events}
        beige = by_type["fomc_beige_book"]
        self.assertEqual((beige["date_et"], beige["time_et"]), ("2026-11-25", "14:00"))
        ip = by_type["macro_release_industrial_production"]
        self.assertEqual((ip["date_et"], ip["time_et"]), ("2026-11-17", "09:15"))

    def test_chair_policy_speech_is_high_and_ceremony_is_medium(self):
        events = self.build(
            self.entry("Speech - Chair Jerome H. Powell", "Speeches", "2026-11", "20",
                       "12:30 p.m.", "Economic Outlook and Monetary Policy"),
            self.entry("Speech - Chair Jerome H. Powell", "Speeches", "2026-11", "21",
                       "1:30 p.m.", "Welcoming Remarks"),
        )
        self.assertEqual([e["market_impact"] for e in events], ["high", "medium"])
        self.assertEqual(events[0]["title"],
                         "Chair Powell speaks: Economic Outlook and Monetary Policy")
        self.assertEqual(events[0]["time_et"], "12:30")

    def test_governor_speeches_are_not_published_yet(self):
        # They would notify every FOMC-chip user, supervision talks included.
        events = self.build(
            self.entry("Speech - Governor Christopher J. Waller", "Speeches",
                       "2026-11", "10", "4:00 a.m.", "Economic Outlook"),
            self.entry("Discussion - Vice Chair for Supervision Michelle W. Bowman",
                       "Speeches", "2026-11", "13", "10:50 a.m.", "Supervision and Regulation"),
        )
        self.assertEqual(events, [])

    def test_testimony_by_any_board_member_is_published(self):
        events = self.build(self.entry(
            "Testimony - Vice Chair for Supervision Michelle W. Bowman", "Testimony",
            "2026-12", "2", "10:00 a.m.", "Hearing on Oversight of Prudential Regulators"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event_type"], "fomc_testimony")
        self.assertEqual(events[0]["market_impact"], "medium")
        self.assertIn("Bowman testifies", events[0]["title"])

    def test_two_appearances_on_one_day_get_distinct_ids(self):
        events = self.build(
            self.entry("Speech - Chair Jerome H. Powell", "Speeches", "2026-11", "20",
                       "9:00 a.m.", "Economic Outlook"),
            self.entry("Speech - Chair Jerome H. Powell", "Speeches", "2026-11", "20",
                       "6:30 p.m.", "Economic Outlook"),
        )
        self.assertEqual(len({e["id"] for e in events}), 2)

    def test_recurring_days_markup_and_window_are_handled(self):
        events = self.build(
            self.entry("G.17 - Industrial Production and Capacity Utilization", "Stat",
                       "2026-10", "16", "9:15 a.m."),           # before the window
            self.entry("Beige Book", "Beige", "2026-12", "2, 31", "",
                       "<p>Release &amp; summary</p>"),          # two days, no time
            self.entry("H.15 - Selected Interest Rates", "Stat", "2026-11", "2, 3"),
        )
        self.assertEqual([e["date_et"] for e in events], ["2026-12-02", "2026-12-31"])
        # No published time falls back to the usual 2:00pm.
        self.assertTrue(all(e["time_et"] == "14:00" for e in events))


class TestMarketCalendar(unittest.TestCase):
    def test_exchange_holidays_are_not_the_federal_set(self):
        holidays = us_market_holidays(2026)
        # Closed for Good Friday, which is not a federal holiday at all.
        self.assertIn(date(2026, 4, 3), holidays)
        # Open on Columbus Day and Veterans Day, which are federal.
        self.assertNotIn(date(2026, 10, 12), holidays)
        self.assertNotIn(date(2026, 11, 11), holidays)
        self.assertEqual(len(holidays), 10)

    def test_weekend_holidays_are_observed(self):
        # 2026-07-04 is a Saturday, observed Friday the 3rd.
        self.assertIn(date(2026, 7, 3), us_market_holidays(2026))
        # 2027-07-04 is a Sunday, observed Monday the 5th.
        self.assertIn(date(2027, 7, 5), us_market_holidays(2027))

    def test_new_years_saturday_exception(self):
        # NYSE Rule 7.2: when New Year's Day is a Saturday the exchange does
        # NOT close the preceding Friday, unlike every other holiday.
        self.assertEqual(date(2028, 1, 1).weekday(), 5)
        holidays = us_market_holidays(2028)
        self.assertNotIn(date(2027, 12, 31), holidays)
        self.assertNotIn(date(2028, 1, 1), holidays)
        # Every other 2028 holiday is still there.
        self.assertEqual(len(holidays), 9)

    def test_early_closes_yield_to_an_observed_holiday(self):
        # 2026: July 4 is Saturday, so July 3 is the holiday, not a half day.
        early_2026 = us_market_early_closes(2026)
        self.assertNotIn(date(2026, 7, 3), early_2026)
        self.assertIn(date(2026, 11, 27), early_2026)   # day after Thanksgiving
        self.assertIn(date(2026, 12, 24), early_2026)   # Christmas Eve, a Thursday

        # 2027: Christmas is Saturday, so Dec 24 is the holiday, not a half day.
        early_2027 = us_market_early_closes(2027)
        self.assertNotIn(date(2027, 12, 24), early_2027)
        self.assertEqual(list(early_2027), [date(2027, 11, 26)])

    def test_independence_eve_half_day_when_the_fourth_is_midweek(self):
        # 2029-07-04 is a Wednesday, so Tuesday the 3rd is a half day.
        self.assertEqual(date(2029, 7, 4).weekday(), 2)
        self.assertIn(date(2029, 7, 3), us_market_early_closes(2029))

    def test_events_are_all_day_for_closures_and_timed_for_half_days(self):
        events = build_market_calendar_events((date(2026, 11, 1), date(2026, 12, 31)))
        by_type = {}
        for event in events:
            by_type.setdefault(event["event_type"], []).append(event)

        closure = next(
            e for e in by_type["market_holiday"] if e["date_et"] == "2026-11-26"
        )
        self.assertTrue(closure["all_day"])
        self.assertIn("Thanksgiving", closure["title"])

        half = next(
            e for e in by_type["market_early_close"] if e["date_et"] == "2026-11-27"
        )
        self.assertFalse(half["all_day"])
        self.assertEqual(half["time_et"], "13:00")
        # 1pm ET in November is 18:00 UTC (EST).
        self.assertEqual(half["start_utc"], "2026-11-27T18:00:00Z")


if __name__ == "__main__":
    unittest.main()
