from __future__ import annotations

import sys
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.market_store import MarketStore
from app.services.redis_cache import RedisMarketCache


class MarketStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = MarketStore(RedisMarketCache())
        self.instrument = {
            "instrument_token": 991234,
            "tradingsymbol": "TEST_OPTION",
            "exchange": "NFO",
            "instrument_type": "CE",
        }

    def test_first_genuine_oi_observation_establishes_the_daily_baseline(self):
        first = self.store.observe({"last_price": 101.25, "oi": 150, "volume_traded": 17}, self.instrument)
        self.assertEqual(first["previous_oi"], 150)
        self.assertEqual(first["change_oi"], 0)
        self.assertEqual(first["last_price"], 101.25)
        self.assertEqual(first["volume"], 17)

        later = self.store.observe({"last_price": 102.0, "oi": 180, "volume_traded": 44}, self.instrument)
        self.assertEqual(later["previous_oi"], 150)
        self.assertEqual(later["change_oi"], 30)
        self.assertEqual(later["change_oi_percent"], 20)

    def test_missing_kite_fields_remain_unavailable_and_observation_is_ist(self):
        tick = self.store.observe({"oi": None}, self.instrument)
        self.assertIsNone(tick["last_price"])
        self.assertIsNone(tick["volume"])
        self.assertIsNone(tick["oi"])
        self.assertIsNone(tick["change_oi"])
        self.assertEqual(tick["source"], "kite_live")
        self.assertEqual(tick["timestamp"][-6:], "+05:30")
        self.assertEqual(ZoneInfo("Asia/Kolkata").key, "Asia/Kolkata")


if __name__ == "__main__":
    unittest.main()
