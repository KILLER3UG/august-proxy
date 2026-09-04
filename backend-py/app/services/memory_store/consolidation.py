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
    # julianday, not string compare: the column mixes writer formats (date-only
    # from the distiller, ISO-T+offset, model-verbatim strings) and a plain
    # 'expires_at <= datetime("now")' mis-orders 'T'-separated values on the
    # expiry day itself — julianday() parses every ISO-8601 shape (and
    # applies the offset) so one format can't silently outlive its window.
    cur = conn.execute(
        "DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at != '' "
        "AND julianday(expires_at) IS NOT NULL "
        "AND julianday(expires_at) <= julianday('now')"
    )
    conn.commit()
    # 2.6 (Part 25): a TTL delete must drop the cached BM25 corpus, or expired
    # facts keep being injected until an unrelated write clears it.
    if cur.rowcount:
        try:
            from app.services.memory_store.fact_retrieval import invalidate_fact_index

            invalidate_fact_index()
        except Exception:
            pass
    return cur.rowcount or 0


def _sweep_episodic() -> int:
    """M-4 (Part 21): episodic_timeline retention sweep.

    The table was unbounded — every session event appended forever. The
    retention window comes from brain-config ``episodicRetentionDays``
    (default 90). OQ2 (ruled 2026-09-04): the table stays (``brain_index_snippet``
    reads it) but M-4's FTS/index half is CLOSED AS WON'T-BUILD — LIKE over
    ≤hundreds of rows is instant and the two readers never rank, so an FTS5
    mirror + triggers would be pure maintenance for no recall gain. Only the
    hygiene sweep lands (and already had to, under either ruling).
    """
    days = 90
    try:
        from app.services.brain_config_service import getRuntimeConfig

        rawDays = getRuntimeConfig().get('episodicRetentionDays', 90)
        days = int(float(str(rawDays)))
    except (TypeError, ValueError):
        pass
    days = max(1, min(3650, days))
    conn = _conn()
    try:
        cur = conn.execute(
            "DELETE FROM episodic_timeline "
            "WHERE julianday(timestamp) IS NOT NULL "
            "AND julianday(timestamp) < julianday('now', ?)",
            (f'-{days} days',),
        )
        conn.commit()
        return cur.rowcount or 0
    except Exception:
        # Table absent (fresh store pre-migration) — nothing to sweep.
        return 0


def _retire_stale_preferences() -> tuple[int, list[str]]:
    """OQ5 (Part 21, 2026-09-04): propose-only preference retire.

    A ``preference`` fact that has been untouched for ``preferenceRetireDays``
    (default 180) AND never quoted (``use_count`` 0) is a stale guess about
    what the user likes. The ruling is PROPOSE-ONLY: this writes a
    ``retire-preference`` proposal per candidate and flips NOTHING — a human
    decides via ``decide_proposal`` (approve → the fact's status goes
    'retired'; reject → it stays). Non-destructive by construction, so it can
    ride the scheduled consolidation pass safely.

    Deduped: a key with an already-open proposal is skipped, so a pass that
    runs daily does not stack duplicates. Returns ``(proposed, notes)``.
    """
    from app.services.brain_config_service import getRuntimeConfig
    from app.services.memory_store import save_proposal

    try:
        cfg = getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('preferenceRetireEnabled', True)):
        return 0, []
    try:
        days = int(float(str(cfg.get('preferenceRetireDays', 180))))
    except (TypeError, ValueError):
        days = 180
    days = max(1, min(3650, days))

    conn = _conn()
    notes: list[str] = []
    proposed = 0
    try:
        cutoff = f'-{days} days'
        # Never quoted (use_count 0 / NULL) + untouched since before the
        # cutoff (last touch = last_used_at, else updated_at, else created_at).
        rows = conn.execute(
            'SELECT fact_key, title, '
            "  COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at) AS last_touch "
            'FROM facts '
            "WHERE kind = 'preference' AND (status IS NULL OR status = 'active') "
            'AND COALESCE(use_count, 0) = 0 '
            'AND julianday('
            "  COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at)"
            ") IS NOT NULL "
            "AND julianday(COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at)) "
            "  < julianday('now', ?)",
            (cutoff,),
        ).fetchall()
        if not rows:
            return 0, []
        # Open OR decided proposals for this type → skip keys already proposed.
        # 2.19 (Part 25): dedupe across ALL statuses, not just pending — a
        # human-rejected retire must not re-file on every pass (the §12 F-8
        # pattern the distiller already fixed).
        openKeys: set[str] = set()
        try:
            for pr in conn.execute(
                "SELECT content FROM proposals WHERE proposal_type = 'retire-preference'"
            ).fetchall():
                raw = pr['content']
                try:
                    data = json.loads(raw) if isinstance(raw, str) else (raw or {})
                except (json.JSONDecodeError, TypeError):
                    data = {}
                if isinstance(data, dict) and data.get('key'):
                    openKeys.add(str(data['key']))
                elif isinstance(data, dict) and data.get('fact_key'):
                    openKeys.add(str(data['fact_key']))
        except Exception:
            logger.debug('retire-proposal dedupe scan failed', exc_info=True)
        for r in rows:
            key = str(r['fact_key'] or '')
            if not key or key in openKeys:
                continue
            title = str(r['title'] or '') or key
            reason = (
                f'preference untouched for {days}+ days and never quoted — '
                'proposed for retirement (approve to retire, reject to keep)'
            )
            try:
                save_proposal(
                    'consolidation',
                    'retire-preference',
                    {'key': key, 'title': title, 'reason': reason, 'lastTouch': str(r['last_touch'] or '')},
                )
                proposed += 1
                notes.append(f'retirement proposed: {title}')
            except Exception:
                logger.debug('retire-preference proposal failed', exc_info=True)
    except Exception:
        logger.debug('preference retire scan failed', exc_info=True)
        return 0, notes
    return proposed, notes


