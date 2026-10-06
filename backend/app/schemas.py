"""Typed API contracts. Missing market observations are explicitly nullable."""
from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class UnderlyingResponse(ApiModel):
    symbol: str
    label: str


class ExpiryResponse(ApiModel):
    value: str
    label: str


class SystemStatusResponse(ApiModel):
    application: str
    kite: str
    kite_configured: bool
    websocket: str
    database: str
    database_reachable: bool
    redis: str
    market_phase: str
    market_phase_note: str
    last_tick_at: str | None
    data_age_seconds: float | None
    data_stale: bool
    stale_after_seconds: int
    last_error: str | None
    server_time: str


class MarketStatusResponse(ApiModel):
    status: str
    timestamp: str
    timezone: str
    session: str
    note: str


class OhlcResponse(ApiModel):
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None


class MarketQuoteResponse(ApiModel):
    spot: float | None = None
    previous_close: float | None = None
    open: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    change: float | None = None
    change_percent: float | None = None
    timestamp: str | None = None
    exchange_timestamp: str | None = None
    instrument_token: int
    tradingsymbol: str
    source: str
    data_age_seconds: float | None = None
    stale: bool | None = None
    vix: dict[str, Any] | None = None


class OptionLegResponse(ApiModel):
    instrument_token: int
    tradingsymbol: str
    lot_size: int | None = None
    timestamp: str | None = None
    exchange_timestamp: str | None = None
    last_price: float | None = None
    previous_close: float | None = None
    price_change: float | None = None
    price_change_percent: float | None = None
    volume: float | None = None
    oi: float | None = None
    previous_oi: float | None = None
    change_oi: float | None = None
    change_oi_percent: float | None = None
    bid: float | None = None
    ask: float | None = None
    bid_quantity: float | None = None
    ask_quantity: float | None = None
    buy_quantity: float | None = None
    sell_quantity: float | None = None
    ohlc: OhlcResponse | None = None
    iv: float | None = None
    iv_method: str | None = None
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    greeks_method: str | None = None
    activity: str
    source: str | None = None
    data_age_seconds: float | None = None


class OptionRowResponse(ApiModel):
    strike: float
    is_atm: bool
    near_atm: bool
    ce: OptionLegResponse | None = None
    pe: OptionLegResponse | None = None


class OIWallResponse(ApiModel):
    strike: float
    oi: float


class OICoverageResponse(ApiModel):
    observed: int
    contracts: int


class OIAnalysisResponse(ApiModel):
    total_ce_oi: float | None = None
    total_pe_oi: float | None = None
    total_ce_change_oi: float | None = None
    total_pe_change_oi: float | None = None
    ce_oi_coverage: OICoverageResponse
    pe_oi_coverage: OICoverageResponse
    ce_change_oi_coverage: OICoverageResponse
    pe_change_oi_coverage: OICoverageResponse
    pcr: float | None = None
    highest_ce_oi_strike: float | None = None
    highest_pe_oi_strike: float | None = None
    highest_ce_change_oi_strike: float | None = None
    highest_pe_change_oi_strike: float | None = None
    ce_concentration_top_3: float | None = None
    pe_concentration_top_3: float | None = None
    oi_wall_percentile: int
    ce_oi_walls: list[OIWallResponse]
    pe_oi_walls: list[OIWallResponse]
    scope: str


class OIEndpointResponse(OIAnalysisResponse):
    underlying: str
    expiry: str
    timestamp: str
    source: str


class SignalReasonResponse(ApiModel):
    effect: Literal["positive", "negative"]
    text: str


class SignalResponse(ApiModel):
    direction: Literal["BULLISH", "BEARISH", "NEUTRAL"] | None = None
    score: int | None = None
    max_score: int | None = None
    confidence: int | None = None
    reasons: list[SignalReasonResponse]
    status: str
    disclaimer: str | None = None
    underlying: str | None = None
    expiry: str | None = None
    timestamp: str | None = None
    source: str | None = None


class VixQuoteResponse(ApiModel):
    instrument_token: int
    last_price: float | None = None
    previous_close: float | None = None
    change: float | None = None
    change_percent: float | None = None
    timestamp: str | None = None
    exchange_timestamp: str | None = None
    data_age_seconds: float | None = None
    source: str


class ChainSnapshotResponse(ApiModel):
    underlying: str
    underlying_label: str
    expiry: str
    strike_range: int
    spot: MarketQuoteResponse
    vix: VixQuoteResponse | None = None
    atm: float
    atm_iv: float | None = None
    atm_iv_method: str | None = None
    expected_move: float | None = None
    expected_move_formula: str | None = None
    expected_upper: float | None = None
    expected_lower: float | None = None
    time_to_expiry_years: float | None = None
    risk_free_rate: float
    oi_analysis: OIAnalysisResponse
    strikes: list[OptionRowResponse]
    instrument_token: int
    timestamp: str
    source: str
    data_status: Literal["live", "stale", "market_closed"]
    stale_after_seconds: int
    signal: SignalResponse
    oi_baseline_note: str
    greeks_note: str


class HistoricalCandleResponse(ApiModel):
    timestamp: str | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    volume: float | None = None
    oi: float | None = None


class HistoryResponse(ApiModel):
    instrument_token: int
    tradingsymbol: str | None = None
    interval: str
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    source: str
    candles: list[HistoricalCandleResponse]


class RiskResponse(ApiModel):
    max_risk: float | None = None
    risk_per_lot: float | None = None
    position_size: int | None = None
    required_capital: float | None = None
    potential_profit: float | None = None
    actual_stop_risk: float | None = None
    risk_reward: float | None = None
    max_lots_by_risk: int | None = None
