"""
Heuristics service — CRUD over the learned_heuristics table (Phase 4).

The table was created in Phase 0; this service provides the application
layer for adding, removing, listing, and clearing heuristics.

Writes are performed DIRECTLY through ``memory_store`` (the shared,
thread-local brain connection). Every connection opened by
``memory_store._conn`` sets ``PRAGMA journal_mode=WAL`` and
``PRAGMA busy_timeout=10000``, so direct writes from the many callers are
safe from "database is locked" errors and corruption under WAL.

``db_writer`` (``app.services.db_writer``) is a SEPARATE single-writer queue
that serializes writes through one asyncio worker task. It is an ADDITIONAL
serialization layer, NOT the universal write path: as of this writing it is
used only by ``consolidation_daemon``. This service does NOT enqueue through
``db_writer``; it commits changes directly via ``memory_store``.
"""

from __future__ import annotations


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as getConn

    return getConn()


def listHeuristics(category: str = '') -> list[dict[str, object]]:
    """List all learned heuristics, optionally filtered by category.

    Highest-confidence rules first; row keys are camelCase on the wire via
    ``_row_as_wire`` (use_count → useCount, last_surfaced_at →
    lastSurfacedAt).
    """
    from app.services.memory_store import _row_as_wire

    conn = _conn()
    cols = (
        'id, rule, source, category, confidence, source_session_id, suppressed, '
        'use_count, last_surfaced_at, created_at, updated_at'
    )
    if category:
        rows = conn.execute(
            f'SELECT {cols} FROM learned_heuristics WHERE category = ? '
            'ORDER BY confidence DESC, updated_at DESC',
            (category,),
        ).fetchall()
    else:
        rows = conn.execute(
            f'SELECT {cols} FROM learned_heuristics ORDER BY confidence DESC, updated_at DESC'
        ).fetchall()
    return [_row_as_wire(r) for r in rows]


_CONFIDENCE_STEP = 0.1
_NEAR_DUP_THRESHOLD = 0.85


def _clamp_confidence(value: object, default: float = 0.5) -> float:
    """Parse a confidence value into [0, 1], falling back to ``default``."""
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _emit_heuristic_event(summary: str, rule_id: int, source: str, category: str) -> None:
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='heuristic',
            layer='heuristics_service.add_heuristic',
            summary=summary,
            meta={'rule_id': rule_id, 'source': source, 'category': category},
        )
    except Exception:
        pass


def _record_heuristic_trail(
    ruleId: int,
    action: str,
    rule: str,
    source: str,
    category: str,
    session_id: str = '',
) -> None:
    """Versioned rollback trail (Prime /refine lean).

    Every heuristic mutation is recorded (last 20 per rule) so a bad learned
    rule can be identified and reverted from the Brain surface. Never raises.
    """
    try:
        import time as _time

        from app.json_narrowing import as_list
        from app.services.memory_store import get_memory, save_memory

        key = f'heuristic_trail:{ruleId}'
        existing = get_memory(key)
        entries: list[object] = []
        if isinstance(existing, dict):
            entries = as_list(existing.get('entries'), [])
        elif isinstance(existing, list):
            entries = list(existing)
        entries.append(
            {
                'action': action,
                'rule': rule[:500],
                'source': source,
                'category': category,
                'sessionId': session_id or '',
                'at': _time.time(),
            }
        )
        save_memory(key, {'entries': entries[-20:]})
    except Exception:
        pass


def addHeuristic(
    rule: str,
    source: str = 'auto',
    category: str = 'general',
    confidence: object = None,
    session_id: str = '',
) -> int | None:
    """Add a learned heuristic rule, merging repeats instead of duplicating.

    Exact duplicates and near-duplicates (normalized similarity >= 0.85)
    bump the existing row's confidence (+0.1, capped at 1.0) and refresh
    its ``updated_at``, returning the existing id — a repeated correction
    strengthens the rule. New rules insert with the given confidence
    (default 0.5, clamped to [0, 1]).

    ``session_id`` records which conversation produced the rule (provenance
    for the Brain "You" surface); best-effort, may be empty for
    workspace-level learners (diff, delta-engine).
    """
    if not rule or not rule.strip():
        return None
    from app.services.memory.memory_scrubber import find_secrets
    from app.services.memory.user_profile import _similarity

    stripped = rule.strip()
    # Rules are injected into every prompt — secrets must never land there.
    if find_secrets(stripped):
        return None
    conn = _conn()
    rows = conn.execute(
        'SELECT id, rule FROM learned_heuristics ORDER BY updated_at DESC LIMIT 100'
    ).fetchall()
    best = None
    best_score = 0.0
    for r in rows:
        if r['rule'] == stripped:
            best = r
            best_score = 1.0
            break
        score = _similarity(stripped, r['rule'])
        if score > best_score:
            best = r
            best_score = score
    if best is not None and best_score >= _NEAR_DUP_THRESHOLD:
        conn.execute(
            'UPDATE learned_heuristics SET '
            'confidence = MIN(1.0, COALESCE(confidence, 0.5) + ?), '
            "updated_at = datetime('now') WHERE id = ?",
            (_CONFIDENCE_STEP, best['id']),
        )
        conn.commit()
        _emit_heuristic_event(
            f'Upgraded heuristic [{source}]: {stripped[:120]}',
            int(best['id']),
            source,
            category,
        )
        _record_heuristic_trail(int(best['id']), 'upgrade', stripped, source, category, session_id)
        return int(best['id'])
    conf = _clamp_confidence(confidence)
    conn.execute(
        'INSERT INTO learned_heuristics (rule, source, category, confidence, source_session_id, updated_at) '
        "VALUES (?, ?, ?, ?, ?, datetime('now'))",
        (stripped, source, category, conf, session_id or None),
    )
    conn.commit()
    rowId = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
    _emit_heuristic_event(
        f'Added heuristic [{source}]: {stripped[:120]}',
        rowId,
        source,
        category,
    )
    _record_heuristic_trail(rowId, 'add', stripped, source, category, session_id)
    return rowId


