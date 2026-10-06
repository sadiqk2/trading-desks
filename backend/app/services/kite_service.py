"""Kite Connect session, instrument master and live option-chain discovery."""
from __future__ import annotations

import logging
import threading
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.config import UNDERLYINGS, settings
from app.services.analytics import (
    build_oi_analysis,
    build_signal,
    expected_move,
    greeks,
    implied_volatility,
    market_phase,
    nearest_strike,
    option_activity,
    strike_window,
    time_to_expiry_years,
)
from app.services.kite_stream import KiteStream
from app.security import safe_error
from app.services.market_store import MarketStore
from app.services.persistence import MarketPersistence

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")


class KiteServiceError(RuntimeError):
    def __init__(self, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if number == number and abs(number) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except (TypeError, ValueError):
        return None


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=IST)
        return value.astimezone(IST).isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return None


class KiteService:
    def __init__(self, store: MarketStore, stream: KiteStream, persistence: MarketPersistence) -> None:
        self.store = store
        self.stream = stream
        self.persistence = persistence
        self._client: Any = None
        self._access_token = ""
        self._instruments: list[dict[str, Any]] | None = None
        self._instrument_by_token: dict[int, dict[str, Any]] = {}
        self._instrument_lock = threading.Lock()
        self.store.set_tick_enricher(self._enrich_tick)
        if settings.kite_configured and settings.kite_access_token:
            self.set_access_token(settings.kite_access_token, start_stream=False)

    @property
    def configured(self) -> bool:
        return settings.kite_configured

    @property
    def authenticated(self) -> bool:
        return bool(self._client and self._access_token)

    def set_access_token(self, access_token: str, start_stream: bool = True) -> None:
        if not settings.kite_api_key:
            raise KiteServiceError("KITE_API_KEY is not configured on the backend.", 503)
        try:
            from kiteconnect import KiteConnect

            client = KiteConnect(api_key=settings.kite_api_key)
            client.set_access_token(access_token)
        except Exception as exc:
            log.error("Unable to configure Kite Connect client: %s", safe_error(exc, access_token, settings.kite_api_secret, settings.kite_access_token, self._access_token))
            raise KiteServiceError("Kite Connect could not be initialized. Check the server configuration.", 503) from exc
        self._client = client
        self._access_token = access_token
        self._instruments = None
        self._instrument_by_token = {}
        if start_stream:
            self.stream.start(access_token)
        log.info("Kite access token accepted by backend; secret and token are not logged")

    def login_url(self) -> str:
        if not settings.kite_api_key:
            raise KiteServiceError("KITE_API_KEY is not configured on the backend.", 503)
        try:
            from kiteconnect import KiteConnect

            client = KiteConnect(api_key=settings.kite_api_key)
            return client.login_url()
        except Exception as exc:
            log.error("Could not create Kite login URL: %s", safe_error(exc, settings.kite_api_secret, settings.kite_access_token, self._access_token))
            raise KiteServiceError("Could not create the Kite login URL.", 503) from exc

    def exchange_request_token(self, request_token: str) -> None:
        if not settings.kite_configured:
            raise KiteServiceError("Kite API key and secret must be configured on the backend.", 503)
        try:
            from kiteconnect import KiteConnect

            client = KiteConnect(api_key=settings.kite_api_key)
            session = client.generate_session(request_token, api_secret=settings.kite_api_secret)
            access_token = session.get("access_token")
            if not access_token:
                raise ValueError("Kite did not return an access token")
            self.set_access_token(access_token, start_stream=True)
            # Do not persist or return the token; Kite access tokens normally expire daily.
        except KiteServiceError:
            raise
        except Exception as exc:
            log.error("Kite request-token exchange failed (%s)", safe_error(exc, request_token, settings.kite_api_secret, settings.kite_access_token, self._access_token))
            raise KiteServiceError("Kite authentication failed. Check the Kite callback and try again.", 401) from exc

    def _require_client(self) -> Any:
        if not settings.kite_api_key or not settings.kite_api_secret:
            raise KiteServiceError("Kite is not configured. Add KITE_API_KEY and KITE_API_SECRET to the backend environment.", 503)
        if not self._client or not self._access_token:
            raise KiteServiceError("Kite is disconnected. Authenticate with Kite Connect to load live market data.", 401)
        return self._client

    def _ensure_instruments(self) -> list[dict[str, Any]]:
        self._require_client()
        if self._instruments is not None:
            return self._instruments
        with self._instrument_lock:
            if self._instruments is not None:
                return self._instruments
            try:
                raw_instruments = self._client.instruments()
            except Exception as exc:
                log.error("Kite instrument master download failed: %s", safe_error(exc, settings.kite_api_secret, settings.kite_access_token, self._access_token))
                raise KiteServiceError("Could not download the Kite instrument master. Check the connection and access token.", 502) from exc
            records: list[dict[str, Any]] = []
            for raw in raw_instruments or []:
                if not isinstance(raw, dict) or raw.get("instrument_token") is None:
                    continue
                row = {
                    "instrument_token": int(raw["instrument_token"]),
                    "exchange_token": int(raw["exchange_token"]) if raw.get("exchange_token") not in (None, "") else None,
                    "tradingsymbol": str(raw.get("tradingsymbol") or ""),
                    "name": str(raw.get("name") or "").strip() or None,
                    "last_price": _number(raw.get("last_price")),
                    "expiry": _date(raw.get("expiry")),
                    "strike": _number(raw.get("strike")),
                    "tick_size": _number(raw.get("tick_size")),
                    "lot_size": int(raw["lot_size"]) if raw.get("lot_size") not in (None, "") else None,
                    "instrument_type": str(raw.get("instrument_type") or ""),
                    "segment": str(raw.get("segment") or ""),
                    "exchange": str(raw.get("exchange") or ""),
                }
                if row["instrument_type"] in {"CE", "PE"}:
                    option_name = str(row.get("name") or "").upper()
                    row["underlying"] = next((symbol for symbol, config in UNDERLYINGS.items() if option_name in {name.upper() for name in config["option_names"]}), None)
                records.append(row)
            if not records:
                raise KiteServiceError("Kite returned an empty instrument master; no contracts are available.", 502)
            self._instruments = records
            self._instrument_by_token = {item["instrument_token"]: item for item in records}
            self.stream.set_instruments(records)
            self.persistence.persist_instruments(records)
            log.info("Downloaded live Kite instrument master: %d records", len(records))
            return records

    def _index_instrument(self, underlying: str, instruments: list[dict[str, Any]]) -> dict[str, Any] | None:
        config = UNDERLYINGS[underlying]
        symbols = {symbol.upper() for symbol in config["index_symbols"]}
        candidates = [item for item in instruments if item.get("exchange") == "NSE" and item.get("tradingsymbol", "").upper() in symbols]
        # Prefer the index segment; no token is hard-coded.
        candidates.sort(key=lambda item: (0 if "INDICES" in item.get("segment", "").upper() else 1, item.get("tradingsymbol", "")))
        return candidates[0] if candidates else None

    def _option_instruments(self, underlying: str, instruments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        names = {name.upper() for name in UNDERLYINGS[underlying]["option_names"]}
        return [
            item for item in instruments
            if item.get("exchange") == "NFO"
            and item.get("instrument_type") in {"CE", "PE"}
            and item.get("name", "").upper() in names
            and item.get("expiry") is not None
            and item.get("strike") is not None
        ]

    @staticmethod
    def _vix_instrument(instruments: list[dict[str, Any]]) -> dict[str, Any] | None:
        candidates = [item for item in instruments if item.get("exchange") == "NSE" and item.get("tradingsymbol", "").upper() == "INDIA VIX"]
        candidates.sort(key=lambda item: 0 if "INDICES" in item.get("segment", "").upper() else 1)
        return candidates[0] if candidates else None

    def _vix_quote(self, client: Any, instruments: list[dict[str, Any]], quotes: dict[str, dict[str, Any]] | None = None) -> dict[str, Any] | None:
        instrument = self._vix_instrument(instruments)
        if not instrument:
            return None
        key = f"{instrument['exchange']}:{instrument['tradingsymbol']}"
        quote_data = quotes if quotes is not None else self._quote(client, [key])
        market, tick = self._market_from(instrument, quote_data.get(key))
        if not market:
            return None
        return {
            "instrument_token": int(instrument["instrument_token"]),
            "last_price": market.get("spot"),
            "previous_close": market.get("previous_close"),
            "change": market.get("change"),
            "change_percent": market.get("change_percent"),
            "timestamp": market.get("timestamp"),
            "exchange_timestamp": market.get("exchange_timestamp"),
            "data_age_seconds": self._age_seconds((tick or {}).get("exchange_timestamp") or (tick or {}).get("timestamp")),
            "source": "kite_live",
        }

    def _enrich_tick(self, tick: dict[str, Any], instrument: dict[str, Any]) -> dict[str, Any] | None:
        """Calculate IV / Greeks for an option tick when all real inputs exist."""
        option_type = instrument.get("instrument_type")
        if option_type not in {"CE", "PE"} or not self._instruments:
            return None
        name = str(instrument.get("name") or "").upper()
        underlying = next((symbol for symbol, config in UNDERLYINGS.items() if name in {value.upper() for value in config["option_names"]}), None)
        if underlying is None:
            return None
        index = self._index_instrument(underlying, self._instruments)
        if not index:
            return None
        spot_tick = self.store.latest(int(index["instrument_token"]))
        spot = _number(spot_tick.get("last_price")) if spot_tick else None
        years = time_to_expiry_years(instrument.get("expiry"))
        strike = _number(instrument.get("strike"))
        bid, ask = _number(tick.get("bid")), _number(tick.get("ask"))
        last = _number(tick.get("last_price"))
        price = (bid + ask) / 2 if bid is not None and ask is not None and bid > 0 and ask >= bid else last
        iv = implied_volatility(price, spot, strike, years, settings.risk_free_rate, option_type)
        calculated = greeks(spot, strike, years, settings.risk_free_rate, iv, option_type)
        return {
            "iv": iv,
            "iv_method": "Black-Scholes calculated from Kite quote" if iv is not None else None,
            **calculated,
            "greeks_method": "Black-Scholes calculated" if iv is not None else None,
        }

    def get_underlyings(self) -> list[dict[str, str]]:
        return [{"symbol": symbol, "label": data["label"]} for symbol, data in UNDERLYINGS.items()]

    def get_expiries(self, underlying: str) -> list[dict[str, str]]:
        underlying = underlying.upper()
        if underlying not in UNDERLYINGS:
            raise KiteServiceError("Unsupported underlying. Select NIFTY or BANKNIFTY.", 404)
        instruments = self._ensure_instruments()
        today = datetime.now(IST).date()
        dates = sorted({item["expiry"] for item in self._option_instruments(underlying, instruments) if item["expiry"] >= today})
        return [{"value": expiry.isoformat(), "label": expiry.strftime("%d %b %Y")} for expiry in dates]

    def _quote(self, client: Any, keys: list[str]) -> dict[str, dict[str, Any]]:
        if not keys:
            return {}
        try:
            value = client.quote(keys)
            return value if isinstance(value, dict) else {}
        except Exception as exc:
            log.warning("Kite quote request failed for %d instruments: %s", len(keys), safe_error(exc, settings.kite_api_secret, settings.kite_access_token, self._access_token))
            return {}

    def _market_from(self, instrument: dict[str, Any], raw: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        token = int(instrument["instrument_token"])
        if raw:
            tick = self.store.observe(raw, instrument, source="kite_live")
        else:
            tick = self.store.latest(token)
        if not tick or tick.get("last_price") is None:
            return None, tick
        ohlc = tick.get("ohlc") or {}
        prev_close = _number(ohlc.get("close"))
        spot = _number(tick.get("last_price"))
        change = spot - prev_close if spot is not None and prev_close not in (None, 0) else None
        change_pct = change / prev_close * 100.0 if change is not None and prev_close not in (None, 0) else None
        market = {
            "spot": spot,
            "previous_close": prev_close,
            "open": _number(ohlc.get("open")),
            "day_high": _number(ohlc.get("high")),
            "day_low": _number(ohlc.get("low")),
            "change": change,
            "change_percent": change_pct,
            "timestamp": tick.get("timestamp"),
            "exchange_timestamp": tick.get("exchange_timestamp"),
            "instrument_token": token,
            "tradingsymbol": instrument.get("tradingsymbol"),
            "source": tick.get("source", "kite_live"),
        }
        return market, tick

    def get_market(self, underlying: str) -> dict[str, Any]:
        underlying = underlying.upper()
        if underlying not in UNDERLYINGS:
            raise KiteServiceError("Unsupported underlying. Select NIFTY or BANKNIFTY.", 404)
        client = self._require_client()
        instruments = self._ensure_instruments()
        index = self._index_instrument(underlying, instruments)
        if not index:
            raise KiteServiceError(f"Kite's instrument master has no index contract for {underlying}.", 404)
        key = f"{index['exchange']}:{index['tradingsymbol']}"
        vix_instrument = self._vix_instrument(instruments)
        vix_key = f"{vix_instrument['exchange']}:{vix_instrument['tradingsymbol']}" if vix_instrument else None
        quotes = self._quote(client, [key] + ([vix_key] if vix_key else []))
        market, tick = self._market_from(index, quotes.get(key))
        if market is None:
            raise KiteServiceError(f"Kite has not supplied a usable live quote for {underlying}.", 502)
        market["data_age_seconds"] = self._age_seconds((tick.get("exchange_timestamp") or tick.get("timestamp"))) if tick else None
        market["stale"] = market["data_age_seconds"] is not None and market["data_age_seconds"] > settings.stale_after_seconds
        market["vix"] = self._vix_quote(client, instruments, quotes)
        return market

    @staticmethod
    def _age_seconds(timestamp: str | None) -> float | None:
        if not timestamp:
            return None
        try:
            value = datetime.fromisoformat(timestamp)
            return max(0.0, (datetime.now(IST) - value.astimezone(IST)).total_seconds())
        except ValueError:
            return None

    def get_option_chain(self, underlying: str, expiry: str, strike_range: int = 10) -> dict[str, Any]:
        underlying = underlying.upper()
        if underlying not in UNDERLYINGS:
            raise KiteServiceError("Unsupported underlying. Select NIFTY or BANKNIFTY.", 404)
        if strike_range not in (5, 10, 15, 20):
            raise KiteServiceError("Strike range must be one of ±5, ±10, ±15 or ±20.", 422)
        try:
            expiry_date = date.fromisoformat(expiry[:10])
        except (ValueError, TypeError):
            raise KiteServiceError("Expiry must be supplied as YYYY-MM-DD.", 422)

        client = self._require_client()
        instruments = self._ensure_instruments()
        index = self._index_instrument(underlying, instruments)
        if not index:
            raise KiteServiceError(f"Kite's instrument master has no index contract for {underlying}.", 404)
        options = [item for item in self._option_instruments(underlying, instruments) if item["expiry"] == expiry_date]
        if not options:
            raise KiteServiceError("No listed option contracts were found for that underlying and expiry.", 404)

        index_key = f"{index['exchange']}:{index['tradingsymbol']}"
        all_strikes = sorted({float(item["strike"]) for item in options})
        option_by_strike: dict[float, dict[str, dict[str, Any]]] = {}
        for item in options:
            option_by_strike.setdefault(float(item["strike"]), {})[item["instrument_type"]] = item

        # Spot is obtained from a real Kite quote or recent KiteTicker observation.
        # Fetch only the underlying and the optional India VIX index before ATM
        # discovery. Selected option quotes are fetched in one separate batch.
        vix_instrument = self._vix_instrument(instruments)
        vix_key = f"{vix_instrument['exchange']}:{vix_instrument['tradingsymbol']}" if vix_instrument else None
        index_quotes = self._quote(client, [index_key] + ([vix_key] if vix_key else []))
        market, spot_tick = self._market_from(index, index_quotes.get(index_key))
        vix = self._vix_quote(client, instruments, index_quotes)
        if not market or market.get("spot") is None:
            raise KiteServiceError(f"Kite has not supplied a usable live {underlying} spot quote; ATM cannot be calculated.", 502)
        spot = float(market["spot"])
        atm = nearest_strike(spot, all_strikes)
        selected_strikes = strike_window(all_strikes, atm, strike_range)
        if atm is None or not selected_strikes:
            raise KiteServiceError("No listed strikes are available around the live ATM price.", 502)

        selected_instruments = [
            leg for strike in selected_strikes for leg in option_by_strike.get(strike, {}).values()
        ]
        keys = [f"{item['exchange']}:{item['tradingsymbol']}" for item in selected_instruments]
        quotes = self._quote(client, keys)
        # Kite's full ticker mode is restricted to the selected range and spot.
        self.stream.set_instruments(instruments)
        subscribe_tokens = {int(index["instrument_token"]), *(int(item["instrument_token"]) for item in selected_instruments)}
        if vix_instrument:
            subscribe_tokens.add(int(vix_instrument["instrument_token"]))
        self.stream.subscribe(subscribe_tokens)

        years = time_to_expiry_years(expiry_date)
        chain: list[dict[str, Any]] = []
        for strike in selected_strikes:
            row: dict[str, Any] = {
                "strike": strike,
                "is_atm": strike == atm,
                "near_atm": abs(selected_strikes.index(strike) - selected_strikes.index(atm)) <= 2,
                "ce": None,
                "pe": None,
            }
            for option_type, field in (("CE", "ce"), ("PE", "pe")):
                instrument = option_by_strike.get(strike, {}).get(option_type)
                if not instrument:
                    continue
                key = f"{instrument['exchange']}:{instrument['tradingsymbol']}"
                raw_quote = quotes.get(key)
                if raw_quote:
                    tick = self.store.observe(raw_quote, instrument, source="kite_live")
                else:
                    tick = self.store.latest(int(instrument["instrument_token"]))
                tick = tick or {}
                ohlc = tick.get("ohlc") or {}
                ltp = _number(tick.get("last_price"))
                bid = _number(tick.get("bid"))
                ask = _number(tick.get("ask"))
                oi = _number(tick.get("oi"))
                previous_oi = _number(tick.get("previous_oi"))
                oi_delta = _number(tick.get("change_oi"))
                volume = _number(tick.get("volume"))
                close = _number(ohlc.get("close"))
                price_change = ltp - close if ltp is not None and close not in (None, 0) else None
                price_change_percent = price_change / close * 100.0 if price_change is not None and close not in (None, 0) else None
                iv_price = (bid + ask) / 2.0 if bid is not None and ask is not None and bid > 0 and ask >= bid else ltp
                iv = implied_volatility(iv_price, spot, strike, years, settings.risk_free_rate, option_type)
                computed_greeks = greeks(spot, strike, years, settings.risk_free_rate, iv, option_type)
                leg = {
                    "instrument_token": int(instrument["instrument_token"]),
                    "tradingsymbol": instrument["tradingsymbol"],
                    "lot_size": instrument.get("lot_size"),
                    "timestamp": tick.get("timestamp"),
                    "exchange_timestamp": tick.get("exchange_timestamp"),
                    "last_price": ltp,
                    "previous_close": close,
                    "price_change": price_change,
                    "price_change_percent": price_change_percent,
                    "volume": volume,
                    "oi": oi,
                    "previous_oi": previous_oi,
                    "change_oi": oi_delta,
                    "change_oi_percent": _number(tick.get("change_oi_percent")),
                    "bid": bid,
                    "ask": ask,
                    "bid_quantity": _number(tick.get("bid_quantity")),
                    "ask_quantity": _number(tick.get("ask_quantity")),
                    "buy_quantity": _number(tick.get("buy_quantity")),
                    "sell_quantity": _number(tick.get("sell_quantity")),
                    "ohlc": ohlc,
                    "iv": iv,
                    "iv_method": "Black-Scholes calculated from Kite quote" if iv is not None else None,
                    **computed_greeks,
                    "greeks_method": "Black-Scholes calculated" if iv is not None else None,
                    "activity": option_activity(price_change, oi_delta),
                    "source": tick.get("source", "kite_live") if tick else None,
                    "data_age_seconds": self._age_seconds(tick.get("exchange_timestamp") or tick.get("timestamp")) if tick.get("timestamp") else None,
                }
                row[field] = leg
            chain.append(row)

        oi_analysis = build_oi_analysis(chain, settings.oi_wall_percentile)
        atm_row = next((row for row in chain if row["is_atm"]), None)
        atm_ivs = [leg.get("iv") for leg in ((atm_row or {}).get("ce"), (atm_row or {}).get("pe")) if leg and leg.get("iv") is not None]
        atm_iv = sum(atm_ivs) / len(atm_ivs) if atm_ivs else None
        expected = expected_move(spot, atm_iv, years)
        spot_age = self._age_seconds(market.get("exchange_timestamp") or market.get("timestamp"))
        quote_ages = [spot_age] + [
            leg.get("data_age_seconds")
            for row in chain for leg in (row.get("ce"), row.get("pe"))
            if leg is not None and leg.get("data_age_seconds") is not None
        ]
        stale = any(age > settings.stale_after_seconds for age in quote_ages if age is not None)
        current_phase = market_phase()
        data_status = "stale" if stale else ("live" if current_phase == "LIVE" else "market_closed")
        signal = build_signal(
            spot_change_percent=market.get("change_percent"),
            oi=oi_analysis,
            chain=chain,
            market_live=data_status == "live",
        )
        snapshot_timestamp = datetime.now(IST).isoformat(timespec="milliseconds")
        self.persistence.persist_signal(underlying, expiry_date, snapshot_timestamp, signal)
        return {
            "underlying": underlying,
            "underlying_label": UNDERLYINGS[underlying]["label"],
            "expiry": expiry_date.isoformat(),
            "strike_range": strike_range,
            "spot": market,
            "vix": vix,
            "atm": atm,
            "atm_iv": atm_iv,
            "atm_iv_method": "mean of available ATM CE / PE Black-Scholes IV" if atm_iv is not None else None,
            "expected_move": expected,
            "expected_move_formula": "spot × annualized ATM IV × sqrt(time to expiry / 365)" if expected is not None else None,
            "expected_upper": spot + expected if expected is not None else None,
            "expected_lower": spot - expected if expected is not None else None,
            "time_to_expiry_years": years,
            "risk_free_rate": settings.risk_free_rate,
            "oi_analysis": oi_analysis,
            "strikes": chain,
            "instrument_token": int(index["instrument_token"]),
            "timestamp": snapshot_timestamp,
            "source": "kite_live",
            "data_status": data_status,
            "stale_after_seconds": settings.stale_after_seconds,
            "signal": signal,
            "oi_baseline_note": "Change OI is measured from the first observed OI per contract per IST trading day, not previous close.",
            "greeks_note": "Greeks and IV are calculated with Black-Scholes from genuine Kite quotes; Kite does not provide these fields in its quote response.",
        }

    def get_signal(self, underlying: str) -> dict[str, Any]:
        underlying = underlying.upper()
        expiries = self.get_expiries(underlying)
        if not expiries:
            raise KiteServiceError(f"No current expiries are listed for {underlying}.", 404)
        chain = self.get_option_chain(underlying, expiries[0]["value"], 5)
        signal = build_signal(
            spot_change_percent=chain["spot"].get("change_percent"),
            oi=chain.get("oi_analysis"),
            chain=chain.get("strikes", []),
            market_live=chain.get("data_status") == "live",
        )
        return {**signal, "underlying": underlying, "expiry": chain["expiry"], "timestamp": chain["timestamp"], "source": "kite_live"}

    def get_history(self, instrument_token: int, from_date: datetime, to_date: datetime, interval: str) -> dict[str, Any]:
        allowed = {"minute", "3minute", "5minute", "10minute", "15minute", "30minute", "60minute", "day"}
        if interval not in allowed:
            raise KiteServiceError("Unsupported interval. Use minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute or day.", 422)
        client = self._require_client()
        instruments = self._ensure_instruments()
        instrument = self._instrument_by_token.get(int(instrument_token))
        if not instrument:
            raise KiteServiceError("Instrument token is not present in the latest Kite instrument master.", 404)
        try:
            rows = client.historical_data(
                int(instrument_token),
                from_date,
                to_date,
                interval,
                continuous=False,
                oi=True,
            )
        except Exception as exc:
            log.error("Kite historical-data request failed for token %s: %s", instrument_token, safe_error(exc, settings.kite_api_secret, settings.kite_access_token, self._access_token))
            raise KiteServiceError("Kite did not return historical candles for this instrument and interval.", 502) from exc
        candles = []
        for row in rows or []:
            stamp = row.get("date")
            candles.append({
                "timestamp": _iso(stamp),
                "open": _number(row.get("open")),
                "high": _number(row.get("high")),
                "low": _number(row.get("low")),
                "close": _number(row.get("close")),
                "volume": _number(row.get("volume")),
                "oi": _number(row.get("oi")),
            })
        self.persistence.persist_candles(
            int(instrument_token),
            instrument.get("tradingsymbol"),
            interval,
            [{**candle, "date": candle["timestamp"]} for candle in candles if candle.get("timestamp")],
            expiry=instrument.get("expiry"),
            strike=instrument.get("strike"),
            option_type=instrument.get("instrument_type") if instrument.get("instrument_type") in {"CE", "PE"} else None,
        )
        return {
            "instrument_token": int(instrument_token),
            "tradingsymbol": instrument.get("tradingsymbol"),
            "interval": interval,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
            "source": "kite_historical",
            "candles": candles,
        }
