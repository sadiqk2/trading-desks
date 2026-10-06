"""Optional SQLAlchemy engine. A missing/unavailable database is surfaced in status."""
from __future__ import annotations

import logging
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.security import safe_error

log = logging.getLogger(__name__)

engine = None
SessionLocal = None

def _database_url(url: str) -> str:
    # Support standard Render/Heroku DATABASE_URL values as well as explicit psycopg URLs.
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg" not in url:
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url

if settings.database_url:
    try:
        engine = create_engine(
            _database_url(settings.database_url),
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            connect_args={"connect_timeout": 3},
        )
        SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    except Exception as exc:  # URL/driver errors should not prevent a safe disconnected UI.
        log.error("Database configuration unavailable: %s", safe_error(exc, settings.database_url))
        engine = None
        SessionLocal = None


def ping_database() -> bool:
    if engine is None:
        return False
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        log.warning("Database health check failed: %s", safe_error(exc, settings.database_url))
        return False
