"""M4 — Consolidation v2 (plan 2026-08-27 §3.5): one scheduled job.

The deleted consolidation daemon was a stateful multi-job machine. This is
the minimal audited replacement: a single periodic job that expires facts,
merges near-duplicates, supersedes same-title contradictions, sweeps
turn_outcomes, and vacuums a bloated DB. Every action writes a lifecycle
row so the UI can show a consolidation log; job state lives in
``internal_state`` (never in memory).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from app.services.memory_conn import conn as _conn
from app.services.memory_conn import db_path as _db_path

logger = logging.getLogger('august.consolidation')

# BM25 self-similarity above this = near-duplicate → merge (plan §3.5-b).
_MERGE_SIMILARITY = 0.85
# Pair pass is O(n) index queries; huge stores skip it rather than stall.
_PAIR_SCAN_CAP = 500
# VACUUM only when the DB file grows past this (plan §3.5-d).
_VACUUM_THRESHOLD_BYTES = 10 * 1024 * 1024
_STATE_KEY_LAST_RUN = 'consolidation:last_run'


def _slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')


def _fact_body_text(valueRaw: object) -> str:
    from app.services.memory_store.fact_retrieval import _fact_body_text as _body

    return _body(valueRaw)


def _merge_fact_value(newRaw: object, oldTitle: str, oldKey: str) -> str:
    """Merged value: the newer entry plus a merged-from note. JSON-dict values
    keep their shape (note appended to ``details``); everything else becomes
    plain text."""
    note = f'(merged from: {oldTitle or oldKey})'
    try:
        loaded = json.loads(newRaw) if isinstance(newRaw, str) else newRaw
    except (json.JSONDecodeError, TypeError):
        loaded = None
    if isinstance(loaded, dict):
        details = str(loaded.get('details') or '').strip()
        loaded['details'] = f'{details} {note}'.strip()
        return json.dumps(loaded, ensure_ascii=False)
    body = _fact_body_text(newRaw)
    return f'{body} {note}'.strip() if body else note


def _model_summarize(text: str) -> str:
    """Q5 flag path: one cheap-model call to summarize a merged entry.
    Returns '' on any failure — the caller keeps the unsummarized merge."""
    try:
        from app.services.workbench.providers import make_review_llm_client

        reviewLlm = make_review_llm_client(None, '')
        if reviewLlm is None:
            return ''
        prompt = [
            {
                'role': 'system',
                'content': (
                    'Merge the two memory entries into one concise entry. '
                    'Keep every distinct fact; plain text only; no preamble.'
                ),
            },
            {'role': 'user', 'content': text[:4000]},
        ]
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(reviewLlm(prompt)).strip()
        finally:
            loop.close()
    except Exception:
        logger.debug('consolidation model summarize failed', exc_info=True)
        return ''


def _expire_facts() -> int:
    conn = _conn()
    cur = conn.execute(
        "DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at != '' "
        "AND expires_at <= datetime('now')"
    )
    conn.commit()
    return cur.rowcount or 0


def _load_active_facts() -> list[dict[str, Any]]:
    conn = _conn()
    rows = conn.execute(
        'SELECT id, fact_key, fact_value, title, kind, updated_at FROM facts '
        "WHERE (status IS NULL OR status = 'active') "
        "AND (expires_at IS NULL OR expires_at = '' OR expires_at > datetime('now')) "
        'ORDER BY updated_at DESC'
    ).fetchall()
    return [
        {
            'id': int(r['id']),
            'key': str(r['fact_key'] or ''),
            'value': r['fact_value'],
            'title': str(r['title'] or ''),
            'kind': str(r['kind'] or 'fact'),
            'updated_at': str(r['updated_at'] or ''),
        }
        for r in rows
    ]


def _merge_duplicates(modelSummarize: bool = False) -> tuple[int, list[str]]:
    """(b) near-duplicate merge: normalized-key equality or BM25
    self-similarity > threshold → merge into the newer row, delete the older."""
    from app.services.memory_store.fact_retrieval import find_similar_facts, invalidate_fact_index

    facts = _load_active_facts()
    notes: list[str] = []
    if len(facts) > _PAIR_SCAN_CAP:
        return 0, [f'pair scan skipped ({len(facts)} facts > {_PAIR_SCAN_CAP})']
    merged = 0
    removedKeys: set[str] = set()
    bySlug: dict[str, list[dict[str, Any]]] = {}
    for f in facts:
        bySlug.setdefault(_slug(f['key']), []).append(f)
    conn = _conn()
    # Facts are ordered newest-first: for each duplicate pair the later
    # (older) entry is folded into the earlier (newer) one.
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    seenPairs: set[frozenset[str]] = set()

    def _addPair(newer: dict[str, Any], older: dict[str, Any]) -> None:
        sig = frozenset((str(newer['key']), str(older['key'])))
        if len(sig) == 2 and sig not in seenPairs:
            seenPairs.add(sig)
            pairs.append((newer, older))

    for slug, group in bySlug.items():
        if slug and len(group) > 1:
            for older in group[1:]:
                _addPair(group[0], older)
    if not pairs:
        # Only run the BM25 pass when key-slugs found nothing — it is the
        # expensive path and key-equality catches the common re-import case.
        for i, f in enumerate(facts):
            body = _fact_body_text(f['value'])
            similar = find_similar_facts(f"{f['title']} {body}", k=2)
            for ratio, key, _title in similar:
                if key == f['key'] or key in removedKeys:
                    continue
                if ratio >= _MERGE_SIMILARITY:
                    other = next((g for g in facts[i + 1 :] if g['key'] == key), None)
                    if other is not None:
                        _addPair(f, other)
                    break
    for newer, older in pairs:
        if older['key'] in removedKeys:
            continue
        mergedValue = _merge_fact_value(newer['value'], older['title'], older['key'])
        if modelSummarize:
            summary = _model_summarize(
                f"Entry A:\n{_fact_body_text(newer['value'])}\n\nEntry B:\n{_fact_body_text(older['value'])}"
            )
            if summary:
                mergedValue = summary
        conn.execute(
            "UPDATE facts SET fact_value = ?, updated_at = datetime('now') WHERE fact_key = ?",
            (mergedValue, newer['key']),
        )
        conn.execute('DELETE FROM facts WHERE fact_key = ?', (older['key'],))
        removedKeys.add(str(older['key']))
        merged += 1
        notes.append(f'merged {older["key"]!r} into {newer["key"]!r}')
    if merged:
        conn.commit()
        invalidate_fact_index()
    return merged, notes


def _supersede_contradictions() -> tuple[int, list[str]]:
    """(c) same-title entries with different bodies: keep the newest, mark
    older rows ``superseded`` (kept, not deleted — plan §3.5-c)."""
    facts = _load_active_facts()
    byTitle: dict[str, list[dict[str, Any]]] = {}
    for f in facts:
        norm = ' '.join(f['title'].lower().split())
        if len(norm) >= 8:
            byTitle.setdefault(norm, []).append(f)
    conn = _conn()
    superseded = 0
    notes: list[str] = []
    for norm, group in byTitle.items():
        if len(group) < 2:
            continue
        bodies = {_fact_body_text(f['value']) for f in group}
        if len(bodies) < 2:
            continue  # identical bodies are the merge pass's job, not conflict
        # updated_at DESC from the query: first row wins.
        for older in group[1:]:
            conn.execute(
                "UPDATE facts SET status = 'superseded', updated_at = datetime('now') "
                'WHERE fact_key = ?',
                (older['key'],),
            )
            superseded += 1
            notes.append(f'superseded {older["key"]!r} (same title: {norm[:40]!r})')
    if superseded:
        conn.commit()
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    return superseded, notes


def _maybe_vacuum() -> bool:
    try:
        path = str(_db_path())
        if not path or not os.path.exists(path) or os.path.getsize(path) < _VACUUM_THRESHOLD_BYTES:
            return False
        conn = _conn()
        conn.execute('VACUUM')
        return True
    except Exception:
        logger.debug('consolidation VACUUM failed', exc_info=True)
        return False


def _skill_learning_pass() -> dict[str, object]:
    """Part 16: mining + scoring + distiller piggyback the consolidation
    cadence — no new scheduler. Gated on ``skillLearning`` (off skips).
    The distiller's model call happens on the consolidation cadence, so a
    slow judge never touches a live turn."""
    out: dict[str, object] = {}
    try:
        from app.services.brain_config_service import getRuntimeConfig

        mode = str(getRuntimeConfig().get('skillLearning', 'extract-only') or '')
    except Exception:
        mode = 'extract-only'
    if mode == 'off':
        return out
    try:
        from app.services.episode_miner import flag_top_slice, mine_sessions, prune_old_episodes

        mined = mine_sessions()
        out['episodesMined'] = mined.get('episodes', 0)
        flagRateCap, budgetPerDay = 0.05, 2
        try:
            cfg = getRuntimeConfig()
            capRaw = cfg.get('flagRateCap')
            budgetRaw = cfg.get('escalationBudgetPerDay')
            if isinstance(capRaw, (int, float)) and not isinstance(capRaw, bool):
                flagRateCap = float(capRaw)
            if isinstance(budgetRaw, int) and not isinstance(budgetRaw, bool):
                budgetPerDay = int(budgetRaw)
        except Exception:
            pass
        out['flagged'] = flag_top_slice(flagRateCap=flagRateCap, budgetPerDay=budgetPerDay)['flagged']
        out['episodesPruned'] = prune_old_episodes()
        if mode in ('extract-only', 'full'):
            from app.services.skill_distiller import run_distiller_pass

            dist = run_distiller_pass()
            out['distiller'] = {'verdicts': dist.get('verdicts', 0), 'skipped': dist.get('skipped', '')}
    except Exception as exc:
        logger.debug('skill-learning pass failed: %s', exc, exc_info=True)
        out['skillLearningError'] = str(exc)
    return out


def run_consolidation(modelSummarize: bool | None = None) -> dict[str, object]:
    """One consolidation pass. Synchronous; callers wrap it. Never raises."""
    from app.services.memory_store import record_lifecycle, set_internal_state
    from app.services.turn_outcomes import sweep_old_outcomes

    summary: dict[str, object] = {'expired': 0, 'merged': 0, 'superseded': 0, 'outcomesSwept': 0, 'vacuumed': False, 'notes': []}
    notes: list[str] = []
    try:
        if modelSummarize is None:
            modelSummarize = False
            try:
                from app.services.brain_config_service import getRuntimeConfig

                modelSummarize = bool(getRuntimeConfig().get('consolidationModelSummarize', False))
            except Exception:
                pass
        summary['expired'] = _expire_facts()
        merged, mergeNotes = _merge_duplicates(bool(modelSummarize))
        summary['merged'] = merged
        notes.extend(mergeNotes)
        superseded, superNotes = _supersede_contradictions()
        summary['superseded'] = superseded
        notes.extend(superNotes)
        summary['outcomesSwept'] = sweep_old_outcomes()
        summary['vacuumed'] = _maybe_vacuum()
        summary.update(_skill_learning_pass())
        summary['notes'] = notes
        summary['ranAt'] = datetime.now(timezone.utc).isoformat()
        try:
            set_internal_state(_STATE_KEY_LAST_RUN, str(summary['ranAt']))
            record_lifecycle('', 'consolidation', summary)
        except Exception:
            logger.debug('consolidation lifecycle write failed', exc_info=True)
        if merged or superseded or summary['expired']:
            logger.info(
                'consolidation: expired=%s merged=%s superseded=%s vacuumed=%s',
                summary['expired'],
                merged,
                superseded,
                summary['vacuumed'],
            )
    except Exception as exc:
        logger.warning('consolidation pass failed: %s', exc, exc_info=True)
        summary['error'] = str(exc)
    return summary


async def consolidation_loop() -> None:
    """The one scheduled job (plan §3.5). Cadence comes from brain-config
    ``consolidationIntervalHours`` (default 24h), re-read every cycle."""
    while True:
        intervalH = 24.0
        try:
            from app.services.brain_config_service import getRuntimeConfig

            intervalH = float(getRuntimeConfig().get('consolidationIntervalHours', 24) or 24)
        except Exception:
            pass
        intervalH = min(max(intervalH, 1.0), 168.0)
        # Run immediately when a pass is overdue (first boot included), then
        # sleep the configured cadence.
        try:
            from app.services.memory_store import get_internal_state

            lastRaw = str(get_internal_state(_STATE_KEY_LAST_RUN) or '')
            due = True
            if lastRaw:
                try:
                    lastAt = datetime.fromisoformat(lastRaw)
                    if lastAt.tzinfo is None:
                        lastAt = lastAt.replace(tzinfo=timezone.utc)
                    due = (datetime.now(timezone.utc) - lastAt).total_seconds() >= intervalH * 3600
                except ValueError:
                    due = True
            if due:
                await asyncio.to_thread(run_consolidation)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug('consolidation loop pass failed', exc_info=True)
        await asyncio.sleep(intervalH * 3600)
