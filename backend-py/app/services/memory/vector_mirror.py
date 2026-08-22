"""Vector-mirror reconciliation — repair auto_memories ↔ vector_entries drift.

Every ``saveAutoMemory`` mirrors its row into ``vector_entries``
(namespace ``auto_memory``, metadata key = memory key) for hybrid recall.
That fan-out is best-effort: swallowed exceptions, TTL pruning (which never
deleted the twin), and supersession gaps can leave a SQL row without its
vector twin (recall silently loses that memory) or an orphaned twin (recall
surfaces deleted memories). This module diffs both stores and repairs the
mirror; it never deletes memories and never rewrites content — only vector
twins.

Round-4 loop audit.
"""

from __future__ import annotations

import json
import logging
import time

from app.json_narrowing import as_int, as_str

logger = logging.getLogger(__name__)

_LAST_KEY = 'cognitive:vector_reconciliation:last_run'


def _memory_conn():
    from app.services.memory_store import _conn

    return _conn()


def _vector_rows() -> dict[str, str]:
    """Map metadata.key → vector entry id for the auto_memory namespace."""
    from app.services.memory import vector_db

    conn = vector_db._conn()
    rows = conn.execute(
        "SELECT id, metadata FROM vector_entries WHERE namespace = 'auto_memory'"
    ).fetchall()
    out: dict[str, str] = {}
    for r in rows:
        try:
            meta = json.loads(r['metadata'] or '{}')
        except (json.JSONDecodeError, TypeError):
            continue
        key = meta.get('key') if isinstance(meta, dict) else None
        if key:
            out[str(key)] = str(r['id'])
    return out


def reconcile_vector_mirror(*, reembed_limit: int = 50) -> dict[str, object]:
    """Diff auto_memories against their vector twins and repair both ways.

    Returns a report::

        {
          'scanned': int,            # auto_memories rows examined
          'missing': int,            # rows whose twin was absent
          'missing_repaired': int,   # twins re-embedded this run
          'missing_degraded': int,   # skipped because the encoder is degraded
          'orphans': int,            # twins whose memory row vanished
          'orphans_removed': int,
        }
    """
    from app.services.memory import vector_db

    report: dict[str, object] = {
        'scanned': 0,
        'missing': 0,
        'missing_repaired': 0,
        'missing_degraded': 0,
        'orphans': 0,
        'orphans_removed': 0,
    }
    conn = _memory_conn()
    memRows = conn.execute('SELECT key, content FROM auto_memories').fetchall()
    report['scanned'] = len(memRows)
    vecKeys = _vector_rows()

    degraded = bool(vector_db.embeddingStatus().get('degraded'))
    repaired = 0
    for row in memRows:
        key = as_str(row['key'], '')
        if not key or key in vecKeys:
            continue
        report['missing'] = as_int(report['missing'], 0) + 1
        if degraded:
            # Re-embedding with the lossy char-freq fallback would write
            # garbage vectors that later look "healthy" — wait for a real
            # encoder instead.
            report['missing_degraded'] = as_int(report['missing_degraded'], 0) + 1
            continue
        if repaired >= reembed_limit:
            continue
        try:
            text = f'{key}: {row["content"]}'[:4000]
            vector_db.upsert(text, metadata={'key': key}, namespace='auto_memory')
            repaired += 1
        except Exception:
            logger.debug('reconcile: re-embed failed for %s', key, exc_info=True)
    report['missing_repaired'] = repaired

    memKeys = {as_str(r['key'], '') for r in memRows}
    orphanIds = [vid for k, vid in vecKeys.items() if k not in memKeys]
    report['orphans'] = len(orphanIds)
    removed = 0
    for vid in orphanIds:
        try:
            if vector_db.delete(vid):
                removed += 1
        except Exception:
            logger.debug('reconcile: orphan delete failed for %s', vid, exc_info=True)
    report['orphans_removed'] = removed

    _persist_report(report)
    return report


def _persist_report(report: dict[str, object]) -> None:
    try:
        from app.services.brain_write_facade import save_kv

        payload = dict(report)
        payload['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save_kv(_LAST_KEY, payload)
    except Exception:
        logger.debug('reconcile: persist report failed', exc_info=True)


def last_reconciliation() -> dict[str, object] | None:
    """Last reconciliation report (KV-persisted), or None."""
    try:
        from app.services.memory_store import get_memory

        stored = get_memory(_LAST_KEY)
        if isinstance(stored, dict):
            return dict(stored)
    except Exception:
        pass
    return None