def removeHeuristic(ruleId: int) -> bool:
    """Remove a heuristic by id. Returns True if it existed."""
    conn = _conn()
    row = conn.execute('SELECT rule, source, category FROM learned_heuristics WHERE id = ?', (ruleId,)).fetchone()
    cursor = conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (ruleId,))
    conn.commit()
    if cursor.rowcount > 0 and row:
        from app.json_narrowing import as_str

        _record_heuristic_trail(
            ruleId,
            'remove',
            as_str(row['rule'], ''),
            as_str(row['source'], 'auto'),
            as_str(row['category'], 'general'),
        )
    return cursor.rowcount > 0


def removeByRule(rule: str) -> bool:
    """Remove a heuristic by exact rule text. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM learned_heuristics WHERE rule = ?', (rule.strip(),))
    conn.commit()
    return cursor.rowcount > 0


def clearHeuristics(category: str = '') -> int:
    """Clear all heuristics, optionally filtered by category. Returns count removed."""
    conn = _conn()
    if category:
        cursor = conn.execute('DELETE FROM learned_heuristics WHERE category = ?', (category,))
    else:
        cursor = conn.execute('DELETE FROM learned_heuristics')
    conn.commit()
    return cursor.rowcount


def countHeuristics(category: str = '') -> int:
    """Count heuristics, optionally filtered by category."""
    conn = _conn()
    if category:
        row = conn.execute('SELECT COUNT(*) FROM learned_heuristics WHERE category = ?', (category,)).fetchone()
    else:
        row = conn.execute('SELECT COUNT(*) FROM learned_heuristics').fetchone()
    return row[0] if row else 0


def removeHeuristicById(heuristicId: int) -> bool:
    """v3: Remove a heuristic by id. Returns True if found and deleted."""
    conn = _conn()
    cur = conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (heuristicId,))
    conn.commit()
    return cur.rowcount > 0


def updateHeuristic(heuristicId: int, newRule: str) -> bool:
    """v3: Update a heuristic's rule text. Returns True if found and updated.

    Records an ``edit`` trail entry so the version history stays complete.
    """
    conn = _conn()
    row = conn.execute('SELECT rule, source, category FROM learned_heuristics WHERE id = ?', (heuristicId,)).fetchone()
    cur = conn.execute(
        "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?", (newRule, heuristicId)
    )
    conn.commit()
    if cur.rowcount > 0 and row:
        from app.json_narrowing import as_str

        _record_heuristic_trail(
            heuristicId,
            'edit',
            as_str(row['rule'], ''),
            as_str(row['source'], 'auto'),
            as_str(row['category'], 'general'),
        )
    return cur.rowcount > 0


def setHeuristicSuppressed(heuristicId: int, suppressed: bool) -> bool:
    """Mark a heuristic as wrong/outdated (suppressed) or re-enable it.

    Suppressed rules are excluded from prompt injection (see workbench
    prompt builder) but kept in the table so the user can review and
    re-enable them in the Brain "You" surface.
    """
    conn = _conn()
    row = conn.execute('SELECT rule, source, category FROM learned_heuristics WHERE id = ?', (heuristicId,)).fetchone()
    cur = conn.execute(
        'UPDATE learned_heuristics SET suppressed = ?, updated_at = datetime(\'now\') WHERE id = ?',
        (1 if suppressed else 0, heuristicId),
    )
    conn.commit()
    if cur.rowcount > 0 and row:
        from app.json_narrowing import as_str

        _record_heuristic_trail(
            heuristicId,
            'suppress' if suppressed else 'restore',
            as_str(row['rule'], ''),
            as_str(row['source'], 'auto'),
            as_str(row['category'], 'general'),
        )
    return cur.rowcount > 0


def listHeuristicTrail(ruleId: int) -> list[dict[str, object]]:
    """Version history for one heuristic (newest first). Never raises.

    Trail entries: ``{action, rule, source, category, sessionId, at}`` —
    'add' / 'upgrade' / 'edit' / 'suppress' / 'restore' / 'remove' /
    'rollback'.
    """
    try:
        from app.json_narrowing import as_list
        from app.services.memory_store import get_memory

        existing = get_memory(f'heuristic_trail:{ruleId}')
        if isinstance(existing, dict):
            entries = as_list(existing.get('entries'), [])
        elif isinstance(existing, list):
            entries = list(existing)
        else:
            entries = []
        return [dict(e) for e in entries if isinstance(e, dict)][::-1]
    except Exception:
        return []


def rollbackHeuristic(ruleId: int) -> bool:
    """Restore a heuristic's previous rule text from its version trail.

    The trail is append-only, so the entry BEFORE the most recent one holds
    the previous rule. Returns True when a rollback happened (the restored
    text becomes the current rule and a ``rollback`` trail entry is
    recorded).
    """
    conn = _conn()
    row = conn.execute(
        'SELECT rule, source, category FROM learned_heuristics WHERE id = ?', (ruleId,)
    ).fetchone()
    if not row:
        return False
    from app.json_narrowing import as_str

    current = as_str(row['rule'], '')
    trail = listHeuristicTrail(ruleId)
    # Newest first; the first entry is (usually) the current rule. Walk past
    # it (and any trailing entries matching the current text) to find the
    # previous version.
    for entry in trail:
        if entry.get('action') in ('suppress', 'restore', 'remove'):
            continue
        candidate = as_str(entry.get('rule'), '')
        if candidate and candidate != current:
            cur = conn.execute(
                "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?",
                (candidate, ruleId),
            )
            conn.commit()
            if cur.rowcount > 0:
                _record_heuristic_trail(
                    ruleId,
                    'rollback',
                    candidate,
                    as_str(row['source'], 'auto'),
                    as_str(row['category'], 'general'),
                )
                return True
            return False
    return False


def markHeuristicSurfaced(rule_ids: list[int]) -> None:
    """Bump ``use_count`` + ``last_surfaced_at`` for rules injected into a
    prompt (called from the workbench prompt builder). Repeated surfacing is
    the "this rule keeps winning" signal that feeds skill promotion. Never
    raises."""
    ids = [int(i) for i in rule_ids if isinstance(i, int) or str(i).isdigit()]
    if not ids:
        return
    try:
        conn = _conn()
        conn.execute(
            f'UPDATE learned_heuristics SET use_count = COALESCE(use_count, 0) + 1, '
            f"last_surfaced_at = datetime('now') WHERE id IN ({','.join('?' * len(ids))})",
            ids,
        )
        conn.commit()
    except Exception:
        pass


def promoteFrequentHeuristics(
    *, threshold: int = 8, min_confidence: float = 0.8
) -> int:
    """Promote rules that keep winning into pending-skill proposals.

    A heuristic that has been injected (surfaced) at least ``threshold``
    times at high confidence is a proven pattern — queue it as a pending
    skill so the user can approve it as a first-class skill (Prime /refine:
    learned rules graduate into reusable skills). Idempotent: only rules
    without an existing pending skill of the same name are queued. Returns
    how many were queued.
    """
    try:
        conn = _conn()
        rows = conn.execute(
            'SELECT id, rule, category, source, use_count, confidence FROM learned_heuristics '
            'WHERE COALESCE(suppressed, 0) = 0 '
            'AND COALESCE(use_count, 0) >= ? AND COALESCE(confidence, 0) >= ? '
            'ORDER BY use_count DESC LIMIT 10',
            (max(1, int(threshold)), float(min_confidence)),
        ).fetchall()
    except Exception:
        return 0
    if not rows:
        return 0
    from app.json_narrowing import as_float, as_int, as_str

    queued = 0
    for r in rows:
        rule = as_str(r['rule'], '').strip()
        if not rule:
            continue
        name = rule.split('—')[0].split('(')[0].strip().lower().replace(' ', '-')[:40] or 'learned-rule'
        try:
            from app.services.memory.background_review import _queue_pending_skill

            _queue_pending_skill(
                name=name,
                description=(
                    f'Learned from repeated use ({as_str(r["category"], "general")}) — '
                    f'{as_str(r["source"], "auto")}'
                )[:60],
                body=rule,
                trigger='',
                category='learned',
            )
            queued += 1
            try:
                from app.services.memory.curation_ledger import record as _ledger

                _ledger(
                    'promotion',
                    'graduate_heuristic',
                    'skill',
                    name,
                    reason=rule[:200],
                    detail=f'use_count={as_int(r["use_count"], 0)} confidence={as_float(r["confidence"], 0.0)}',
                )
            except Exception:
                pass
        except Exception:
            pass
    return queued
