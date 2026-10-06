from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.analytics import (
    black_scholes_price,
    build_oi_analysis,
    build_signal,
    calculate_risk,
    change_oi,
    change_oi_percent,
    expected_move,
    greeks,
    implied_volatility,
    market_phase,
    nearest_strike,
    option_activity,
    pcr,
    strike_window,
)


class AnalyticsTests(unittest.TestCase):
    def test_atm_and_contract_window_use_listed_strikes(self):
        strikes = [24000, 24100, 24200, 24300, 24400, 24500, 24600]
        atm = nearest_strike(24361, strikes)
        self.assertEqual(atm, 24400)
        self.assertEqual(strike_window(strikes, atm, 2), [24200, 24300, 24400, 24500, 24600])
        self.assertIsNone(nearest_strike(None, strikes))

    def test_oi_baseline_and_percent(self):
        self.assertEqual(change_oi(125, 100), 25)
        self.assertEqual(change_oi_percent(125, 100), 25)
        self.assertIsNone(change_oi(10, None))
        self.assertIsNone(change_oi_percent(10, 0))

    def test_pcr_handles_missing_denominator(self):
        self.assertAlmostEqual(pcr(120, 100), 1.2)
        self.assertIsNone(pcr(120, 0))
        self.assertIsNone(pcr(None, 100))

    def test_oi_analysis_and_walls_are_scoped_to_supplied_chain(self):
        chain = [
            {"strike": 100, "ce": {"oi": 10, "change_oi": 1}, "pe": {"oi": 40, "change_oi": 4}},
            {"strike": 110, "ce": {"oi": 30, "change_oi": 3}, "pe": {"oi": 20, "change_oi": 2}},
            {"strike": 120, "ce": {"oi": 60, "change_oi": 6}, "pe": {"oi": 10, "change_oi": 1}},
        ]
        result = build_oi_analysis(chain, 90)
        self.assertEqual(result["total_ce_oi"], 100)
        self.assertEqual(result["total_pe_oi"], 70)
        self.assertAlmostEqual(result["pcr"], 0.7)
        self.assertEqual(result["highest_ce_oi_strike"], 120)
        self.assertEqual(result["highest_pe_oi_strike"], 100)
        self.assertEqual(result["ce_oi_walls"][0]["strike"], 120)
        self.assertEqual(result["scope"], "selected strikes only")

    def test_expected_move_formula(self):
        self.assertAlmostEqual(expected_move(1000, 0.2, 0.25), 100)
        self.assertIsNone(expected_move(None, 0.2, 0.25))
        self.assertIsNone(expected_move(1000, None, 0.25))

    def test_black_scholes_iv_and_greeks_from_fixed_model_fixture(self):
        price = black_scholes_price(100, 100, 1, 0.05, 0.2, "CE")
        self.assertIsNotNone(price)
        iv = implied_volatility(price, 100, 100, 1, 0.05, "CE")
        self.assertAlmostEqual(iv, 0.2, places=5)
        calculated = greeks(100, 100, 1, 0.05, iv, "CE")
        self.assertAlmostEqual(calculated["delta"], 0.6368, places=3)
        self.assertGreater(calculated["gamma"], 0)
        self.assertLess(calculated["theta"], 0)
        self.assertGreater(calculated["vega"], 0)

    def test_iv_rejects_impossible_or_missing_inputs(self):
        self.assertIsNone(implied_volatility(1, 120, 100, 0.5, 0.06, "CE"))
        self.assertIsNone(implied_volatility(None, 120, 100, 0.5, 0.06, "CE"))
        self.assertIsNone(implied_volatility(5, 100, 100, None, 0.06, "CE"))

    def test_price_oi_classification_is_descriptive(self):
        self.assertEqual(option_activity(1, 2), "LONG_BUILDUP")
        self.assertEqual(option_activity(-1, 2), "SHORT_BUILDUP")
        self.assertEqual(option_activity(1, -2), "SHORT_COVERING")
        self.assertEqual(option_activity(-1, -2), "LONG_UNWINDING")
        self.assertEqual(option_activity(None, 2), "NEUTRAL")

    def test_signal_score_and_market_closed_gate(self):
        chain = [{"near_atm": True, "ce": {"change_oi": 10, "activity": "LONG_UNWINDING", "volume": 10}, "pe": {"change_oi": 30, "activity": "SHORT_BUILDUP", "volume": 25}}]
        oi = {"pcr": 1.2}
        signal = build_signal(spot_change_percent=0.3, oi=oi, chain=chain, market_live=True)
        self.assertEqual(signal["direction"], "BULLISH")
        self.assertGreaterEqual(signal["confidence"], 50)
        self.assertGreater(len(signal["reasons"]), 0)
        closed = build_signal(spot_change_percent=0.3, oi=oi, chain=chain, market_live=False)
        self.assertIsNone(closed["direction"])
        self.assertEqual(closed["status"], "market_closed")

    def test_risk_calculator_has_no_margin_or_leverage_assumption(self):
        result = calculate_risk(100000, 1, 100, 80, 140, 25, 2)
        self.assertEqual(result["max_risk"], 1000)
        self.assertEqual(result["position_size"], 50)
        self.assertEqual(result["required_capital"], 5000)
        self.assertEqual(result["potential_profit"], 2000)
        self.assertEqual(result["risk_reward"], 2)
        self.assertEqual(result["max_lots_by_risk"], 2)
        self.assertIsNone(calculate_risk(None, 1, 100, 80, 140, 25, 2)["max_risk"])

    def test_market_hours_are_ist_weekday_schedule(self):
        ist = ZoneInfo("Asia/Kolkata")
        self.assertEqual(market_phase(datetime(2026, 10, 6, 9, 14, tzinfo=ist)), "PRE_MARKET")
        self.assertEqual(market_phase(datetime(2026, 10, 6, 9, 15, tzinfo=ist)), "LIVE")
        self.assertEqual(market_phase(datetime(2026, 10, 6, 15, 30, tzinfo=ist)), "MARKET_CLOSED")
        self.assertEqual(market_phase(datetime(2026, 10, 10, 11, 0, tzinfo=ist)), "MARKET_CLOSED")


if __name__ == "__main__":
    unittest.main()
