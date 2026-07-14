"""Brain write facade — single transactional entry for multi-table brain writes.

Long-term write path for must-succeed brain mutations. Prefer this over
ad-hoc multi-statement commits that can leave partial state, and over
``db_writer`` for user-visible or consolidation apply steps that must not
be age-dropped.
"""

from __future__ import annotations

import logging
from typing import Callable

logger = logging.getLogger(__name__)


def run_in_transaction(fn: Callable[[object], object]) -> object:
    """Run ``fn(conn)`` inside a single SQLite transaction and commit.

    On exception the transaction is rolled back and the error is re-raised.
    """
    from app.services.memory_store import _conn

    conn = _conn()
    try:
        result = fn(conn)
        conn.commit()
        return result
    except Exception:
        try:
            conn.rollback()
        except Exception:
            logger.debug('rollback failed', exc_info=True)
        raise


def apply_sql_batch(statements: list[tuple[str, tuple[object, ...]]]) -> int:
    """Execute many parameterized SQL statements in one transaction.

    Returns the number of statements executed.
    """

    def _do(conn: object) -> int:
        n = 0
        for sql, params in statements:
            conn.execute(sql, params)  # type: ignore[attr-defined]
            n += 1
        return n

    return int(run_in_transaction(_do) or 0)


def save_kv(key: str, value: object) -> None:
    """Transactional key-value write (memory_store)."""
    from app.services.memory_store import save_memory

    save_memory(key, value)  # type: ignore[arg-type]
