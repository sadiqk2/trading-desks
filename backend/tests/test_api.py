from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from app.main import app, kite_service


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Keep API tests hermetic even when a developer has real Kite credentials locally.
        cls.token_patch = patch.object(kite_service, "_access_token", "")
        cls.token_patch.start()
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.token_patch.stop()

    def test_system_status_does_not_expose_credentials(self):
        response = self.client.get("/api/system/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn(body["kite"], {"authenticated", "disconnected"})
        self.assertIn(body["market_phase"], {"PRE_MARKET", "LIVE", "MARKET_CLOSED"})
        encoded = response.text.lower()
        self.assertNotIn("kite_api_secret", encoded)
        self.assertNotIn("kite_access_token", encoded)

    def test_supported_underlyings_are_discovery_choices_not_market_quotes(self):
        response = self.client.get("/api/underlyings")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["symbol"] for item in response.json()], ["NIFTY", "BANKNIFTY"])
        self.assertNotIn("spot", response.json()[0])

    def test_market_status_is_ist_and_explains_schedule_limit(self):
        response = self.client.get("/api/market/status")
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["timezone"], "Asia/Kolkata")
        self.assertIn("holidays", body["note"])

    def test_invalid_range_is_rejected_without_market_fallback(self):
        response = self.client.get("/api/option-chain/NIFTY/2026-10-08?range=6")
        self.assertEqual(response.status_code, 422)
        self.assertIn("range", response.text.lower())

    def test_unsupported_underlying_does_not_call_kite(self):
        with patch.object(kite_service, "_ensure_instruments", side_effect=AssertionError("must not call Kite")):
            response = self.client.get("/api/expiries/SENSEX")
        self.assertEqual(response.status_code, 404)
        self.assertIn("Unsupported underlying", response.json()["error"])

    def test_no_market_values_are_returned_without_a_valid_session(self):
        with patch.object(kite_service, "_client", None), patch.object(kite_service, "_access_token", ""):
            response = self.client.get("/api/option-chain/NIFTY/2026-10-08?range=5")
        self.assertIn(response.status_code, {401, 503})
        body = response.json()
        self.assertFalse(body["data_available"])
        self.assertNotIn("spot", body)
        self.assertNotIn("strikes", body)

    def test_risk_endpoint_returns_n_a_for_missing_user_inputs(self):
        response = self.client.get("/api/risk/calculate")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["max_risk"])
        self.assertIsNone(response.json()["position_size"])


if __name__ == "__main__":
    unittest.main()
