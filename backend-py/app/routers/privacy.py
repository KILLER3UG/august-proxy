"""Data & Privacy routes — inspect, export, and erase local user data.

The desktop app is local-first: providers' keys, memories, transcripts,
usage history, audit events, and observation screenshots all live on this
device. These endpoints give the Data & Privacy center a single surface
to summarize, export, and delete that data. Every destructive action is
opt-in and returns the number of rows it removed.

Tables (from app/services/memory_schema.py + migrations):
  facts, learned_heuristics, proposals, episodic_timeline,
  memory_store (system KV — memory purge keeps only live agent keys),
  sessions, messages,
  session_topics, usage_events, lifecycle (audit), config_audit,
  brain_events, tool_guardrail_log, consolidation_audit,
  friction_events, routing_evidence, subagent_runs
"""

from __future__ import annotations

import json
import time

from fastapi import APIRouter

from app.lib.paths import dataPath
from app.services import memory_store
from app.services.memory_conn import db_path
from app.services.post_observation import count_observations

router = APIRouter(prefix='/api/privacy')

# Tables that hold *user-visible* data (used for counts + export).
# auto_memories removed (Part 21 OQ1 retire, migration 033) — the table no
# longer exists; the export shape drops the key along with the store.
_COUNT_TABLES = [
    ('facts', 'facts'),
    ('learned_heuristics', 'heuristics'),
    ('proposals', 'proposals'),
    ('episodic_timeline', 'timeline'),
    ('sessions', 'sessions'),
    ('messages', 'messages'),
    ('usage_events', 'usageEvents'),
    ('lifecycle', 'auditEvents'),
    ('config_audit', 'configAudit'),
    ('routing_evidence', 'routingEvidence'),
    ('subagent_runs', 'subagentRuns'),
]

# Tables cleared by the "erase memory" action (the agent's knowledge of you).
_MEMORY_TABLES = [
    'facts',
    'learned_heuristics',
    'proposals',
    'episodic_timeline',
]

# memory_store KV keys that survive the memory purge — the only keys with a
# live writer (agent registry). Everything else in the KV is residue.
_KV_KEEP_KEYS = ('agent_registry', 'agent_jobs')

# Tables cleared by the "clear activity logs" action (telemetry/audit).
_LOG_TABLES = [
    'lifecycle',
    'config_audit',
    'brain_events',
    'tool_guardrail_log',
    'consolidation_audit',
    'friction_events',
]


def _count_table(conn, table: str) -> int:
    try:
        row = conn.execute(f'SELECT COUNT(*) AS c FROM {table}').fetchone()
        return int(row['c']) if row else 0
    except Exception:
        return 0


@router.get('/summary')
async def privacySummary():
    """Counts of everything the app stores about you, in one place."""
    conn = memory_store._conn()  # noqa: SLF001 — same module pattern as rest.py
    counts: dict[str, int] = {}
    for table, wire_key in _COUNT_TABLES:
        counts[wire_key] = _count_table(conn, table)
    counts['observations'] = count_observations()
    try:
        counts['dbSizeBytes'] = db_path().stat().st_size if db_path().exists() else 0
    except Exception:
        counts['dbSizeBytes'] = 0
    return {'counts': counts}


@router.post('/export')
async def privacyExport():
    """Bundle user data (memories, usage, sessions) into one JSON file.

    The export is a plain, readable JSON document — the user owns this
    data, so it should not need the app to read it back. Returns the
    file path + per-section entry counts.
    """
    conn = memory_store._conn()  # noqa: SLF001
    out: dict[str, object] = {
        'exportedAt': time.time(),
        'app': 'august-proxy',
        'facts': _select_all(conn, 'facts'),
        'heuristics': _select_all(conn, 'learned_heuristics'),
        'timeline': _select_all(conn, 'episodic_timeline'),
        'usageByModel': _usage_by_model(conn),
        'sessions': _select_all(conn, 'sessions'),
        'messages': _select_all(conn, 'messages'),
    }
    exports_dir = dataPath('exports')
    exports_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    path = exports_dir / f'august-export-{ts}.json'
    path.write_text(json.dumps(out, indent=2, default=str), encoding='utf-8')
    return {
        'path': str(path),
        'bytes': path.stat().st_size,
        'entries': {k: len(v) if isinstance(v, list) else 0 for k, v in out.items()},
    }


