"""Deterministic calculations used by live and historical data providers.

Kite Connect does not return option IV or Greeks. Those fields are derived here
with Black-Scholes only when a genuine option price, spot, strike and expiry are
available. `iv` and its Greeks are nullable; missing inputs stay unavailable.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from math import erf, exp, log, pi, sqrt
from zoneinfo import ZoneInfo
from typing import Any, Iterable

IST = ZoneInfo("Asia/Kolkata")
TRADING_DAYS_PER_YEAR = 365.0


def _finite(value: Any) -> float | None:
    try:
        result = float(value)
        return result if result == result and abs(result) != float("inf") else None
    except (TypeError, ValueError):
        return None


def nearest_strike(spot: float | None, strikes: Iterable[float]) -> float | None:
    """Return the listed strike nearest to a genuine spot observation."""
    values = sorted({float(value) for value in strikes if _finite(value) is not None})
    if spot is None or not values:
        return None
    return min(values, key=lambda strike: (abs(strike - spot), strike))


def strike_window(strikes: Iterable[float], atm: float | None, radius: int) -> list[float]:
    """Select `radius` listed strikes on either side of ATM, including ATM."""
    values = sorted({float(value) for value in strikes if _finite(value) is not None})
    if atm is None or atm not in values:
        return []
    index = values.index(atm)
    return values[max(0, index - radius): index + radius + 1]


def change_oi(current_oi: float | None, baseline_oi: float | None) -> float | None:
    if current_oi is None or baseline_oi is None:
        return None
    return float(current_oi) - float(baseline_oi)


def change_oi_percent(current_oi: float | None, baseline_oi: float | None) -> float | None:
    if current_oi is None or baseline_oi is None or baseline_oi == 0:
        return None
    return (float(current_oi) - float(baseline_oi)) / abs(float(baseline_oi)) * 100.0


def pcr(total_put_oi: float | None, total_call_oi: float | None) -> float | None:
    if total_put_oi is None or total_call_oi in (None, 0):
        return None
    return float(total_put_oi) / float(total_call_oi)


def percentile(values: Iterable[float], percent: float) -> float | None:
    """Linear-interpolated percentile over observed values (no synthetic input)."""
    points = sorted(float(x) for x in values if _finite(x) is not None)
    if not points:
        return None
    rank = (max(0.0, min(100.0, percent)) / 100.0) * (len(points) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(points) - 1)
    weight = rank - lower
    return points[lower] * (1.0 - weight) + points[upper] * weight


def expiry_datetime(expiry: date | datetime | str | None) -> datetime | None:
    if expiry is None:
        return None
    if isinstance(expiry, datetime):
        if expiry.tzinfo is None:
            return expiry.replace(tzinfo=IST)
        return expiry.astimezone(IST)
    if isinstance(expiry, date):
        return datetime.combine(expiry, time(15, 30), IST)
    try:
        parsed = date.fromisoformat(str(expiry)[:10])
        return datetime.combine(parsed, time(15, 30), IST)
    except (ValueError, TypeError):
        return None


def time_to_expiry_years(expiry: date | datetime | str | None, now: datetime | None = None) -> float | None:
    target = expiry_datetime(expiry)
    if target is None:
        return None
    current = now or datetime.now(IST)
    if current.tzinfo is None:
        current = current.replace(tzinfo=IST)
    seconds = (target - current.astimezone(IST)).total_seconds()
    if seconds <= 0:
        return None
    return seconds / (TRADING_DAYS_PER_YEAR * 24.0 * 60.0 * 60.0)


def expected_move(spot: float | None, iv: float | None, years: float | None) -> float | None:
    """One-standard-deviation move: spot × annualized IV × sqrt(time)."""
    if spot is None or iv is None or years is None or spot <= 0 or iv <= 0 or years <= 0:
        return None
    return float(spot) * float(iv) * sqrt(float(years))


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def _pdf(x: float) -> float:
    return exp(-0.5 * x * x) / sqrt(2.0 * pi)


def black_scholes_price(spot: float, strike: float, years: float, rate: float, vol: float, option_type: str) -> float | None:
    if min(spot, strike, years, vol) <= 0:
        return None
    root_t = sqrt(years)
    d1 = (log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * root_t)
    d2 = d1 - vol * root_t
    discounted_strike = strike * exp(-rate * years)
    if option_type.upper() in {"CE", "CALL"}:
        return spot * _cdf(d1) - discounted_strike * _cdf(d2)
    if option_type.upper() in {"PE", "PUT"}:
        return discounted_strike * _cdf(-d2) - spot * _cdf(-d1)
    return None


def implied_volatility(
    option_price: float | None,
    spot: float | None,
    strike: float | None,
    years: float | None,
    rate: float,
    option_type: str,
) -> float | None:
    """Bisection IV using a supplied genuine option price and Black-Scholes."""
    if None in (option_price, spot, strike, years) or min(option_price, spot, strike, years) <= 0:
        return None
    option_type = option_type.upper()
    if option_type not in {"CE", "PE", "CALL", "PUT"}:
        return None
    intrinsic = max(0.0, spot - strike) if option_type in {"CE", "CALL"} else max(0.0, strike - spot)
    if option_price + 1e-8 < intrinsic:
        return None
    low, high = 1e-5, 5.0
    p_low = black_scholes_price(spot, strike, years, rate, low, option_type)
    p_high = black_scholes_price(spot, strike, years, rate, high, option_type)
    if p_low is None or p_high is None or option_price > p_high + 1e-6:
        return None
    # Expired contracts are excluded above. Avoid reporting a numerical zero IV
    # when the option is exactly intrinsic and no time value can be resolved.
    if option_price <= p_low:
        return None
    for _ in range(100):
        mid = (low + high) / 2.0
        theoretical = black_scholes_price(spot, strike, years, rate, mid, option_type)
        if theoretical is None:
            return None
        if abs(theoretical - option_price) < 1e-8:
            return mid
        if theoretical < option_price:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def greeks(
    spot: float | None,
    strike: float | None,
    years: float | None,
    rate: float,
    iv: float | None,
    option_type: str,
) -> dict[str, float | None]:
    """Black-Scholes delta, gamma, theta per day, and vega per vol point."""
    result: dict[str, float | None] = {"delta": None, "gamma": None, "theta": None, "vega": None}
    if None in (spot, strike, years, iv) or min(spot, strike, years, iv) <= 0:
        return result
    option_type = option_type.upper()
    if option_type not in {"CE", "PE", "CALL", "PUT"}:
        return result
    root_t = sqrt(years)
    d1 = (log(spot / strike) + (rate + 0.5 * iv * iv) * years) / (iv * root_t)
    d2 = d1 - iv * root_t
    pdf = _pdf(d1)
    call = option_type in {"CE", "CALL"}
    delta = _cdf(d1) if call else _cdf(d1) - 1.0
    gamma = pdf / (spot * iv * root_t)
    theta_year = (
        -(spot * pdf * iv) / (2.0 * root_t)
        - rate * strike * exp(-rate * years) * (_cdf(d2) if call else _cdf(-d2))
        + (rate * spot * _cdf(d1) if call else -rate * spot * _cdf(-d1))
    )
    vega_per_vol_point = spot * pdf * root_t / 100.0
    result.update(
        delta=delta,
        gamma=gamma,
        theta=theta_year / TRADING_DAYS_PER_YEAR,
        vega=vega_per_vol_point,
    )
    return result


def option_activity(price_change: float | None, oi_change: float | None) -> str:
    """Descriptive price/OI quadrant; it is not a prediction."""
    if price_change is None or oi_change is None or price_change == 0 or oi_change == 0:
        return "NEUTRAL"
    if price_change > 0 and oi_change > 0:
        return "LONG_BUILDUP"
    if price_change < 0 and oi_change > 0:
        return "SHORT_BUILDUP"
    if price_change > 0 and oi_change < 0:
        return "SHORT_COVERING"
    if price_change < 0 and oi_change < 0:
        return "LONG_UNWINDING"
    return "NEUTRAL"


def build_oi_analysis(chain: list[dict[str, Any]], wall_percentile: int = 90) -> dict[str, Any]:
    """Summarize only the contracts present in the selected chain window."""
    def total(side: str, field: str) -> float | None:
        legs = [row.get(side) for row in chain if row.get(side) is not None]
        if not legs or any(leg.get(field) is None for leg in legs):
            return None
        return float(sum(leg[field] for leg in legs))

    ce_legs = [row.get("ce") for row in chain if row.get("ce") is not None]
    pe_legs = [row.get("pe") for row in chain if row.get("pe") is not None]
    ce_oi_coverage = sum(leg.get("oi") is not None for leg in ce_legs)
    pe_oi_coverage = sum(leg.get("oi") is not None for leg in pe_legs)
    ce_change_coverage = sum(leg.get("change_oi") is not None for leg in ce_legs)
    pe_change_coverage = sum(leg.get("change_oi") is not None for leg in pe_legs)
    total_ce = total("ce", "oi")
    total_pe = total("pe", "oi")
    ce_changes = total("ce", "change_oi")
    pe_changes = total("pe", "change_oi")

    def top_strike(side: str, field: str) -> float | None:
        candidates = [(row.get(side, {}).get(field), row.get("strike")) for row in chain if row.get(side)]
        candidates = [(value, strike) for value, strike in candidates if value is not None and strike is not None]
        return max(candidates, key=lambda item: item[0])[1] if candidates else None

    ce_points = [(row["strike"], row["ce"].get("oi")) for row in chain if row.get("ce") and row["ce"].get("oi") is not None]
    pe_points = [(row["strike"], row["pe"].get("oi")) for row in chain if row.get("pe") and row["pe"].get("oi") is not None]
    ce_threshold = percentile((value for _, value in ce_points), wall_percentile)
    pe_threshold = percentile((value for _, value in pe_points), wall_percentile)

    def walls(points: list[tuple[float, float]], threshold: float | None) -> list[dict[str, float]]:
        if threshold is None:
            return []
        return [
            {"strike": float(strike), "oi": float(value)}
            for strike, value in sorted(points, key=lambda item: item[1], reverse=True)
            if value >= threshold
        ][:5]

    ce_concentration = None
    pe_concentration = None
    if total_ce:
        ce_concentration = sum(value for _, value in sorted(ce_points, key=lambda item: item[1], reverse=True)[:3]) / total_ce
    if total_pe:
        pe_concentration = sum(value for _, value in sorted(pe_points, key=lambda item: item[1], reverse=True)[:3]) / total_pe

    return {
        "total_ce_oi": total_ce,
        "total_pe_oi": total_pe,
        "total_ce_change_oi": ce_changes,
        "total_pe_change_oi": pe_changes,
        "ce_oi_coverage": {"observed": ce_oi_coverage, "contracts": len(ce_legs)},
        "pe_oi_coverage": {"observed": pe_oi_coverage, "contracts": len(pe_legs)},
        "ce_change_oi_coverage": {"observed": ce_change_coverage, "contracts": len(ce_legs)},
        "pe_change_oi_coverage": {"observed": pe_change_coverage, "contracts": len(pe_legs)},
        "pcr": pcr(total_pe, total_ce),
        "highest_ce_oi_strike": top_strike("ce", "oi"),
        "highest_pe_oi_strike": top_strike("pe", "oi"),
        "highest_ce_change_oi_strike": top_strike("ce", "change_oi"),
        "highest_pe_change_oi_strike": top_strike("pe", "change_oi"),
        "ce_concentration_top_3": ce_concentration,
        "pe_concentration_top_3": pe_concentration,
        "oi_wall_percentile": wall_percentile,
        "ce_oi_walls": walls(ce_points, ce_threshold),
        "pe_oi_walls": walls(pe_points, pe_threshold),
        "scope": "selected strikes only",
    }


def build_signal(
    *,
    spot_change_percent: float | None,
    oi: dict[str, Any] | None,
    chain: list[dict[str, Any]],
    market_live: bool,
) -> dict[str, Any]:
    """Transparent, small rule score. It is an observation, never advice."""
    if not market_live:
        return {"direction": None, "score": None, "max_score": None, "confidence": None, "reasons": [], "status": "market_closed"}
    factors: list[tuple[int, str]] = []
    if spot_change_percent is not None and spot_change_percent != 0:
        factors.append((1 if spot_change_percent > 0 else -1, "Spot above / below previous close"))

    pcr_value = (oi or {}).get("pcr")
    if pcr_value is not None:
        if pcr_value >= 1.05:
            factors.append((1, "Selected-window PCR ≥ 1.05"))
        elif pcr_value <= 0.95:
            factors.append((-1, "Selected-window PCR ≤ 0.95"))

    # Near-ATM OI changes are compared only when both sides have observations.
    near_rows = [row for row in chain if row.get("near_atm")]
    ce_legs = [row["ce"] for row in near_rows if row.get("ce")]
    pe_legs = [row["pe"] for row in near_rows if row.get("pe")]
    ce_delta = [leg.get("change_oi") for leg in ce_legs]
    pe_delta = [leg.get("change_oi") for leg in pe_legs]
    if ce_delta and pe_delta and all(value is not None for value in ce_delta + pe_delta):
        put_add = sum(max(0.0, value) for value in pe_delta)
        call_add = sum(max(0.0, value) for value in ce_delta)
        if put_add != call_add:
            factors.append((1 if put_add > call_add else -1, "Near-ATM put / call OI additions"))

    # Compare genuine option prices and intraday OI deltas in a small ATM band.
    pe_short = ce_unwind = ce_short = pe_unwind = 0
    activity_legs = ce_legs + pe_legs
    activity_complete = bool(ce_legs and pe_legs) and all(
        leg.get("price_change") is not None and leg.get("change_oi") is not None
        for leg in activity_legs
    )
    if activity_complete:
        for row in near_rows:
            for side in ("ce", "pe"):
                leg = row.get(side)
                if not leg:
                    continue
                activity = leg.get("activity")
                if side == "pe" and activity == "SHORT_BUILDUP":
                    pe_short += 1
                elif side == "ce" and activity == "LONG_UNWINDING":
                    ce_unwind += 1
                elif side == "ce" and activity == "SHORT_BUILDUP":
                    ce_short += 1
                elif side == "pe" and activity == "LONG_UNWINDING":
                    pe_unwind += 1
        if pe_short + ce_unwind != ce_short + pe_unwind:
            factors.append((1 if pe_short + ce_unwind > ce_short + pe_unwind else -1, "Near-ATM price/OI classifications"))

    all_ce_legs = [row["ce"] for row in chain if row.get("ce")]
    all_pe_legs = [row["pe"] for row in chain if row.get("pe")]
    call_vol = sum(leg["volume"] for leg in all_ce_legs if leg.get("volume") is not None)
    put_vol = sum(leg["volume"] for leg in all_pe_legs if leg.get("volume") is not None)
    volume_complete = bool(all_ce_legs and all_pe_legs) and all(
        leg.get("volume") is not None for leg in all_ce_legs + all_pe_legs
    )
    if volume_complete and call_vol != put_vol:
        factors.append((1 if put_vol > call_vol else -1, "Selected-window put / call traded volume"))

    if not factors:
        return {"direction": None, "score": 0, "max_score": 0, "confidence": None, "reasons": [], "status": "insufficient_data"}
    score = sum(point for point, _ in factors)
    direction = "BULLISH" if score >= 2 else "BEARISH" if score <= -2 else "NEUTRAL"
    return {
        "direction": direction,
        "score": score,
        "max_score": len(factors),
        "confidence": round(abs(score) / len(factors) * 100),
        "reasons": [{"effect": "positive" if point > 0 else "negative", "text": text} for point, text in factors],
        "status": "observational_rule_score",
        "disclaimer": "Deterministic market observation only; not a forecast or financial advice.",
    }


def calculate_risk(
    capital: float | None,
    risk_percent: float | None,
    entry: float | None,
    stop: float | None,
    target: float | None,
    lot_size: int | None,
    lots: int | None,
) -> dict[str, float | int | None]:
    """Pure position-sizing arithmetic; contains no broker margin assumptions."""
    values = (capital, risk_percent, entry, stop, target, lot_size, lots)
    if any(value is None for value in values):
        return {"max_risk": None, "risk_per_lot": None, "position_size": None, "required_capital": None, "potential_profit": None, "risk_reward": None, "max_lots_by_risk": None}
    if capital < 0 or risk_percent < 0 or entry < 0 or stop < 0 or target < 0 or lot_size <= 0 or lots < 0:
        return {"max_risk": None, "risk_per_lot": None, "position_size": None, "required_capital": None, "potential_profit": None, "risk_reward": None, "max_lots_by_risk": None}
    max_risk = capital * risk_percent / 100.0
    risk_per_unit = abs(entry - stop)
    risk_per_lot = risk_per_unit * lot_size
    max_lots = int(max_risk // risk_per_lot) if risk_per_lot > 0 else None
    quantity = lot_size * lots
    actual_risk = risk_per_unit * quantity
    cost = entry * quantity
    potential_profit = (target - entry) * quantity
    reward_per_unit = abs(target - entry)
    risk_reward = reward_per_unit / risk_per_unit if risk_per_unit else None
    return {
        "max_risk": max_risk,
        "risk_per_lot": risk_per_lot,
        "position_size": quantity,
        "required_capital": cost,
        "potential_profit": potential_profit,
        "actual_stop_risk": actual_risk,
        "risk_reward": risk_reward,
        "max_lots_by_risk": max_lots,
    }


def market_phase(now: datetime | None = None) -> str:
    """IST weekday schedule only; Kite does not expose an exchange calendar here."""
    current = now or datetime.now(IST)
    if current.tzinfo is None:
        current = current.replace(tzinfo=IST)
    current = current.astimezone(IST)
    if current.weekday() >= 5:
        return "MARKET_CLOSED"
    open_at = current.replace(hour=9, minute=15, second=0, microsecond=0)
    close_at = current.replace(hour=15, minute=30, second=0, microsecond=0)
    if current < open_at:
        return "PRE_MARKET"
    if current < close_at:
        return "LIVE"
    return "MARKET_CLOSED"


def market_phase_note() -> str:
    return "Calculated from the NSE weekday session schedule (09:15–15:30 IST); exchange holidays are not queried."
