"""Environment-backed configuration. Secrets are kept server-side only."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv

    # Support `uvicorn app.main:app` from either the repository or backend folder.
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    load_dotenv()
except ImportError:  # pragma: no cover - dotenv is installed in supported setups
    pass


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    kite_api_key: str = os.getenv("KITE_API_KEY", "").strip()
    kite_api_secret: str = os.getenv("KITE_API_SECRET", "").strip()
    kite_access_token: str = os.getenv("KITE_ACCESS_TOKEN", "").strip()
    kite_redirect_url: str = os.getenv(
        "KITE_REDIRECT_URL", "http://localhost:8000/api/auth/callback"
    ).strip()
    database_url: str = os.getenv("DATABASE_URL", "").strip()
    redis_url: str = os.getenv("REDIS_URL", "").strip()
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:5173").strip()
    risk_free_rate: float = _float("RISK_FREE_RATE", 0.06)
    oi_wall_percentile: int = max(50, min(99, _int("OI_WALL_PERCENTILE", 90)))
    stale_after_seconds: int = max(1, _int("STALE_AFTER_SECONDS", 15))
    log_level: str = os.getenv("LOG_LEVEL", "INFO").upper()

    @property
    def kite_configured(self) -> bool:
        return bool(self.kite_api_key and self.kite_api_secret)


settings = Settings()

# Supported index names are resolved against Kite's instrument master at runtime.
# These are display / symbol aliases, not hard-coded instrument tokens.
UNDERLYINGS: dict[str, dict[str, tuple[str, ...]]] = {
    "NIFTY": {
        "label": "NIFTY 50",
        "option_names": ("NIFTY",),
        "index_symbols": ("NIFTY 50", "NIFTY"),
    },
    "BANKNIFTY": {
        "label": "NIFTY BANK",
        "option_names": ("BANKNIFTY", "NIFTY BANK"),
        "index_symbols": ("NIFTY BANK", "BANKNIFTY"),
    },
}

VALID_STRIKE_RANGES = (5, 10, 15, 20)
IST_ZONE = "Asia/Kolkata"
