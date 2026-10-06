"""Best-effort persistence for genuine Kite instruments, ticks and history."""
from __future__ import annotations

import logging
import queue
import threading
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import settings
from app.security import safe_error
from app.db.models import Candle, Instrument, MarketTick, OISnapshot, OptionContract, OptionSnapshot, StrategySignal
from app.db.session import SessionLocal, engine

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")


class MarketPersistence:
    """PostgreSQL writer. High-frequency ticks are batched off the Kite callback thread."""

    def __init__(self) -> None:
        self._tick_queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=50000)
        self._worker: threading.Thread | None = None
        self._stopping = threading.Event()
        if self.configured:
            self._worker = threading.Thread(target=self._tick_writer, name="kite-tick-writer", daemon=True)
            self._worker.start()

    @property
    def configured(self) -> bool:
        return SessionLocal is not None and engine is not None

    def _tick_writer(self) -> None:
        while not self._stopping.is_set():
            try:
                first = self._tick_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if first is None:
                self._tick_queue.task_done()
                break
            batch = [first]
            deadline = time.monotonic() + 0.20
            while len(batch) < 500 and time.monotonic() < deadline:
                try:
                    item = self._tick_queue.get_nowait()
                    if item is None:
                        self._tick_queue.task_done()
                        self._stopping.set()
                        break
                    batch.append(item)
                except queue.Empty:
                    time.sleep(0.005)
            self._flush_ticks(batch)
            for _ in batch:
                self._tick_queue.task_done()

    def _flush_ticks(self, batch: list[dict[str, Any]]) -> None:
        if not batch or not self.configured:
            return
        ticks = []
        option_snapshots = []
        oi_snapshots = []
        for event in batch:
            tick = event["tick"]
            ticks.append(MarketTick(
                timestamp=datetime.fromisoformat(tick["timestamp"]),
                instrument_token=tick["instrument_token"],
                tradingsymbol=tick.get("tradingsymbol"),
                last_price=tick.get("last_price"),
                volume=tick.get("volume"),
                oi=tick.get("oi"),
                previous_oi=tick.get("previous_oi"),
                change_oi=tick.get("change_oi"),
                buy_quantity=tick.get("buy_quantity"),
                sell_quantity=tick.get("sell_quantity"),
                bid=tick.get("bid"),
                ask=tick.get("ask"),
                bid_quantity=tick.get("bid_quantity"),
                ask_quantity=tick.get("ask_quantity"),
                ohlc=tick.get("ohlc"),
                depth=tick.get("depth"),
                is_historical=False,
            ))
            snapshot = event.get("option_snapshot")
            if snapshot:
                option_snapshots.append(OptionSnapshot(**{**snapshot, "timestamp": datetime.fromisoformat(snapshot["timestamp"])}))
                oi_snapshots.append(OISnapshot(
                    timestamp=datetime.fromisoformat(snapshot["timestamp"]),
                    underlying=snapshot["underlying"],
                    expiry=snapshot["expiry"],
                    strike=snapshot["strike"],
                    option_type=snapshot["option_type"],
                    oi=snapshot.get("oi"),
                    previous_oi=snapshot.get("previous_oi"),
                    change_oi=snapshot.get("change_oi"),
                    source="kite_live",
                ))
        for attempt in range(3):
            try:
                with SessionLocal() as session:
                    session.add_all(ticks + option_snapshots + oi_snapshots)
                    session.commit()
                return
            except Exception as exc:
                log.warning("Batch market-data persistence failed (%d ticks, attempt %d): %s", len(ticks), attempt + 1, safe_error(exc, settings.database_url))
                time.sleep(0.25 * (attempt + 1))
        log.error("Dropped %d queued market observations after repeated PostgreSQL failures", len(ticks))

    def stop(self) -> None:
        if not self._worker or not self._worker.is_alive():
            return
        self._stopping.set()
        try:
            self._tick_queue.put_nowait(None)
        except queue.Full:
            pass
        self._worker.join(timeout=3)

    def persist_instruments(self, records: list[dict[str, Any]]) -> bool:
        if not self.configured or not records:
            return False
        now = datetime.now(IST)
        instrument_rows = []
        contract_rows = []
        for item in records:
            base = {
                "instrument_token": int(item["instrument_token"]),
                "exchange_token": item.get("exchange_token"),
                "tradingsymbol": item.get("tradingsymbol", ""),
                "name": item.get("name"),
                "last_price": item.get("last_price"),
                "expiry": item.get("expiry"),
                "strike": item.get("strike"),
                "tick_size": item.get("tick_size"),
                "lot_size": item.get("lot_size"),
                "instrument_type": item.get("instrument_type"),
                "segment": item.get("segment"),
                "exchange": item.get("exchange"),
                "updated_at": now,
            }
            instrument_rows.append(base)
            if item.get("instrument_type") in {"CE", "PE"} and item.get("expiry") and item.get("name"):
                contract_rows.append({
                    "instrument_token": int(item["instrument_token"]),
                    "underlying": str(item.get("name")),
                    "expiry": item["expiry"],
                    "strike": float(item.get("strike") or 0),
                    "option_type": item["instrument_type"],
                    "tradingsymbol": item.get("tradingsymbol", ""),
                    "lot_size": item.get("lot_size"),
                    "tick_size": item.get("tick_size"),
                    "updated_at": now,
                })
        try:
            with SessionLocal() as session:
                for offset in range(0, len(instrument_rows), 1000):
                    batch = instrument_rows[offset:offset + 1000]
                    statement = pg_insert(Instrument).values(batch)
                    update_fields = {key: getattr(statement.excluded, key) for key in batch[0] if key != "instrument_token"}
                    session.execute(statement.on_conflict_do_update(index_elements=[Instrument.instrument_token], set_=update_fields))
                for offset in range(0, len(contract_rows), 1000):
                    batch = contract_rows[offset:offset + 1000]
                    statement = pg_insert(OptionContract).values(batch)
                    update_fields = {key: getattr(statement.excluded, key) for key in batch[0] if key != "instrument_token"}
                    session.execute(statement.on_conflict_do_update(index_elements=[OptionContract.instrument_token], set_=update_fields))
                session.commit()
            log.info("Persisted Kite instrument master: %d instruments, %d option contracts", len(instrument_rows), len(contract_rows))
            return True
        except Exception as exc:
            log.error("Instrument master persistence failed: %s", safe_error(exc, settings.database_url))
            return False

    def persist_tick(self, tick: dict[str, Any], option_snapshot: dict[str, Any] | None = None) -> bool:
        if not self.configured:
            return False
        try:
            self._tick_queue.put_nowait({"tick": dict(tick), "option_snapshot": dict(option_snapshot) if option_snapshot else None})
            return True
        except queue.Full:
            log.error("PostgreSQL tick queue is full; latest tick remains available in Redis/in-process state")
            return False

    def persist_option_snapshots(self, rows: list[dict[str, Any]]) -> bool:
        if not self.configured or not rows:
            return False
        try:
            with SessionLocal() as session:
                for row in rows:
                    timestamp = datetime.fromisoformat(row["timestamp"])
                    session.add(OptionSnapshot(**{**row, "timestamp": timestamp}))
                    session.add(OISnapshot(
                        timestamp=timestamp,
                        underlying=row["underlying"],
                        expiry=row["expiry"],
                        strike=row["strike"],
                        option_type=row["option_type"],
                        oi=row.get("oi"),
                        previous_oi=row.get("previous_oi"),
                        change_oi=row.get("change_oi"),
                        source="kite_live",
                    ))
                session.commit()
            return True
        except Exception as exc:
            log.warning("Option snapshot persistence failed: %s", safe_error(exc, settings.database_url))
            return False

    def persist_candles(
        self,
        instrument_token: int,
        symbol: str | None,
        interval: str,
        candles: list[dict[str, Any]],
        expiry: Any = None,
        strike: float | None = None,
        option_type: str | None = None,
    ) -> bool:
        if not self.configured or not candles:
            return False
        try:
            with SessionLocal() as session:
                for candle in candles:
                    timestamp = candle.get("date") or candle.get("timestamp")
                    if isinstance(timestamp, str):
                        timestamp = datetime.fromisoformat(timestamp)
                    session.add(Candle(
                        timestamp=timestamp,
                        instrument_token=instrument_token,
                        tradingsymbol=symbol,
                        expiry=expiry,
                        strike=strike,
                        option_type=option_type,
                        interval=interval,
                        open=candle["open"],
                        high=candle["high"],
                        low=candle["low"],
                        close=candle["close"],
                        volume=candle.get("volume"),
                        oi=candle.get("oi"),
                        data_source="kite_historical",
                    ))
                session.commit()
            return True
        except Exception as exc:
            log.warning("Historical candle persistence failed: %s", safe_error(exc, settings.database_url))
            return False

    def persist_signal(self, underlying: str, expiry: Any, timestamp: str, signal: dict[str, Any]) -> bool:
        if not self.configured:
            return False
        try:
            with SessionLocal() as session:
                session.add(StrategySignal(
                    timestamp=datetime.fromisoformat(timestamp),
                    underlying=underlying,
                    expiry=expiry,
                    direction=signal.get("direction"),
                    score=signal.get("score"),
                    max_score=signal.get("max_score"),
                    reasons=signal.get("reasons", []),
                    source="kite_live",
                ))
                session.commit()
            return True
        except Exception as exc:
            log.warning("Strategy signal persistence failed: %s", safe_error(exc, settings.database_url))
            return False

    def load_historical_option_chain(self, underlying: str, expiry: Any, strike_range: int, as_of: datetime | None = None) -> dict[str, Any]:
        """Build a historical chain from persisted Kite observations only."""
        if not self.configured:
            raise RuntimeError("Historical database is not configured.")
        from sqlalchemy import desc
        from app.services.analytics import build_oi_analysis, nearest_strike, strike_window

        try:
            with SessionLocal() as session:
                query = session.query(OptionSnapshot).filter(
                    OptionSnapshot.underlying == underlying,
                    OptionSnapshot.expiry == expiry,
                )
                if as_of is not None:
                    query = query.filter(OptionSnapshot.timestamp <= as_of)
                snapshots = query.order_by(OptionSnapshot.timestamp.asc()).all()
                if not snapshots:
                    return {"source": "kite_historical", "underlying": underlying, "expiry": expiry.isoformat(), "strikes": [], "spot": None, "message": "No stored Kite option snapshots are available for this expiry and time."}

                latest_by_token: dict[int, OptionSnapshot] = {}
                previous_by_token: dict[int, OptionSnapshot] = {}
                for row in snapshots:
                    prior = latest_by_token.get(row.instrument_token)
                    if prior is not None:
                        previous_by_token[row.instrument_token] = prior
                    latest_by_token[row.instrument_token] = row

                symbol_candidates = {"NIFTY": ("NIFTY 50", "NIFTY"), "BANKNIFTY": ("NIFTY BANK", "BANKNIFTY")}.get(underlying, ())
                spot_query = session.query(MarketTick).filter(MarketTick.tradingsymbol.in_(symbol_candidates))
                if as_of is not None:
                    spot_query = spot_query.filter(MarketTick.timestamp <= as_of)
                spot_tick = spot_query.order_by(desc(MarketTick.timestamp)).first()
                spot_value = spot_tick.last_price if spot_tick else None
                strikes = sorted({float(row.strike) for row in latest_by_token.values()})
                atm = nearest_strike(spot_value, strikes)
                selected = strike_window(strikes, atm, strike_range)
                selected_set = set(selected)
                by_strike: dict[float, dict[str, Any]] = {}
                for row in latest_by_token.values():
                    strike = float(row.strike)
                    if strike not in selected_set:
                        continue
                    prior = previous_by_token.get(row.instrument_token)
                    price_change = row.ltp - prior.ltp if prior and row.ltp is not None and prior.ltp is not None else None
                    leg = {
                        "instrument_token": row.instrument_token,
                        "tradingsymbol": None,
                        "timestamp": row.timestamp.isoformat(),
                        "exchange_timestamp": None,
                        "last_price": row.ltp,
                        "bid": row.bid,
                        "ask": row.ask,
                        "volume": row.volume,
                        "oi": row.oi,
                        "previous_oi": row.previous_oi,
                        "change_oi": row.change_oi,
                        "iv": row.iv,
                        "delta": row.delta,
                        "gamma": row.gamma,
                        "theta": row.theta,
                        "vega": row.vega,
                        "price_change": price_change,
                        "activity": "NEUTRAL",
                        "source": "kite_historical",
                        "data_age_seconds": None,
                    }
                    if prior and row.ltp is not None and prior.ltp is not None and row.change_oi is not None:
                        from app.services.analytics import option_activity
                        leg["activity"] = option_activity(price_change, row.change_oi)
                    field = "ce" if row.option_type == "CE" else "pe"
                    by_strike.setdefault(strike, {"strike": strike, "ce": None, "pe": None})[field] = leg

                chain = []
                for strike in selected:
                    row = by_strike.get(strike, {"strike": strike, "ce": None, "pe": None})
                    row["is_atm"] = strike == atm
                    row["near_atm"] = atm is not None and abs(selected.index(strike) - selected.index(atm)) <= 2
                    chain.append(row)
                oi = build_oi_analysis(chain)
                return {
                    "source": "kite_historical",
                    "underlying": underlying,
                    "expiry": expiry.isoformat(),
                    "timestamp": max(row.timestamp for row in latest_by_token.values()).isoformat(),
                    "spot": {
                        "spot": spot_value,
                        "timestamp": spot_tick.timestamp.isoformat() if spot_tick else None,
                        "source": "kite_historical",
                    } if spot_tick else None,
                    "atm": atm,
                    "strike_range": strike_range,
                    "strikes": chain,
                    "oi_analysis": oi,
                    "market_data_mode": "historical_database",
                }
        except Exception as exc:
            log.error("Historical option-chain query failed: %s", safe_error(exc, settings.database_url))
            raise RuntimeError("Could not read the stored Kite historical option chain.") from exc
