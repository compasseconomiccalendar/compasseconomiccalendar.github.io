"""Tests for the typical-move statistics.

The point of this module is to replace a quoted figure of unknown provenance
with one computed from primary data, so the arithmetic is worth pinning down
against hand-checkable values.

Run with:
    python -m unittest discover -s ingestion -p 'test_*.py'
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_typical_moves import (  # noqa: E402
    build_document,
    restrict,
    daily_returns,
    moves_for_dates,
    percentile,
    summarise,
)


class TestDailyReturns(unittest.TestCase):
    def test_close_to_close_percentage(self):
        closes = {
            date(2026, 1, 5): 100.0,
            date(2026, 1, 6): 101.0,
            date(2026, 1, 7): 99.99,
        }
        returns = daily_returns(closes)
        # The first day has no predecessor and so has no return.
        self.assertNotIn(date(2026, 1, 5), returns)
        self.assertAlmostEqual(returns[date(2026, 1, 6)], 1.0)
        self.assertAlmostEqual(returns[date(2026, 1, 7)], -1.0)

    def test_gaps_use_the_previous_available_close(self):
        # Thursday to Monday: the return spans the weekend, as it should.
        closes = {date(2026, 1, 8): 100.0, date(2026, 1, 12): 102.0}
        returns = daily_returns(closes)
        self.assertAlmostEqual(returns[date(2026, 1, 12)], 2.0)

    def test_unordered_input_is_sorted_first(self):
        closes = {
            date(2026, 1, 7): 99.0,
            date(2026, 1, 5): 100.0,
            date(2026, 1, 6): 110.0,
        }
        returns = daily_returns(closes)
        self.assertAlmostEqual(returns[date(2026, 1, 6)], 10.0)
        self.assertAlmostEqual(returns[date(2026, 1, 7)], -10.0)

    def test_zero_close_does_not_divide_by_zero(self):
        closes = {date(2026, 1, 5): 0.0, date(2026, 1, 6): 100.0}
        self.assertEqual(daily_returns(closes), {})


class TestSummarise(unittest.TestCase):
    def test_absolute_values_are_used(self):
        stats = summarise([1.0, -1.0, 2.0, -2.0])
        self.assertEqual(stats["n"], 4)
        self.assertAlmostEqual(stats["mean_abs_pct"], 1.5)
        self.assertAlmostEqual(stats["median_abs_pct"], 1.5)
        self.assertAlmostEqual(stats["max_abs_pct"], 2.0)
        self.assertAlmostEqual(stats["share_up"], 0.5)

    def test_share_up_reflects_direction(self):
        # Reported values are rounded to three places.
        self.assertAlmostEqual(summarise([1.0, 2.0, -1.0])["share_up"], 2 / 3, places=3)
        self.assertAlmostEqual(summarise([-1.0, -2.0])["share_up"], 0.0)

    def test_empty_input(self):
        self.assertIsNone(summarise([]))

    def test_percentile_interpolates(self):
        values = [0.0, 1.0, 2.0, 3.0, 4.0]
        self.assertAlmostEqual(percentile(values, 0.0), 0.0)
        self.assertAlmostEqual(percentile(values, 1.0), 4.0)
        self.assertAlmostEqual(percentile(values, 0.5), 2.0)
        self.assertAlmostEqual(percentile(values, 0.90), 3.6)
        self.assertAlmostEqual(percentile([7.0], 0.9), 7.0)


class TestMovesForDates(unittest.TestCase):
    def test_non_trading_days_are_skipped(self):
        returns = {date(2026, 1, 6): 1.0, date(2026, 1, 7): -2.0}
        moves = moves_for_dates(returns, [date(2026, 1, 6), date(2026, 1, 1)])
        # 2026-01-01 is a holiday with no return; it must not become a zero.
        self.assertEqual(moves, [1.0])


class TestBuildDocument(unittest.TestCase):
    def _returns(self, event_days, event_move, other_move, total=60):
        """Synthetic history: event days move `event_move`, others `other_move`."""
        returns = {}
        day = date(2026, 1, 1)
        made = 0
        while made < total:
            returns[day] = event_move if day in event_days else other_move
            day += __import__("datetime").timedelta(days=1)
            made += 1
        return returns

    def test_ratio_to_baseline_is_computed(self):
        event_days = [date(2026, 1, 1) + __import__("datetime").timedelta(days=i * 3)
                      for i in range(15)]
        returns = self._returns(event_days, event_move=2.0, other_move=0.5)
        document = build_document(
            {"macro_release_cpi": event_days},
            {"SPX": returns},
            (date(2026, 1, 1), date(2026, 3, 1)),
            min_sample=12,
        )
        stats = document["by_event_type"]["macro_release_cpi"]["SPX"]
        self.assertEqual(stats["n"], 15)
        self.assertAlmostEqual(stats["mean_abs_pct"], 2.0)
        # Baseline mixes both populations, so the ratio sits above 1.
        self.assertGreater(stats["ratio_to_baseline"], 1.0)
        self.assertIn("baseline", document)

    def test_undersampled_event_types_are_dropped(self):
        event_days = [date(2026, 1, 1), date(2026, 1, 4)]
        returns = self._returns(event_days, event_move=3.0, other_move=0.5)
        document = build_document(
            {"rare_event": event_days},
            {"SPX": returns},
            (date(2026, 1, 1), date(2026, 3, 1)),
            min_sample=12,
        )
        # Two observations must not be presented as a "typical" move.
        self.assertNotIn("rare_event", document["by_event_type"])

    def test_no_price_series_is_ever_published(self):
        event_days = [date(2026, 1, 1) + __import__("datetime").timedelta(days=i * 3)
                      for i in range(15)]
        returns = self._returns(event_days, event_move=2.0, other_move=0.5)
        document = build_document(
            {"macro_release_cpi": event_days},
            {"SPX": returns},
            (date(2026, 1, 1), date(2026, 3, 1)),
            min_sample=12,
        )
        # Licensing rests on publishing aggregates only, so assert it directly.
        serialised = __import__("json").dumps(document)
        for forbidden in ("observations", "closes", "series"):
            self.assertNotIn(forbidden, serialised)
        # Deliberate allowlist: publishing only aggregates is what the
        # licensing position rests on, so a new key must be added here on
        # purpose rather than slipping through.
        allowed = {
            "n", "mean_abs_pct", "median_abs_pct", "p90_abs_pct",
            "max_abs_pct", "share_up", "ratio_to_baseline",
            "ratio_median_to_baseline",
        }
        self.assertLessEqual(
            set(document["by_event_type"]["macro_release_cpi"]["SPX"]), allowed
        )
        self.assertLessEqual(set(document["baseline"]["SPX"]), allowed)


class TestRestrict(unittest.TestCase):
    def test_trailing_window_trims_events_and_prices(self):
        days = [date(2020, 1, 1), date(2025, 1, 1), date(2026, 1, 1)]
        returns = {day: 1.0 for day in days}
        trimmed_types, trimmed_returns = restrict(
            {"macro_release_cpi": days}, {"SPX": returns}, since=date(2024, 1, 1)
        )
        self.assertEqual(
            trimmed_types["macro_release_cpi"], [date(2025, 1, 1), date(2026, 1, 1)]
        )
        self.assertEqual(sorted(trimmed_returns["SPX"]), [date(2025, 1, 1), date(2026, 1, 1)])
        # The baseline must be recomputed from the same window, not carried over.
        self.assertNotIn(date(2020, 1, 1), trimmed_returns["SPX"])




class TestVolCrush(unittest.TestCase):
    def test_vix_changes_are_percentages(self):
        from build_typical_moves import vix_changes

        closes = {date(2026, 1, 5): 20.0, date(2026, 1, 6): 18.0}
        self.assertAlmostEqual(vix_changes(closes)[date(2026, 1, 6)], -10.0)

    def test_summarise_vol_keeps_the_sign(self):
        from build_typical_moves import summarise_vol

        # Unlike price moves, direction is the whole point here: a negative
        # median is the vol-crush pattern.
        stats = summarise_vol([-10.0, -5.0, 1.0])
        self.assertEqual(stats["n"], 3)
        self.assertAlmostEqual(stats["median_pct"], -5.0)
        self.assertAlmostEqual(stats["share_falling"], 2 / 3, places=3)
        self.assertIsNone(summarise_vol([]))

    def test_excess_is_measured_against_the_baseline(self):
        from datetime import timedelta

        event_days = [date(2026, 1, 1) + timedelta(days=i * 3) for i in range(15)]
        vol = {}
        day = date(2026, 1, 1)
        for _ in range(60):
            vol[day] = -8.0 if day in event_days else -0.5
            day += timedelta(days=1)
        returns = {key: 1.0 for key in vol}

        document = build_document(
            {"fomc_statement": event_days},
            {"SPX": returns},
            (date(2026, 1, 1), date(2026, 3, 1)),
            min_sample=12,
            vol=vol,
        )
        crush = document["by_event_type"]["fomc_statement"]["VIX"]
        self.assertAlmostEqual(crush["median_pct"], -8.0)
        # Baseline is the mixed population, so excess is the extra crush.
        self.assertLess(crush["excess_pct"], 0)
        self.assertEqual(crush["n"], 15)

    def test_vol_is_optional(self):
        from datetime import timedelta

        event_days = [date(2026, 1, 1) + timedelta(days=i * 3) for i in range(15)]
        returns = {}
        day = date(2026, 1, 1)
        for _ in range(60):
            returns[day] = 1.0
            day += timedelta(days=1)
        document = build_document(
            {"fomc_statement": event_days},
            {"SPX": returns},
            (date(2026, 1, 1), date(2026, 3, 1)),
            min_sample=12,
        )
        # Cboe being unreachable must not break the whole computation.
        self.assertIsNone(document["vix_baseline"])
        self.assertNotIn("VIX", document["by_event_type"]["fomc_statement"])


if __name__ == "__main__":
    unittest.main()
