"""SQLAlchemy persistence schema. Live and historical records remain separate."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
def now_ist() -> datetime:
    return datetime.now(IST)

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Instrument(Base):
    __tablename__ = "instruments"

    instrument_token: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    exchange_token: Mapped[int | None] = mapped_column(BigInteger)
    tradingsymbol: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str | None] = mapped_column(String(64), index=True)
    last_price: Mapped[float | None] = mapped_column(Float)
    expiry: Mapped[date | None] = mapped_column(Date, index=True)
    strike: Mapped[float | None] = mapped_column(Float, index=True)
    tick_size: Mapped[float | None] = mapped_column(Float)
    lot_size: Mapped[int | None] = mapped_column(Integer)
    instrument_type: Mapped[str | None] = mapped_column(String(16), index=True)
    segment: Mapped[str | None] = mapped_column(String(32), index=True)
    exchange: Mapped[str | None] = mapped_column(String(16), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_ist)


class OptionContract(Base):
    __tablename__ = "option_contracts"

    instrument_token: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    expiry: Mapped[date] = mapped_column(Date, index=True)
    strike: Mapped[float] = mapped_column(Float, index=True)
    option_type: Mapped[str] = mapped_column(String(2), index=True)
    tradingsymbol: Mapped[str] = mapped_column(String(64), index=True)
    lot_size: Mapped[int | None] = mapped_column(Integer)
    tick_size: Mapped[float | None] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_ist)


class MarketTick(Base):
    __tablename__ = "market_ticks"
    __table_args__ = (Index("ix_market_ticks_token_timestamp", "instrument_token", "timestamp"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    instrument_token: Mapped[int] = mapped_column(BigInteger, index=True)
    tradingsymbol: Mapped[str | None] = mapped_column(String(64), index=True)
    last_price: Mapped[float | None] = mapped_column(Float)
    volume: Mapped[float | None] = mapped_column(Float)
    oi: Mapped[float | None] = mapped_column(Float)
    previous_oi: Mapped[float | None] = mapped_column(Float)
    change_oi: Mapped[float | None] = mapped_column(Float)
    buy_quantity: Mapped[float | None] = mapped_column(Float)
    sell_quantity: Mapped[float | None] = mapped_column(Float)
    bid: Mapped[float | None] = mapped_column(Float)
    ask: Mapped[float | None] = mapped_column(Float)
    bid_quantity: Mapped[float | None] = mapped_column(Float)
    ask_quantity: Mapped[float | None] = mapped_column(Float)
    ohlc: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    depth: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    is_historical: Mapped[bool] = mapped_column(Boolean, default=False, index=True)


class OptionSnapshot(Base):
    __tablename__ = "option_snapshots"
    __table_args__ = (Index("ix_option_snapshots_underlying_expiry_timestamp", "underlying", "expiry", "timestamp"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    instrument_token: Mapped[int] = mapped_column(BigInteger, index=True)
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    expiry: Mapped[date] = mapped_column(Date, index=True)
    strike: Mapped[float] = mapped_column(Float, index=True)
    option_type: Mapped[str] = mapped_column(String(2), index=True)
    ltp: Mapped[float | None] = mapped_column(Float)
    bid: Mapped[float | None] = mapped_column(Float)
    ask: Mapped[float | None] = mapped_column(Float)
    volume: Mapped[float | None] = mapped_column(Float)
    oi: Mapped[float | None] = mapped_column(Float)
    previous_oi: Mapped[float | None] = mapped_column(Float)
    change_oi: Mapped[float | None] = mapped_column(Float)
    iv: Mapped[float | None] = mapped_column(Float)
    delta: Mapped[float | None] = mapped_column(Float)
    gamma: Mapped[float | None] = mapped_column(Float)
    theta: Mapped[float | None] = mapped_column(Float)
    vega: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(24), default="kite_live")


class Candle(Base):
    __tablename__ = "candles"
    __table_args__ = (Index("ix_candles_token_timestamp_interval", "instrument_token", "timestamp", "interval"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    instrument_token: Mapped[int] = mapped_column(BigInteger, index=True)
    tradingsymbol: Mapped[str | None] = mapped_column(String(64))
    expiry: Mapped[date | None] = mapped_column(Date, index=True)
    strike: Mapped[float | None] = mapped_column(Float)
    option_type: Mapped[str | None] = mapped_column(String(2))
    interval: Mapped[str] = mapped_column(String(16))
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float | None] = mapped_column(Float)
    oi: Mapped[float | None] = mapped_column(Float)
    data_source: Mapped[str] = mapped_column(String(24), default="kite_historical")


class OISnapshot(Base):
    __tablename__ = "oi_snapshots"
    __table_args__ = (Index("ix_oi_snapshots_underlying_expiry_timestamp", "underlying", "expiry", "timestamp"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    expiry: Mapped[date] = mapped_column(Date, index=True)
    strike: Mapped[float] = mapped_column(Float)
    option_type: Mapped[str] = mapped_column(String(2))
    oi: Mapped[float | None] = mapped_column(Float)
    previous_oi: Mapped[float | None] = mapped_column(Float)
    change_oi: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(24), default="kite_live")


class StrategySignal(Base):
    __tablename__ = "strategy_signals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    expiry: Mapped[date | None] = mapped_column(Date, index=True)
    direction: Mapped[str | None] = mapped_column(String(16))
    score: Mapped[int | None] = mapped_column(Integer)
    max_score: Mapped[int | None] = mapped_column(Integer)
    reasons: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    source: Mapped[str] = mapped_column(String(24), default="kite_live")


class Trade(Base):
    """Reserved analytical trade journal schema; version 1 does not place orders."""
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    instrument_token: Mapped[int | None] = mapped_column(BigInteger, index=True)
    tradingsymbol: Mapped[str | None] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(8))
    quantity: Mapped[int] = mapped_column(Integer)
    entry_price: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float | None] = mapped_column(Float)
    target_price: Mapped[float | None] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(Text)
    execution_status: Mapped[str] = mapped_column(String(24), default="analysis_only")


class BacktestRun(Base):
    __tablename__ = "backtest_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    underlying: Mapped[str] = mapped_column(String(32), index=True)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="queued")


class BacktestResult(Base):
    __tablename__ = "backtest_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("backtest_runs.id", ondelete="CASCADE"), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    instrument_token: Mapped[int | None] = mapped_column(BigInteger, index=True)
    action: Mapped[str] = mapped_column(String(16))
    price: Mapped[float | None] = mapped_column(Float)
    quantity: Mapped[int | None] = mapped_column(Integer)
    pnl: Mapped[float | None] = mapped_column(Float)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
