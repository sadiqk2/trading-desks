"""In-process live tick state and WebSocket fan-out (Redis is the shared cache)."""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.config import settings
from app.security import safe_error
from app.services.redis_cache import RedisMarketCache

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _iso_ist(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=IST)
    return value.astimezone(IST).isoformat(timespec="milliseconds")


def _depth(raw: dict[str, Any]) -> dict[str, Any] | None:
    value = raw.get("depth")
    if not isinstance(value, dict):
        return None
    result: dict[str, Any] = {}
    for side in ("buy", "sell"):
        entries = value.get(side)
        if isinstance(entries, list):
            result[side] = [
                {
                    "price": _number(item.get("price")),
                    "quantity": _number(item.get("quantity")),
                    "orders": _number(item.get("orders")),
                }
                for item in entries[:5]
                if isinstance(item, dict)
            ]
    return result or None


class MarketStore:
    def __init__(self, cache: RedisMarketCache) -> None:
        self.cache = cache
        self._latest: dict[int, dict[str, Any]] = {}
        self._baselines: dict[tuple[str, int], float] = {}
        self._clients: dict[Any, set[int]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self.last_tick_at: str | None = None
        self.last_data_timestamp: str | None = None
        self.last_error: str | None = None
        self._persistence = None
        self._tick_enricher = None

    def set_persistence(self, persistence: Any) -> None:
        self._persistence = persistence

    def set_tick_enricher(self, enricher: Any) -> None:
        self._tick_enricher = enricher

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def observe(self, raw: dict[str, Any], instrument: dict[str, Any], source: str = "kite_live") -> dict[str, Any]:
        """Normalize a genuine Kite quote/tick and establish an intraday OI baseline."""
        token = int(instrument["instrument_token"])
        received = datetime.now(IST)
        exchange_time = raw.get("exchange_timestamp") or raw.get("last_trade_time") or raw.get("timestamp")
        oi = _number(raw.get("oi"))
        trading_day = received.date().isoformat()
        baseline_key = (trading_day, token)
        baseline = self._baselines.get(baseline_key)
        if baseline is None:
            baseline = self.cache.get_baseline(token, trading_day)
            if baseline is None and oi is not None:
                baseline = oi
                self.cache.save_baseline(token, trading_day, baseline)
            if baseline is not None:
                self._baselines[baseline_key] = baseline
        change = (oi - baseline) if oi is not None and baseline is not None else None

        ohlc_raw = raw.get("ohlc") if isinstance(raw.get("ohlc"), dict) else {}
        depth = _depth(raw)
        buy = depth.get("buy", []) if depth else []
        sell = depth.get("sell", []) if depth else []
        best_bid = buy[0] if buy else {}
        best_ask = sell[0] if sell else {}
        tick = {
            "timestamp": received.isoformat(timespec="milliseconds"),
            "exchange_timestamp": _iso_ist(exchange_time),
            "source": source,
            "instrument_token": token,
            "tradingsymbol": instrument.get("tradingsymbol"),
            "exchange": instrument.get("exchange"),
            "last_price": _number(raw.get("last_price")),
            "volume": _number(raw.get("volume_traded", raw.get("volume"))),
            "oi": oi,
            "previous_oi": baseline,
            "change_oi": change,
            "change_oi_percent": (change / abs(baseline) * 100.0) if change is not None and baseline not in (None, 0) else None,
            "buy_quantity": _number(raw.get("total_buy_quantity", raw.get("buy_quantity"))),
            "sell_quantity": _number(raw.get("total_sell_quantity", raw.get("sell_quantity"))),
            "bid": _number(best_bid.get("price", raw.get("bid"))),
            "ask": _number(best_ask.get("price", raw.get("ask"))),
            "bid_quantity": _number(best_bid.get("quantity", raw.get("bid_quantity"))),
            "ask_quantity": _number(best_ask.get("quantity", raw.get("ask_quantity"))),
            "ohlc": {
                "open": _number(ohlc_raw.get("open")),
                "high": _number(ohlc_raw.get("high")),
                "low": _number(ohlc_raw.get("low")),
                "close": _number(ohlc_raw.get("close")),
            },
            "depth": depth,
            "average_price": _number(raw.get("average_price")),
            "last_trade_time": _iso_ist(raw.get("last_trade_time")),
        }
        if self._tick_enricher:
            try:
                enrichment = self._tick_enricher(tick, instrument)
                if enrichment:
                    tick.update(enrichment)
            except Exception as exc:
                log.debug("Tick analytics unavailable for token %s: %s", token, exc)
        self._latest[token] = tick
        self.last_tick_at = tick["timestamp"]
        self.last_data_timestamp = tick.get("exchange_timestamp") or tick["timestamp"]
        self.last_error = None
        self.cache.save_tick(token, tick)
        if self._persistence:
            try:
                option_snapshot = None
                if instrument.get("instrument_type") in {"CE", "PE"} and instrument.get("expiry") and instrument.get("strike") is not None and instrument.get("underlying"):
                    option_snapshot = {
                        "timestamp": tick["timestamp"],
                        "instrument_token": token,
                        "underlying": instrument["underlying"],
                        "expiry": instrument["expiry"],
                        "strike": instrument["strike"],
                        "option_type": instrument["instrument_type"],
                        "ltp": tick.get("last_price"),
                        "bid": tick.get("bid"),
                        "ask": tick.get("ask"),
                        "volume": tick.get("volume"),
                        "oi": tick.get("oi"),
                        "previous_oi": tick.get("previous_oi"),
                        "change_oi": tick.get("change_oi"),
                        "iv": tick.get("iv"),
                        "delta": tick.get("delta"),
                        "gamma": tick.get("gamma"),
                        "theta": tick.get("theta"),
                        "vega": tick.get("vega"),
                        "source": "kite_live",
                    }
                self._persistence.persist_tick(tick, option_snapshot)
            except Exception as exc:  # persistence must not interrupt live tick delivery
                log.warning("Tick persistence failed: %s", safe_error(exc, settings.database_url))
        self._dispatch(token, tick)
        return tick

    def latest(self, token: int) -> dict[str, Any] | None:
        return self._latest.get(int(token)) or self.cache.latest_tick(int(token))

    def latest_many(self, tokens: list[int]) -> dict[int, dict[str, Any]]:
        return {token: value for token in tokens if (value := self.latest(token)) is not None}

    def client_tokens(self) -> set[int]:
        return set().union(*self._clients.values()) if self._clients else set()

    async def add_client(self, websocket: Any, tokens: set[int]) -> None:
        self._clients[websocket] = set(tokens)

    async def remove_client(self, websocket: Any) -> None:
        self._clients.pop(websocket, None)

    def _dispatch(self, token: int, payload: dict[str, Any]) -> None:
        loop = self._loop
        if not loop or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(self._broadcast(token, payload)))
        except RuntimeError:
            return

    async def _broadcast(self, token: int, payload: dict[str, Any]) -> None:
        dead = []
        for websocket, tokens in list(self._clients.items()):
            if token not in tokens:
                continue
            try:
                await websocket.send_json({"type": "tick", "data": payload})
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self._clients.pop(websocket, None)

    def status(self) -> dict[str, Any]:
        last = self.last_tick_at
        age = None
        if self.last_data_timestamp:
            try:
                parsed = datetime.fromisoformat(self.last_data_timestamp)
                age = max(0.0, (datetime.now(IST) - parsed.astimezone(IST)).total_seconds())
            except ValueError:
                age = None
        return {"last_tick_at": last, "last_data_timestamp": self.last_data_timestamp, "data_age_seconds": age, "last_error": self.last_error}
