"""Redis latest-tick cache and pub/sub. Redis never supplies market values."""
from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings
from app.security import safe_error

log = logging.getLogger(__name__)


class RedisMarketCache:
    def __init__(self) -> None:
        self.client = None
        self.available = False
        if not settings.redis_url:
            return
        try:
            import redis

            self.client = redis.Redis.from_url(
                settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
                health_check_interval=30,
            )
            self.client.ping()
            self.available = True
        except Exception as exc:
            self.client = None
            self.available = False
            log.warning("Redis unavailable; in-process live updates remain active: %s", safe_error(exc, settings.redis_url))

    def save_tick(self, token: int, payload: dict[str, Any]) -> None:
        if not self.client:
            return
        try:
            encoded = json.dumps(payload, separators=(",", ":"), default=str, allow_nan=False)
            pipe = self.client.pipeline(transaction=False)
            pipe.set(f"kite:tick:{token}", encoded, ex=60 * 60 * 24)
            pipe.publish("kite:ticks", encoded)
            pipe.execute()
            self.available = True
        except Exception as exc:
            self.available = False
            log.warning("Redis tick write failed: %s", safe_error(exc, settings.redis_url))

    def latest_tick(self, token: int) -> dict[str, Any] | None:
        if not self.client:
            return None
        try:
            value = self.client.get(f"kite:tick:{token}")
            self.available = True
            return json.loads(value) if value else None
        except Exception as exc:
            self.available = False
            log.warning("Redis tick read failed: %s", safe_error(exc, settings.redis_url))
            return None

    def save_baseline(self, token: int, trading_day: str, oi: float) -> None:
        if not self.client:
            return
        try:
            self.client.set(f"kite:oi-baseline:{trading_day}:{token}", oi, ex=60 * 60 * 48)
            self.available = True
        except Exception as exc:
            self.available = False
            log.warning("Redis OI baseline write failed: %s", safe_error(exc, settings.redis_url))

    def get_baseline(self, token: int, trading_day: str) -> float | None:
        if not self.client:
            return None
        try:
            value = self.client.get(f"kite:oi-baseline:{trading_day}:{token}")
            self.available = True
            return float(value) if value is not None else None
        except Exception as exc:
            self.available = False
            log.warning("Redis OI baseline read failed: %s", safe_error(exc, settings.redis_url))
            return None

    def status(self) -> str:
        return "connected" if self.available else "unavailable"
