"""Provider boundary shared by live analytics and future historical backtests.

Strategy calculation operates on a normalized snapshot only; it does not make
broker/API calls and therefore cannot tell whether a real observation came from
the live stream or a historical candle series.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, datetime
from typing import Any

from app.services.analytics import build_signal
from app.services.kite_service import KiteService
from app.services.persistence import MarketPersistence


class MarketDataProvider(ABC):
    source: str

    @abstractmethod
    def get_option_chain(self, underlying: str, expiry: str, strike_range: int = 10, as_of: datetime | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def get_history(self, instrument_token: int, from_date: datetime, to_date: datetime, interval: str) -> dict[str, Any]:
        raise NotImplementedError


class LiveMarketDataProvider(MarketDataProvider):
    source = "kite_live"

    def __init__(self, kite: KiteService) -> None:
        self.kite = kite

    def get_option_chain(self, underlying: str, expiry: str, strike_range: int = 10, as_of: datetime | None = None) -> dict[str, Any]:
        # Live provider always returns the current authenticated Kite snapshot.
        return self.kite.get_option_chain(underlying, expiry, strike_range)

    def get_history(self, instrument_token: int, from_date: datetime, to_date: datetime, interval: str) -> dict[str, Any]:
        return self.kite.get_history(instrument_token, from_date, to_date, interval)

    def get_market(self, underlying: str) -> dict[str, Any]:
        return self.kite.get_market(underlying)

    def get_expiries(self, underlying: str) -> list[dict[str, str]]:
        return self.kite.get_expiries(underlying)

    def get_signal(self, underlying: str) -> dict[str, Any]:
        return self.kite.get_signal(underlying)


class HistoricalMarketDataProvider(MarketDataProvider):
    """Reads saved Kite historical data; it never supplies it to a live view."""
    source = "kite_historical"

    def __init__(self, kite: KiteService, persistence: MarketPersistence) -> None:
        self.kite = kite
        self.persistence = persistence

    def get_option_chain(self, underlying: str, expiry: str, strike_range: int = 10, as_of: datetime | None = None) -> dict[str, Any]:
        try:
            expiry_date = date.fromisoformat(expiry[:10])
        except (TypeError, ValueError) as exc:
            raise ValueError("Expiry must be YYYY-MM-DD.") from exc
        result = self.persistence.load_historical_option_chain(underlying.upper(), expiry_date, strike_range, as_of)
        return {**result, "source": self.source}

    def get_history(self, instrument_token: int, from_date: datetime, to_date: datetime, interval: str) -> dict[str, Any]:
        result = self.kite.get_history(instrument_token, from_date, to_date, interval)
        return {**result, "source": self.source}


def evaluate_normalized_snapshot(snapshot: dict[str, Any], market_live: bool) -> dict[str, Any]:
    """The same deterministic strategy engine entry point for live or backtest inputs."""
    return build_signal(
        spot_change_percent=snapshot.get("spot_change_percent"),
        oi=snapshot.get("oi_analysis"),
        chain=snapshot.get("strikes", []),
        market_live=market_live,
    )