def apply_retire_decision(proposal_id: int, approve: bool, decidedBy: str = 'user') -> dict[str, Any]:
    """Act on a ``retire-preference`` proposal decision (OQ5).

    The scan is propose-only; THIS is the decide half that makes a proposal
    actionable. Approve → the fact's ``status`` flips to ``'retired'`` (the
    row survives — retrieval excludes it, a later restore is a status flip);
    reject → the proposal closes, the fact stays active. Either way the
    proposal itself is stamped via ``decide_proposal``.
    """
    from app.services.memory_store import decide_proposal, get_proposal

    prop = get_proposal(proposal_id)
    if prop is None:
        return {'ok': False, 'error': f'no proposal {proposal_id}'}
    ptype = str(prop.get('proposalType') or prop.get('proposal_type') or '')
    if ptype != 'retire-preference':
        return {'ok': False, 'error': f'proposal {proposal_id} is not a retire-preference'}
    status = 'approved' if approve else 'rejected'
    decide_proposal(proposal_id, status, decidedBy=decidedBy)
    if not approve:
        return {'ok': True, 'decision': status, 'retired': False}
    raw = prop.get('content')
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        data = {}
    key = str(data.get('key') or data.get('fact_key') or '') if isinstance(data, dict) else ''
    if not key:
        return {'ok': True, 'decision': status, 'retired': False, 'error': 'proposal missing key'}
    conn = _conn()
    cur = conn.execute(
        "UPDATE facts SET status = 'retired', updated_at = datetime('now') WHERE fact_key = ?",
        (key,),
    )
    conn.commit()
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    except Exception:
        pass
    return {'ok': True, 'decision': status, 'retired': bool(cur.rowcount), 'key': key}


def _load_active_facts() -> list[dict[str, Any]]:
    conn = _conn()
    rows = conn.execute(
        'SELECT id, fact_key, fact_value, title, kind, scope, updated_at FROM facts '
        "WHERE (status IS NULL OR status = 'active') "
        "AND (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now')) "
        'ORDER BY updated_at DESC'
    ).fetchall()
    return [
        {
            'id': int(r['id']),
            'key': str(r['fact_key'] or ''),
            'value': r['fact_value'],
            'title': str(r['title'] or ''),
            'kind': str(r['kind'] or 'fact'),
            # 2.5 (Part 25): consolidation must never fold a global fact into
            # a bot-scoped row (or across two bots) — the merge/supersede
            # passes partition by this so a scope's memory stays its own.
            'scope': str(r['scope'] or 'global'),
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
    # 2.5: partition by (scope, slug) — a global fact and a bot fact that share
    # a slug must never be folded together.
    bySlug: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for f in facts:
        bySlug.setdefault((str(f['scope']), _slug(f['key'])), []).append(f)
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

    for (_scope, slug), group in bySlug.items():
        if slug and len(group) > 1:
            for older in group[1:]:
                _addPair(group[0], older)
    if not pairs:
        # Only run the BM25 pass when key-slugs found nothing — it is the
        # expensive path and key-equality catches the common re-import case.
        scopeByKey = {str(f['key']): str(f['scope']) for f in facts}
        for i, f in enumerate(facts):
            body = _fact_body_text(f['value'])
            similar = find_similar_facts(f"{f['title']} {body}", k=2, scope=str(f['scope']))
            for ratio, key, _title in similar:
                if key == f['key'] or key in removedKeys:
                    continue
                # 2.5: same-scope only — never fold across global/bot.
                if scopeByKey.get(str(key)) != str(f['scope']):
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
    # 2.5: partition by (scope, normalized-title) — a global fact and a bot
    # fact with the same title are not a contradiction to resolve together.
    byTitle: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for f in facts:
        norm = ' '.join(f['title'].lower().split())
        if len(norm) >= 8:
            byTitle.setdefault((str(f['scope']), norm), []).append(f)
    conn = _conn()
    superseded = 0
    notes: list[str] = []
    for (_scope, norm), group in byTitle.items():
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
        # §3.5 Phase E monitoring rides the same cadence (D-4): resolution /
        # recurrence / demotion suggestions must not wait for a manual
        # /api/curator/run — a resolved fingerprint that recurs between
        # manual clicks would never re-flag.
        from app.services.episode_miner import run_resolution_check

        out['resolution'] = run_resolution_check()
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
        # OQ5 (Part 21): propose-only preference retire (non-destructive).
        try:
            retiredProposed, retireNotes = _retire_stale_preferences()
            summary['preferencesProposed'] = retiredProposed
            notes.extend(retireNotes)
        except Exception:
            logger.debug('preference retire pass failed', exc_info=True)
        summary['outcomesSwept'] = sweep_old_outcomes()
        # M-4 (Part 21): episodic_timeline retention sweep (table was unbounded).
        try:
            summary['episodicSwept'] = _sweep_episodic()
        except Exception:
            logger.debug('episodic sweep failed', exc_info=True)
        # M-11: automation ledger/notepad/incidents retention rides the same
        # maintenance window (runs 30 d, closed incidents 90 d).
        try:
            from app.services import automation_memory

            summary['automationSwept'] = automation_memory.sweep()
        except Exception:
            logger.debug('automation_memory sweep failed', exc_info=True)
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
