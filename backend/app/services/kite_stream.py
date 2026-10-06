"""KiteTicker lifecycle and selected-contract subscription manager."""
from __future__ import annotations

import logging
import threading
from typing import Any

from app.services.market_store import MarketStore
from app.security import safe_error

log = logging.getLogger(__name__)


class KiteStream:
    def __init__(self, api_key: str, store: MarketStore) -> None:
        self.api_key = api_key
        self.store = store
        self.access_token: str | None = None
        self.ticker: Any = None
        self.connected = False
        self._tokens: set[int] = set()
        self._instruments: dict[int, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def set_instruments(self, instruments: list[dict[str, Any]]) -> None:
        with self._lock:
            self._instruments = {int(item["instrument_token"]): item for item in instruments if item.get("instrument_token") is not None}

    def start(self, access_token: str) -> None:
        """Create/recreate the Kite WebSocket; credentials are never logged."""
        with self._lock:
            if self.ticker is not None and self.access_token == access_token:
                return
            self._close_locked()
            try:
                from kiteconnect import KiteTicker

                ticker = KiteTicker(
                    self.api_key,
                    access_token,
                    reconnect=True,
                    reconnect_max_tries=50,
                    reconnect_max_delay=60,
                )
                ticker.on_ticks = self._on_ticks
                ticker.on_connect = self._on_connect
                ticker.on_close = self._on_close
                ticker.on_error = self._on_error
                ticker.on_reconnect = self._on_reconnect
                ticker.on_noreconnect = self._on_noreconnect
                self.ticker = ticker
                self.access_token = access_token
                try:
                    ticker.enable_reconnect(reconnect=True, interval=5, retries=50)
                except (AttributeError, TypeError):
                    # Constructor reconnect options are supported by KiteTicker versions
                    # where enable_reconnect is not exposed.
                    pass
                ticker.connect(threaded=True)
                log.info("Kite market WebSocket connection requested (automatic reconnect enabled)")
            except Exception as exc:
                self.ticker = None
                self.connected = False
                log.error("Could not start KiteTicker: %s", safe_error(exc, access_token, self.access_token))
                raise RuntimeError("Could not start Kite market WebSocket. Check the backend logs.") from exc

    def subscribe(self, tokens: set[int]) -> None:
        requested = {int(token) for token in tokens if token is not None}
        with self._lock:
            self._tokens = requested
            ticker = self.ticker
            connected = self.connected
            if not ticker or not connected:
                return
            try:
                # A single dashboard selection is active. Unsubscribe only the old
                # dashboard tokens so the stream does not accumulate unused contracts.
                currently = getattr(self, "_subscribed_tokens", set())
                removed = currently - requested
                added = requested - currently
                if removed:
                    ticker.unsubscribe(list(removed))
                if added:
                    ticker.subscribe(list(added))
                if requested:
                    ticker.set_mode(ticker.MODE_FULL, list(requested))
                self._subscribed_tokens = set(requested)
                log.info("Kite subscriptions updated: %d selected instruments", len(requested))
            except Exception as exc:
                log.warning("Kite subscription update failed: %s", safe_error(exc, self.access_token))

    def stop(self) -> None:
        with self._lock:
            self._close_locked()
            self.access_token = None

    def _close_locked(self) -> None:
        ticker = self.ticker
        self.ticker = None
        self.connected = False
        self._subscribed_tokens: set[int] = set()
        if ticker is not None:
            try:
                ticker.close()
            except Exception as exc:
                log.debug("KiteTicker close returned an error: %s", exc)

    def _on_connect(self, websocket: Any, response: Any) -> None:
        with self._lock:
            self.connected = True
            tokens = set(self._tokens)
            ticker = self.ticker
            log.info("Kite market WebSocket connected")
            if ticker and tokens:
                try:
                    ticker.subscribe(list(tokens))
                    ticker.set_mode(ticker.MODE_FULL, list(tokens))
                    self._subscribed_tokens = set(tokens)
                except Exception as exc:
                    log.warning("Initial Kite subscription failed: %s", safe_error(exc, self.access_token))

    def _on_ticks(self, websocket: Any, ticks: list[dict[str, Any]]) -> None:
        for raw in ticks or []:
            try:
                token = int(raw.get("instrument_token"))
                instrument = self._instruments.get(token)
                if instrument:
                    self.store.observe(raw, instrument, source="kite_live")
                else:
                    log.warning("Received a Kite tick for an instrument not in the current master: %s", token)
            except Exception as exc:
                log.warning("Rejected malformed Kite tick: %s", exc)

    def _on_close(self, websocket: Any, code: Any, reason: Any) -> None:
        self.connected = False
        log.warning("Kite market WebSocket closed (code=%s, reason=%s)", code, safe_error(reason, self.access_token))

    def _on_error(self, websocket: Any, code: Any, reason: Any) -> None:
        self.connected = False
        log.error("Kite market WebSocket error (code=%s, reason=%s)", code, safe_error(reason, self.access_token))

    def _on_reconnect(self, websocket: Any, attempts_count: int) -> None:
        self.connected = False
        log.warning("Kite market WebSocket reconnecting (attempt %s)", attempts_count)

    def _on_noreconnect(self, websocket: Any) -> None:
        self.connected = False
        log.error("Kite market WebSocket stopped retrying; refresh the Kite access token")

    def status(self) -> str:
        if self.connected:
            return "connected"
        if self.ticker is not None:
            return "reconnecting"
        return "disconnected"
