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

from app.json_narrowing import as_int
from app.services.memory_conn import conn as _conn
from app.services.memory_conn import db_path as _db_path

logger = logging.getLogger('august.consolidation')

# BM25 self-similarity above this = near-duplicate → merge.
_MERGE_SIMILARITY = 0.85
# Pair pass is O(n) index queries; huge stores skip it rather than stall.
_PAIR_SCAN_CAP = 500
# VACUUM only when the DB file grows past this.
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


def _model_complete(system: str, user: str) -> str:
    """One blocking review-model call. '' when no model is configured or
    anything fails — every caller treats that as "this pass had no opinion".

    Consolidation runs on a worker thread (``asyncio.to_thread`` / the scheduler
    loop), so it owns a short-lived event loop here rather than assuming one.
    """
    try:
        from app.services.workbench.providers import make_review_llm_client

        reviewLlm = make_review_llm_client(None, '')
        if reviewLlm is None:
            return ''
        prompt = [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(reviewLlm(prompt)).strip()
        finally:
            loop.close()
    except Exception:
        logger.debug('consolidation model call failed', exc_info=True)
        return ''


def _model_summarize(text: str) -> str:
    """Q5 flag path: one cheap-model call to summarize a merged entry.
    Returns '' on any failure — the caller keeps the unsummarized merge."""
    return _model_complete(
        'Merge the two memory entries into one concise entry. '
        'Keep every distinct fact; plain text only; no preamble.',
        text[:4000],
    )


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
    # 2.6: a TTL delete must drop the cached BM25 corpus, or expired
    # facts keep being injected until an unrelated write clears it.
    if cur.rowcount:
        try:
            from app.services.memory_store.fact_retrieval import invalidate_fact_index

            invalidate_fact_index()
        except Exception:
            pass
    return cur.rowcount or 0


def _sweep_episodic() -> int:
    """M-4: episodic_timeline retention sweep.

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


def _sweep_usage() -> int:
    """Delete token-usage rows older than the configured retention window.

    ``usage_events`` is analytics state rather than the durable transcript, so
    it should not grow forever on a long-lived install. The existing
    consolidation cadence is the single maintenance window for this sweep.
    """
    days = 365
    try:
        from app.services.brain_config_service import getRuntimeConfig

        raw_days = getRuntimeConfig().get('usageRetentionDays', 365)
        days = int(float(str(raw_days)))
    except (TypeError, ValueError):
        pass
    days = max(30, min(3650, days))
    conn = _conn()
    try:
        cur = conn.execute(
            "DELETE FROM usage_events "
            "WHERE julianday(created_at) IS NOT NULL "
            "AND julianday(created_at) < julianday('now', ?)",
            (f'-{days} days',),
        )
        conn.commit()
        return cur.rowcount or 0
    except Exception:
        # Fresh/legacy stores may not have usage_events yet; maintenance must
        # remain best-effort and never block other consolidation work.
        logger.debug('usage sweep failed', exc_info=True)
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
        # 2.19: dedupe across ALL statuses, not just pending — a
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
    """Act on a ``retire-preference`` proposal decision.

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
            # 2.5: consolidation must never fold a global fact into
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
    """Mining + scoring + distiller piggyback the consolidation
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
        # Versioned refine store (T15): the gated auto-refine is its OWN
        # scheduler job now (learning_scheduler._refine_job), not folded in
        # here — it gets its own cadence, ledger row, and run-now button
        # instead of hiding inside the consolidation blob.
    except Exception as exc:
        logger.debug('skill-learning pass failed: %s', exc, exc_info=True)
        out['skillLearningError'] = str(exc)
    return out


# ── LLM memory review (global facts + every project's notes, one read) ─────
# The deterministic passes above can only compare rows inside ONE store: they
# cannot see that a global fact is contradicted by a project note, or that the
# same preference is stored in two scopes. This pass puts the WHOLE corpus in
# front of a model once per consolidation cadence and files what it finds.
# Propose-only, deliberately: an ungated model write to the user's memory is the
# one failure mode this store cannot recover from, so a human approves in the
# Review Inbox — the same contract `retire-preference` already keeps.
_REVIEW_MAX_ENTRIES = 160
_REVIEW_ENTRY_CHARS = 220
_REVIEW_MAX_FINDINGS = 8
_REVIEW_KIND = 'memory-review'
_REVIEW_SYSTEM = (
    'You are reviewing everything an AI assistant durably remembers about one '
    'user: its global facts, and the memory notes it keeps per project. '
    'Report only defects visible in the listing: entries that contradict each '
    'other, duplicates of the same fact, an entry contradicted or superseded by '
    'a newer one, and a project note that is really a global fact about the '
    'user. Reply with a JSON array and nothing else. Each item: '
    '{"kind":"duplicate|contradiction|stale|promote","ids":["<id>",...],'
    '"summary":"one short sentence","action":"the change you recommend"}. '
    'Use the exact ids from the listing. Return [] when it is consistent.'
)


def _memory_corpus() -> list[dict[str, str]]:
    """Every active memory a turn can see, global and per project, in one list.

    Bot-scoped facts are left out: they belong to another audience's memory, and
    folding them into a global review would propose cross-scope merges the
    deterministic passes already refuse to make.
    """
    from app.services import project_memory as _pm

    corpus: list[dict[str, str]] = []
    for f in _load_active_facts():
        if str(f.get('scope') or 'global') != 'global':
            continue
        body = _fact_body_text(f.get('value'))
        if not body:
            continue
        corpus.append(
            {
                'id': str(f.get('key') or ''),
                'where': 'global',
                'title': str(f.get('title') or ''),
                'text': body[:_REVIEW_ENTRY_CHARS],
            }
        )
    try:
        # The learning side's own authority for "which projects exist" — the
        # judge never invents a path, and neither does this.
        from app.services.harness_promote import _known_workspaces

        workspaces = list(_known_workspaces())
    except Exception:
        logger.debug('memory review: workspace enumeration failed', exc_info=True)
        workspaces = []
    for ws in workspaces:
        name = os.path.basename(str(ws).rstrip('\\/')) or ws
        try:
            entries = list(_pm.read_entries(ws))
        except Exception:
            logger.debug('memory review: could not read %s', ws, exc_info=True)
            continue
        for e in entries:
            text = ' '.join((e.title + ' ' + e.body).split())
            if not text:
                continue
            corpus.append(
                {
                    'id': f'project:{name}:{e.title}',
                    'where': f'project:{name}',
                    'title': e.title,
                    'text': text[:_REVIEW_ENTRY_CHARS],
                }
            )
    return corpus[:_REVIEW_MAX_ENTRIES]


def _review_listing(corpus: list[dict[str, str]]) -> str:
    return '\n'.join(f'{c["id"]} [{c["where"]}] {c["text"]}' for c in corpus)


def _open_review_signatures() -> set[str]:
    """Signatures of findings already awaiting a decision, so the same model
    verdict is not filed again on every 24 h pass."""
    try:
        from app.services.memory_store import list_proposals

        rows = list_proposals('consolidation', status='pending')
    except Exception:
        return set()
    out: set[str] = set()
    for r in rows:
        if str(r.get('proposalType') or '') != _REVIEW_KIND:
            continue
        content = r.get('content')
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except (ValueError, TypeError):
                continue
        if isinstance(content, dict):
            out.add(_finding_signature(content))
    return out


def _finding_signature(finding: dict[str, Any]) -> str:
    ids = sorted(str(i) for i in (finding.get('ids') or []) if str(i))
    return f"{str(finding.get('kind') or '')}|{'|'.join(ids)}"


def _parse_findings(raw: str) -> list[dict[str, Any]]:
    """The model's reply as a list of findings. Unparseable output is simply no
    findings — a bad format must never look like a memory problem."""
    text = (raw or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\s*|\s*```$', '', text).strip()
    start, end = text.find('['), text.rfind(']')
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        ids = [str(i).strip() for i in (item.get('ids') or []) if str(i).strip()]
        summary = str(item.get('summary') or '').strip()
        if not ids or not summary:
            continue
        out.append(
            {
                'kind': str(item.get('kind') or 'observation').strip().lower()[:24],
                'ids': ids[:6],
                'summary': summary[:300],
                'action': str(item.get('action') or '').strip()[:300],
            }
        )
    return out[:_REVIEW_MAX_FINDINGS]


def _memory_review_pass() -> tuple[int, list[str]]:
    """One model read across all durable memory. Returns (filed, notes)."""
    notes: list[str] = []
    corpus = _memory_corpus()
    if len(corpus) < 2:
        # One entry cannot disagree with anything; skip rather than spend a call.
        return 0, notes
    listing = _review_listing(corpus)
    raw = _model_complete(_REVIEW_SYSTEM, listing)
    if not raw:
        return 0, notes
    findings = _parse_findings(raw)
    if not findings:
        return 0, notes
    known = _open_review_signatures()
    knownIds = {c['id'] for c in corpus}
    filed = 0
    from app.services.memory_store import save_proposal

    for f in findings:
        # An id the model invented must not become a proposal that nothing can
        # act on when a human approves it.
        if any(i not in knownIds for i in f['ids']):
            continue
        sig = _finding_signature(f)
        if sig in known:
            continue
        try:
            save_proposal(
                'consolidation',
                _REVIEW_KIND,
                {
                    **f,
                    'reason': 'an LLM read across global and project memory flagged this',
                    'corpusSize': len(corpus),
                },
            )
            filed += 1
            notes.append(f'memory review: {f["kind"]} — {f["summary"]}')
        except Exception:
            logger.debug('memory review proposal failed', exc_info=True)
    return filed, notes


# ── LLM skill review (the whole catalogue in one read) ─────────────────────
# Skills accumulate the way memory does: several passes each add one, nothing
# ever looks at the set as a whole. This is the same idea as the memory review,
# pointed at SKILL.md files.
_SKILL_REVIEW_MAX = 80
_SKILL_REVIEW_MAX_FINDINGS = 6
_SKILL_REVIEW_SYSTEM = (
    'You are reviewing the whole library of skills an AI assistant loads into '
    'context when a chat looks relevant. Each line is one skill: its name, the '
    'description the model sees, its trigger phrase, category and how often it '
    'has actually been used. Report only defects visible in the listing: a skill '
    'that overlaps or duplicates another, a trigger that will never match '
    'anything, a description that does not say when to load it, and a skill that '
    'is dead weight (never used, superseded by a newer one). Reply with a JSON '
    'array and nothing else. Each item: {"name":"<exact skill name>",'
    '"kind":"delete|overlap|bad_description|stale","summary":"one short '
    'sentence","action":"the change you recommend"}. Use the exact names from the '
    'listing. Return [] when the library is sound.'
)


def _skill_catalogue() -> list[dict[str, Any]]:
    try:
        from app.services import skill_service

        rows = list(skill_service.list_all(None) or [])
    except Exception:
        logger.debug('skill review: catalogue read failed', exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for s in rows:
        name = str(s.get('name') or '').strip()
        if not name:
            continue
        out.append(
            {
                'name': name,
                'description': str(s.get('description') or '')[:_REVIEW_ENTRY_CHARS],
                'trigger': str(s.get('trigger') or '')[:80],
                'category': str(s.get('category') or 'uncategorized'),
                'scope': str(s.get('scope') or ''),
                'enabled': bool(s.get('enabled', True)),
                'usageCount': as_int(s.get('usage_count') or s.get('usageCount'), 0),
                'lastUsed': str(s.get('last_used') or s.get('lastUsed') or ''),
            }
        )
    return out[:_SKILL_REVIEW_MAX]


def _skill_catalogue_listing(skills: list[dict[str, Any]]) -> str:
    return '\n'.join(
        f"{s['name']} [{s['category']}/{s['scope'] or 'agent'}"
        f"{' off' if not s['enabled'] else ''}] used={s['usageCount']}"
        f" last={s['lastUsed'][:10] or 'never'} — {s['description']}"
        + (f" · trigger: {s['trigger']}" if s['trigger'] else '')
        for s in skills
    )


def _open_skill_proposal_names() -> set[str]:
    """Skills with a proposal already awaiting a decision — a second one for the
    same skill is noise in the inbox, not a second opinion.

    The harness proposal files spell an undecided row ``status: 'open'``; the
    brain-DB ``proposals`` table the memory review writes to spells the same
    state ``'pending'``. Two stores, two words — both are named here rather than
    guessed at.
    """
    try:
        from app.services.harness_self_improve import list_proposals

        rows = list_proposals(status='open')
    except Exception:
        return set()
    out: set[str] = set()
    for r in rows:
        payload = r.get('payload')
        if isinstance(payload, dict):
            name = str(payload.get('name') or '').strip()
            if name:
                out.add(name)
    return out


def _parse_skill_findings(raw: str) -> list[dict[str, Any]]:
    text = (raw or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\s*|\s*```$', '', text).strip()
    start, end = text.find('['), text.rfind(']')
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '').strip()
        summary = str(item.get('summary') or '').strip()
        if not name or not summary:
            continue
        out.append(
            {
                'name': name,
                'kind': str(item.get('kind') or 'stale').strip().lower()[:24],
                'summary': summary[:300],
                'action': str(item.get('action') or '').strip()[:400],
            }
        )
    return out[:_SKILL_REVIEW_MAX_FINDINGS]


def _skill_review_pass() -> tuple[int, list[str]]:
    """One model read across the whole skill library. Returns (filed, notes).

    Propose-only, and deliberately narrow about WHICH kind it files: a
    `delete` finding becomes an approvable ``skill_delete`` proposal (the apply
    path needs nothing but the name), and everything else becomes an
    ``observation``. A `skill_patch` would need a complete replacement SKILL.md,
    and an approval that fails to apply is worse than no proposal at all.
    """
    notes: list[str] = []
    skills = _skill_catalogue()
    if len(skills) < 2:
        return 0, notes
    raw = _model_complete(_SKILL_REVIEW_SYSTEM, _skill_catalogue_listing(skills))
    if not raw:
        return 0, notes
    findings = _parse_skill_findings(raw)
    if not findings:
        return 0, notes
    known = {str(s['name']) for s in skills}
    pending = _open_skill_proposal_names()
    filed = 0
    try:
        from app.services.harness_self_improve import save_proposal
    except Exception:
        logger.debug('skill review: proposal door unavailable', exc_info=True)
        return 0, notes
    for f in findings:
        name = f['name']
        if name not in known or name in pending:
            # An invented name cannot be applied, and a second pending proposal
            # for the same skill is noise.
            continue
        delete = f['kind'] in {'delete', 'stale'}
        try:
            save_proposal(
                problem=f'skill review flagged {name!r}: {f["summary"]}',
                evidence=_skill_catalogue_listing([s for s in skills if s['name'] == name])[:2000]
                or f'{name} reviewed in the catalogue pass',
                proposal=f'{f["kind"]}: {f["action"] or f["summary"]}',
                rollback=(
                    'reject the proposal; the skill file is untouched until a human approves.'
                    if not delete
                    else 'reject the proposal, or re-create the skill from its SKILL.md history.'
                ),
                kind='skill_delete' if delete else 'observation',
                payload={'name': name, 'reviewKind': f['kind'], 'summary': f['summary']},
                session_id='consolidation',
            )
            filed += 1
            notes.append(f'skill review: {f["kind"]} — {name}')
        except Exception:
            logger.debug('skill review proposal failed', exc_info=True)
    return filed, notes


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
        # Propose-only preference retire (non-destructive).
        try:
            retiredProposed, retireNotes = _retire_stale_preferences()
            summary['preferencesProposed'] = retiredProposed
            notes.extend(retireNotes)
        except Exception:
            logger.debug('preference retire pass failed', exc_info=True)
        # The LLM read across global AND project memory. Propose-only: it files
        # findings for the Review Inbox and never edits a fact itself.
        try:
            reviewFiled, reviewNotes = _memory_review_pass()
            summary['memoryReviewProposed'] = reviewFiled
            notes.extend(reviewNotes)
        except Exception:
            logger.debug('memory review pass failed', exc_info=True)
        # The same idea pointed at the skill library. Propose-only.
        try:
            skillFiled, skillNotes = _skill_review_pass()
            summary['skillReviewProposed'] = skillFiled
            notes.extend(skillNotes)
        except Exception:
            logger.debug('skill review pass failed', exc_info=True)
        summary['outcomesSwept'] = sweep_old_outcomes()
        # M-4: episodic_timeline retention sweep (table was unbounded).
        try:
            summary['episodicSwept'] = _sweep_episodic()
        except Exception:
            logger.debug('episodic sweep failed', exc_info=True)
        # Token usage is analytics state, not the durable transcript. Sweep it
        # in the same maintenance window so long-lived installs stay bounded.
        try:
            summary['usageSwept'] = _sweep_usage()
        except Exception:
            logger.debug('usage sweep failed', exc_info=True)
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
    """DEPRECATED shim (P2): consolidation is one job in
    ``learning_scheduler`` now (cadence key unchanged:
    ``consolidationIntervalHours``); the scheduler is the only starter.
    Kept importable for one release; running it runs the unified loop.
    The pass body is ``run_consolidation``; due-ness/bookkeeping moved to
    the ``learning_job_run`` ledger.
    """
    logger.warning(
        'consolidation_loop is deprecated — learning_scheduler owns the cadence'
    )
    from app.services.learning_scheduler import scheduler_loop

    await scheduler_loop()