def _select_all(conn, table: str, limit: int = 2000) -> list[dict[str, object]]:
    """Rows as dicts, best-effort (missing tables return [])."""
    try:
        cur = conn.execute(f'SELECT * FROM {table} LIMIT {limit}')
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    except Exception:
        return []


def _usage_by_model(conn) -> list[dict[str, object]]:
    try:
        rows = conn.execute(
            'SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, '
            'SUM(output_tokens) AS output_tokens FROM usage_events GROUP BY model '
            'ORDER BY calls DESC LIMIT 100'
        ).fetchall()
        return [
            {
                'model': r['model'],
                'calls': int(r['calls']),
                'inputTokens': int(r['input_tokens'] or 0),
                'outputTokens': int(r['output_tokens'] or 0),
            }
            for r in rows
        ]
    except Exception:
        return []


def _delete_rows(conn, tables: list[str]) -> dict[str, int]:
    deleted: dict[str, int] = {}
    for table in tables:
        try:
            cur = conn.execute(f'DELETE FROM {table}')
            deleted[table] = max(0, int(cur.rowcount))
        except Exception:
            deleted[table] = 0
    conn.commit()
    return deleted


@router.post('/purge-memories')
async def purgeMemories():
    """Erase the agent's memory of you: facts, auto-memories, heuristics,
    proposals, the episodic timeline, and memory-adjacent KV residue.
    The KV purge keeps only the live agent registry/jobs keys."""
    conn = memory_store._conn()  # noqa: SLF001
    deleted = _delete_rows(conn, _MEMORY_TABLES)
    try:
        placeholders = ','.join('?' * len(_KV_KEEP_KEYS))
        cur = conn.execute(
            f'DELETE FROM memory_store WHERE key NOT IN ({placeholders})',
            _KV_KEEP_KEYS,
        )
        deleted['memoryStoreKv'] = max(0, int(cur.rowcount))
        conn.commit()
    except Exception:
        deleted['memoryStoreKv'] = 0
    # auto_memories_fts rebuild removed (Part 21 OQ1 retire, migration 033):
    # the store no longer exists. memory_store_fts is trigger-maintained and
    # repair_fts_sync() self-heals any desync at boot.
    # 2.7 (Part 25): the facts DELETE must drop the cached BM25 corpus, or
    # purged facts keep being injected until an unrelated write clears it —
    # a privacy hole ("erase my memory" that doesn't erase recall).
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    except Exception:
        pass
    return {'deleted': deleted}


@router.post('/clear-logs')
async def clearLogs():
    """Clear activity/audit/guardrail logs + observation screenshots."""
    conn = memory_store._conn()  # noqa: SLF001
    deleted = _delete_rows(conn, _LOG_TABLES)
    removed_screenshots = 0
    try:
        obs_dir = dataPath('observations')
        if obs_dir.is_dir():
            for f in obs_dir.glob('*.png'):
                try:
                    f.unlink()
                    removed_screenshots += 1
                except Exception:
                    pass
    except Exception:
        pass
    deleted['observationScreenshots'] = removed_screenshots
    return {'deleted': deleted}


@router.post('/delete-usage')
async def deleteUsage():
    """Delete token usage history (usage_events)."""
    conn = memory_store._conn()  # noqa: SLF001
    deleted = _delete_rows(conn, ['usage_events'])
    return {'deleted': deleted}


@router.post('/delete-sessions')
async def deleteSessions():
    """Delete every chat/workbench session, transcript, and topic row.

    Workbench sessions are removed through their own cascade-aware
    deleter so SQLite child rows and the JSON export file stay in sync.
    """
    conn = memory_store._conn()  # noqa: SLF001
    from app.services.workbench.sessions import delete_workbench_session, list_workbench_sessions

    removed_workbench = 0
    for summary in list_workbench_sessions():
        sid = str(summary.get('id') or '')
        if sid and delete_workbench_session(sid):
            removed_workbench += 1
    deleted = _delete_rows(conn, ['messages', 'session_topics', 'sessions'])
    deleted['workbenchSessions'] = removed_workbench
    return {'deleted': deleted}
