"""Centralized logging configuration for August Proxy.

Provides structured JSON logging with per-module level overrides and
request correlation IDs. Called once at startup from main.py lifespan.

Usage:
    from app.lib.logging_config import setup_logging
    setup_logging()

Environment:
    AUGUST_LOG_LEVELS: comma-separated module:level overrides.
        Example: "providers:DEBUG,adapters:WARNING,sandbox:ERROR"
    AUGUST_LOG_FORMAT: "json" (default) or "text" for human-readable.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextvars import ContextVar

# Request correlation ID — set by middleware, readable by any module.
request_id_var: ContextVar[str] = ContextVar('request_id', default='')


class RequestIdFilter(logging.Filter):
    """Injects the current request_id into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get('')  # type: ignore[attr-defined]
        return True


class JsonFormatter(logging.Formatter):
    """Structured JSON log formatter."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(record.created))
            + f'.{int(record.msecs):03d}Z',
            'level': record.levelname,
            'module': record.name,
            'msg': record.getMessage(),
        }
        rid = getattr(record, 'request_id', '')
        if rid:
            entry['request_id'] = rid
        if record.exc_info and record.exc_info[0] is not None:
            entry['exception'] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class TextFormatter(logging.Formatter):
    """Human-readable log formatter with request ID."""

    def __init__(self) -> None:
        super().__init__(
            fmt='%(asctime)s %(levelname)-7s [%(name)s] %(message)s',
            datefmt='%H:%M:%S',
        )


def _parse_level_overrides() -> dict[str, int]:
    """Parse AUGUST_LOG_LEVELS env var into {module: level} dict."""
    raw = os.environ.get('AUGUST_LOG_LEVELS', '')
    overrides: dict[str, int] = {}
    if not raw.strip():
        return overrides
    for pair in raw.split(','):
        pair = pair.strip()
        if ':' not in pair:
            continue
        module, level_name = pair.rsplit(':', 1)
        level = getattr(logging, level_name.strip().upper(), None)
        if isinstance(level, int):
            overrides[module.strip()] = level
    return overrides


def setup_logging() -> None:
    """Configure root logger with structured output and per-module overrides.

    Idempotent — safe to call multiple times (replaces handlers).
    """
    root = logging.getLogger()

    # Remove existing handlers to avoid duplicates on re-init
    for handler in root.handlers[:]:
        root.removeHandler(handler)

    # Choose formatter
    log_format = os.environ.get('AUGUST_LOG_FORMAT', 'json').lower()
    formatter: logging.Formatter
    if log_format == 'text':
        formatter = TextFormatter()
    else:
        formatter = JsonFormatter()

    # Console handler (stderr)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)
    handler.addFilter(RequestIdFilter())
    root.addHandler(handler)

    # Default level
    root.setLevel(logging.INFO)

    # Per-module overrides
    for module, level in _parse_level_overrides().items():
        logging.getLogger(module).setLevel(level)

    # Quiet noisy third-party loggers
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
