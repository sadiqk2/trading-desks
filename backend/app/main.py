"""FastAPI entry point for the Kite-backed Option Intelligence Dashboard."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from app.config import IST_ZONE, settings
from app.db.session import engine, ping_database
from app.services.analytics import calculate_risk, market_phase, market_phase_note
from app.security import safe_error
from app.schemas import (
    ChainSnapshotResponse,
    ExpiryResponse,
    HistoryResponse,
    MarketQuoteResponse,
    MarketStatusResponse,
    OIEndpointResponse,
    RiskResponse,
    SignalResponse,
    SystemStatusResponse,
    UnderlyingResponse,
)
from app.services.kite_service import KiteService, KiteServiceError
from app.services.kite_stream import KiteStream
from app.services.market_store import MarketStore
from app.services.persistence import MarketPersistence
from app.services.providers import HistoricalMarketDataProvider, LiveMarketDataProvider
from app.services.redis_cache import RedisMarketCache

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("option-intelligence")
IST = ZoneInfo(IST_ZONE)

cache = RedisMarketCache()
market_store = MarketStore(cache)
persistence = MarketPersistence()
kite_stream = KiteStream(settings.kite_api_key, market_store)
kite_service = KiteService(market_store, kite_stream, persistence)
live_provider = LiveMarketDataProvider(kite_service)
historical_provider = HistoricalMarketDataProvider(kite_service, persistence)
market_store.set_persistence(persistence)


@asynccontextmanager
async def lifespan(app: FastAPI):
    market_store.set_loop(asyncio.get_running_loop())
    if kite_service.authenticated:
        try:
            # Download the current instrument dump once after startup. A failed
            # request leaves the app up in a clearly disconnected state.
            await run_in_threadpool(kite_service._ensure_instruments)
            kite_stream.start(kite_service._access_token)
        except KiteServiceError as exc:
            log.warning("Startup Kite instrument refresh skipped: %s", exc)
        except Exception as exc:
            log.warning("Startup Kite initialization failed: %s", exc)
    yield
    kite_stream.stop()
    if engine is not None:
        engine.dispose()


app = FastAPI(
    title="Option Intelligence Dashboard API",
    version="1.0.0",
    description="Live-only options analytics backed by Kite Connect. No order execution endpoints are exposed.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(KiteServiceError)
async def kite_error_handler(request: Request, exc: KiteServiceError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": str(exc), "source": "kite_connect", "data_available": False},
    )


@app.get("/api/health", response_model=SystemStatusResponse)
@app.get("/api/system/status", response_model=SystemStatusResponse)
async def system_status() -> dict[str, Any]:
    status = market_store.status()
    phase = market_phase()
    age = status.get("data_age_seconds")
    return {
        "application": "option-intelligence-dashboard",
        "kite": "authenticated" if kite_service.authenticated else "disconnected",
        "kite_configured": settings.kite_configured,
        "websocket": kite_stream.status(),
        "database": "configured" if persistence.configured else "not_configured",
        "database_reachable": await run_in_threadpool(ping_database),
        "redis": cache.status(),
        "market_phase": phase,
        "market_phase_note": market_phase_note(),
        "last_tick_at": status.get("last_tick_at"),
        "data_age_seconds": age,
        "data_stale": age is not None and age > settings.stale_after_seconds,
        "stale_after_seconds": settings.stale_after_seconds,
        "last_error": status.get("last_error"),
        "server_time": datetime.now(IST).isoformat(timespec="seconds"),
    }


@app.get("/api/market/status", response_model=MarketStatusResponse)
async def market_status() -> dict[str, Any]:
    now = datetime.now(IST)
    return {
        "status": market_phase(now),
        "timestamp": now.isoformat(timespec="seconds"),
        "timezone": "Asia/Kolkata",
        "session": "09:15–15:30 IST, weekdays",
        "note": market_phase_note(),
    }


@app.get("/api/underlyings", response_model=list[UnderlyingResponse])
async def underlyings() -> list[dict[str, str]]:
    return kite_service.get_underlyings()


@app.get("/api/auth/status")
async def auth_status() -> dict[str, Any]:
    return {
        "kite_configured": settings.kite_configured,
        "authenticated": kite_service.authenticated,
        "websocket": kite_stream.status(),
    }


@app.get("/api/auth/login-url")
async def kite_login_url() -> dict[str, str]:
    return {"url": kite_service.login_url()}


@app.get("/api/auth/callback")
async def kite_callback(request: Request, request_token: str | None = None, status: str | None = None):
    frontend = settings.frontend_url.rstrip("/")
    if status == "success" and request_token:
        try:
            await run_in_threadpool(kite_service.exchange_request_token, request_token)
            # Refresh the instrument master without ever returning the access token.
            await run_in_threadpool(kite_service._ensure_instruments)
            return RedirectResponse(f"{frontend}/?kite=connected", status_code=303)
        except KiteServiceError:
            return RedirectResponse(f"{frontend}/?kite=failed", status_code=303)
    return RedirectResponse(f"{frontend}/?kite=failed", status_code=303)


@app.get("/api/expiries/{underlying}", response_model=list[ExpiryResponse])
async def expiries(underlying: str) -> list[dict[str, str]]:
    return await run_in_threadpool(live_provider.get_expiries, underlying)


@app.get("/api/option-chain/{underlying}/{expiry}", response_model=ChainSnapshotResponse)
async def option_chain(
    underlying: str,
    expiry: str,
    strike_range: int = Query(default=10, alias="range", ge=5, le=20),
) -> dict[str, Any]:
    if strike_range not in (5, 10, 15, 20):
        raise HTTPException(status_code=422, detail="Range must be 5, 10, 15 or 20 strikes.")
    return await run_in_threadpool(live_provider.get_option_chain, underlying, expiry, strike_range)


@app.get("/api/market/{underlying}", response_model=MarketQuoteResponse)
async def market(underlying: str) -> dict[str, Any]:
    return await run_in_threadpool(live_provider.get_market, underlying)


@app.get("/api/oi-analysis/{underlying}/{expiry}", response_model=OIEndpointResponse)
async def oi_analysis(
    underlying: str,
    expiry: str,
    strike_range: int = Query(default=10, alias="range", ge=5, le=20),
) -> dict[str, Any]:
    snapshot = await run_in_threadpool(live_provider.get_option_chain, underlying, expiry, strike_range)
    return {"underlying": underlying.upper(), "expiry": snapshot["expiry"], **snapshot["oi_analysis"], "timestamp": snapshot["timestamp"], "source": "kite_live"}


@app.get("/api/signals/{underlying}", response_model=SignalResponse)
async def signal(underlying: str) -> dict[str, Any]:
    return await run_in_threadpool(live_provider.get_signal, underlying)


@app.get("/api/history/{instrument_token}", response_model=HistoryResponse)
async def history(
    instrument_token: int,
    from_date: date | None = None,
    to_date: date | None = None,
    interval: str = Query(default="minute"),
) -> dict[str, Any]:
    today = datetime.now(IST).date()
    start_day = from_date or today
    end_day = to_date or today
    if start_day > end_day:
        raise HTTPException(status_code=422, detail="from_date must be before or equal to to_date.")
    start = datetime.combine(start_day, time(9, 15), IST)
    end = datetime.combine(end_day, time(15, 30), IST)
    return await run_in_threadpool(live_provider.get_history, instrument_token, start, end, interval)


@app.get("/api/risk/calculate")
async def risk_calculate(
    capital: float | None = None,
    risk_percent: float | None = None,
    entry: float | None = None,
    stop: float | None = None,
    target: float | None = None,
    lot_size: int | None = None,
    lots: int | None = None,
) -> dict[str, Any]:
    return calculate_risk(capital, risk_percent, entry, stop, target, lot_size, lots)


@app.websocket("/ws/market")
async def market_websocket(
    websocket: WebSocket,
    underlying: str | None = None,
    expiry: str | None = None,
    strike_range: int = 10,
):
    await websocket.accept()
    await market_store.add_client(websocket, set())
    try:
        if underlying and expiry:
            try:
                if strike_range not in (5, 10, 15, 20):
                    raise KiteServiceError("Strike range must be 5, 10, 15 or 20.", 422)
                snapshot = await run_in_threadpool(live_provider.get_option_chain, underlying, expiry, strike_range)
                tokens = {int(snapshot["instrument_token"])}
                if snapshot.get("vix") and snapshot["vix"].get("instrument_token") is not None:
                    tokens.add(int(snapshot["vix"]["instrument_token"]))
                for row in snapshot.get("strikes", []):
                    for side in ("ce", "pe"):
                        leg = row.get(side)
                        if leg and leg.get("instrument_token") is not None:
                            tokens.add(int(leg["instrument_token"]))
                await market_store.add_client(websocket, tokens)
                kite_stream.subscribe(market_store.client_tokens())
                await websocket.send_json({"type": "snapshot", "data": snapshot})
            except KiteServiceError as exc:
                await websocket.send_json({"type": "error", "error": str(exc), "status_code": exc.status_code})
        else:
            await websocket.send_json({"type": "status", "data": await system_status()})

        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
                if message == "ping":
                    await websocket.send_json({"type": "pong", "server_time": datetime.now(IST).isoformat(timespec="seconds")})
            except asyncio.TimeoutError:
                await websocket.send_json({
                    "type": "heartbeat",
                    "server_time": datetime.now(IST).isoformat(timespec="seconds"),
                    "websocket": kite_stream.status(),
                    "market_phase": market_phase(),
                    **market_store.status(),
                })
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("Market WebSocket closed: %s", safe_error(exc, settings.kite_api_secret, settings.kite_access_token, kite_service._access_token))
    finally:
        await market_store.remove_client(websocket)
        if market_store.client_tokens():
            kite_stream.subscribe(market_store.client_tokens())
        else:
            kite_stream.subscribe(set())
