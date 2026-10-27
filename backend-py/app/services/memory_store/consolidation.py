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
import uuid
from datetime import datetime, timezone
from typing import Any

from app.json_narrowing import as_int, as_str
from app.services.memory_conn import commit as brain_commit
from app.services.memory_conn import conn as _conn
from app.services.memory_conn import db_path as _db_path
from app.services.memory_conn import poison
from app.services.memory_quality import MERGE_SIMILARITY as _MERGE_SIMILARITY
from app.services.memory_store.rest import PROFILE_FACT_KIND
from app.services.memory_store.timeutil import utc_now_text

logger = logging.getLogger('august.consolidation')

# BM25 self-similarity above this = near-duplicate → merge. The number now
# lives in memory_quality's dedupe ladder (2026-10-17) alongside the write
# door's 0.55, so the two cannot drift apart silently; the alias is kept
# because it reads better at the comparison site than the ladder's name.
# Pair pass is O(n) index queries; huge stores skip it rather than stall.
_PAIR_SCAN_CAP = 500
# VACUUM only when the DB file grows past this.
_VACUUM_THRESHOLD_BYTES = 10 * 1024 * 1024
_STATE_KEY_LAST_RUN = 'consolidation:last_run'


def _slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')


def _fact_body_text(value_raw: object) -> str:
    from app.services.memory_store.fact_retrieval import _fact_body_text as _body

    return _body(value_raw)


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
        from app.services.model_fleet_service import resolveRoleModel
        from app.services.workbench.providers import make_review_llm_client

        # The hippocampus fleet role is what Settings → Model Fleet promises for
        # memory consolidation, and until now nothing read it: this passed an
        # empty hint, so the call landed on whatever the review client guessed.
        # Unset, the pair is ('', '') and the behavior is exactly the old one.
        model, provider = resolveRoleModel('hippocampus')
        reviewLlm = make_review_llm_client(None, model, provider)
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
    brain_commit(conn)
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
        brain_commit(conn)
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
        brain_commit(conn)
        return cur.rowcount or 0
    except Exception:
        # Fresh/legacy stores may not have usage_events yet; maintenance must
        # remain best-effort and never block other consolidation work.
        logger.debug('usage sweep failed', exc_info=True)
        return 0


# Which kinds the retirement scan may propose, and which config key holds the
# silence each must show first.
#
# `profile` is on its own, tighter window because it is injected into EVERY
# turn regardless of the auto-inject gate (`fact_retrieval.build_profile_block`),
# so a stale one is paid for whether or not it is relevant. The others only ever
# appear when something recalls them, so a long window costs nothing.
#
# This set replaces a scan that filtered `kind = 'preference'` — which meant a
# stale profile row could never be proposed, never retire, and never leave. The
# consequence was measured on a live install on 2026-10-10: thirteen test
# fixtures written as `profile` on 2026-09-26 were still spending ~1.8 KB of
# every turn's prompt two weeks later, and no pass could have removed them.
_RETIRE_WINDOWS: dict[str, str] = {
    PROFILE_FACT_KIND: 'profileRetireDays',
    'preference': 'memoryRetireDays',
    'fact': 'memoryRetireDays',
    'lesson': 'memoryRetireDays',
    'skill-note': 'memoryRetireDays',
}

# Proposal type of the current scan, plus the one filed before it was widened:
# both are deduped and both are decidable, because rows of the old type may
# already sit in a user's inbox from an earlier release.
_RETIRE_TYPES = ('retire-fact', 'retire-preference')


def _enforce_fact_budget() -> tuple[int, list[str]]:
    """M-9 store budget: curate the active-fact store back under its ceiling.

    The ceiling is the brain key ``factBudget`` (0 = no budget, which is the
    shipped default — see the fieldTable entry for why the budget does not
    start armed). When the store holds more active facts than the budget
    allows, the WEAKEST ones are archived until it fits.

    "Weakest" is ``confidence · decay · use``: a low-confidence fact, one
    nobody has quoted, and one nobody has touched for a while goes first.
    The profile lane (``kind='profile'``) is EXEMPT — it is injected into
    every turn regardless of relevance, so it is not competing for rank,
    and archiving it would silently shorten what August knows about the
    user.

    Archiving is not deleting: the row stays, ``status='archived'`` takes it
    out of recall, and the Memory UI can put it back. This pass is the only
    automatic curation in the store, which is why it is off until someone
    asks for it.
    """
    notes: list[str] = []
    try:
        from app.services.brain_config_service import getRuntimeConfig

        raw = getRuntimeConfig().get('factBudget', 0)
        budget = int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
    except Exception:
        budget = 0
    if budget <= 0:
        return 0, notes
    conn = _conn()
    try:
        rows = conn.execute(
            'SELECT id, fact_key, confidence, use_count, kind, updated_at FROM facts '
            "WHERE (status IS NULL OR status = 'active') "
            "AND (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now')) "
            "AND COALESCE(kind, 'fact') != 'profile'"
        ).fetchall()
    except Exception:
        logger.debug('fact budget scan failed', exc_info=True)
        return 0, notes
    if len(rows) <= budget:
        return 0, notes
    excess = len(rows) - budget
    # Oldest first among the weakest: a fact nobody has touched in months
    # is the one whose context is the least likely to be missed.
    scored: list[tuple[float, float, int, str]] = []
    for r in rows:
        try:
            confidence = float(r['confidence']) if r['confidence'] is not None else 0.5
        except (TypeError, ValueError):
            confidence = 0.5
        try:
            use = int(r['use_count'] or 0)
        except (TypeError, ValueError):
            use = 0
        ageDays = 0.0
        try:
            updated = str(r['updated_at'] or '')
            if updated:
                ageDays = float(
                    conn.execute(
                        "SELECT MAX(0, julianday('now') - julianday(?))", (updated,)
                    ).fetchone()[0]
                    or 0.0
                )
        except Exception:
            ageDays = 0.0
        # 30-day half-life, the same shape the retrieval decay uses.
        decay = 0.5 ** (ageDays / 30.0)
        score = confidence * decay * use
        scored.append((score, -ageDays, int(r['id']), str(r['fact_key'] or '')))
    # (score, OLDEST FIRST, id) — what the docstring above promises. Sorting
    # the tie-break by fact_key made an alphabetical cut: every never-used
    # fact scores 0.0 (use=0 multiplies the whole product away), so the
    # archive order was the key string and a fact called `a…` went before one
    # untouched for a year. `id` breaks a same-second tie deterministically.
    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    archived = 0
    for _score, _age, rowId, key in scored[:excess]:
        try:
            cur = conn.execute(
                "UPDATE facts SET status = 'archived', updated_at = ? WHERE id = ? "
                "AND (status IS NULL OR status = 'active')",
                (utc_now_text(), rowId),
            )
            if cur.rowcount:
                archived += 1
                notes.append(f'archived {key!r} (over the fact budget)')
        except Exception:
            logger.debug('fact budget archive failed', exc_info=True)
    if archived:
        brain_commit(conn)
        try:
            from app.services.memory_store.fact_retrieval import invalidate_fact_index

            invalidate_fact_index()
        except Exception:
            pass
    return archived, notes


def _stamp_automation_sources() -> int:
    """M-12: stamp the rows an AUTOMATION run produced.

    ``episodes`` gained a ``scope`` column in 036 — a scope answers "whose
    memory is this?", and a source answers "what produced this?". The
    source was the missing half: an automation run is repetitive BY DESIGN,
    so without a stamp its episodes dominate the mining and recurrence
    meters exactly the way a user's own repetition does.

    The automation ledger (``automation_runs``) already names the sessions
    the runs used, so the stamp is a join and not a guess. Rows written
    before the column existed stay NULL — "not recorded" is not the same as
    "not an automation row", and it is never back-filled.
    """
    stamped = 0
    try:
        conn = _conn()
    except Exception:
        return 0
    for table in ('episodes', 'turn_outcomes'):
        try:
            cols = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
            if 'source' not in cols or 'session_id' not in cols:
                continue
            cur = conn.execute(
                f"UPDATE {table} SET source = 'automation' "
                "WHERE (source IS NULL OR source = '') "
                "AND session_id IN (SELECT session_id FROM automation_runs "
                "WHERE session_id IS NOT NULL AND session_id != '')"
            )
            stamped += cur.rowcount or 0
        except Exception:
            logger.debug('automation source stamp failed for %s', table, exc_info=True)
    if stamped:
        try:
            brain_commit(conn)
        except Exception:
            logger.debug('automation source stamp commit failed', exc_info=True)
    return stamped


def _retire_stale_memories() -> tuple[int, list[str]]:
    """OQ5 (Part 21, 2026-09-04), widened 2026-10-10: propose-only retire.

    A durable memory of any kind that has been untouched for its window AND
    never quoted (``use_count`` 0) is a stale guess about the user. The ruling
    is PROPOSE-ONLY: this writes one proposal per candidate and flips NOTHING —
    a human decides via ``apply_retire_decision`` (approve → status 'retired',
    which retrieval excludes and a later flip restores; reject → it stays).
    Non-destructive by construction, so it can ride the scheduled pass.

    Deduped: a key with a proposal of ANY status is skipped, so a daily pass
    neither stacks duplicates nor re-files something a human already refused
    (the §12 F-8 pattern the distiller already fixed). Returns
    ``(proposed, notes)``.
    """
    from app.services.brain_config_service import getRuntimeConfig
    from app.services.memory_store import save_proposal

    try:
        cfg = getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('memoryRetireEnabled', True)):
        return 0, []

    def _days(key: str, fallback: int) -> int:
        try:
            value = int(float(str(cfg.get(key, fallback))))
        except (TypeError, ValueError):
            return fallback
        return max(1, min(3650, value))

    profileDays = _days('profileRetireDays', 45)
    defaultDays = _days('memoryRetireDays', 180)

    conn = _conn()
    notes: list[str] = []
    proposed = 0
    try:
        # Never quoted (use_count 0 / NULL) + untouched since before its own
        # kind's window (last touch = last_used_at, else updated_at, else
        # created_at). A NULL last_touch fails the comparison and is skipped —
        # silence is not evidence of staleness.
        rows = conn.execute(
            'SELECT fact_key, title, kind, '
            "  COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at) AS last_touch, "
            '  CASE kind '
            "    WHEN 'profile' THEN ? "
            '    ELSE ? '
            '  END AS window_days '
            'FROM facts '
            "WHERE (status IS NULL OR status = 'active') "
            'AND COALESCE(use_count, 0) = 0 '
            'AND kind IN (' + ','.join('?' for _ in _RETIRE_WINDOWS) + ') '
            'AND julianday(\'now\') - julianday('
            "  COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at)"
            ') > CASE kind '
            "    WHEN 'profile' THEN ? "
            '    ELSE ? END',
            (profileDays, defaultDays, *sorted(_RETIRE_WINDOWS), profileDays, defaultDays),
        ).fetchall()
        if not rows:
            return 0, []
        openKeys: set[str] = set()
        try:
            for pr in conn.execute(
                "SELECT content FROM proposals WHERE proposal_type IN ('retire-fact', 'retire-preference')"
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
            kind = str(r['kind'] or 'fact')
            days = int(r['window_days'] or defaultDays)
            title = str(r['title'] or '') or key
            reason = (
                f'{kind} untouched for {days}+ days and never quoted — '
                'proposed for retirement (approve to retire, reject to keep)'
            )
            try:
                save_proposal(
                    'consolidation',
                    'retire-fact',
                    {
                        'key': key,
                        'title': title,
                        'kind': kind,
                        'days': days,
                        'reason': reason,
                        'lastTouch': str(r['last_touch'] or ''),
                    },
                )
                proposed += 1
                notes.append(f'retirement proposed: {title}')
            except Exception:
                logger.debug('retire-fact proposal failed', exc_info=True)
    except Exception:
        logger.debug('memory retire scan failed', exc_info=True)
        return 0, notes
    return proposed, notes


def apply_retire_decision(proposal_id: int, approve: bool, decidedBy: str = 'user') -> dict[str, Any]:
    """Act on a retirement proposal decision.

    The scan is propose-only; THIS is the decide half that makes a proposal
    actionable. Approve → the fact's ``status`` flips to ``'retired'`` (the
    row survives — retrieval excludes it, a later restore is a status flip);
    reject → the proposal closes, the fact stays active. Either way the
    decision is a CLAIM on the proposal row (``claim_proposal_decision``, which
    fires only while the row is still pending): a proposal decides once, and the
    claim and the fact write land in one commit.

    Both proposal types are decidable: ``retire-fact`` is what the widened scan
    files, and ``retire-preference`` is what it filed before the scan covered
    every kind — those rows may still sit in a user's inbox from an earlier
    release, and a proposal nobody can decide is a stuck one.
    """
    from app.services.memory_store import (
        claim_proposal_decision,
        decide_proposal,
        get_proposal,
    )

    prop = get_proposal(proposal_id)
    if prop is None:
        return {'ok': False, 'error': f'no proposal {proposal_id}'}
    ptype = str(prop.get('proposalType') or prop.get('proposal_type') or '')
    if ptype not in _RETIRE_TYPES:
        return {'ok': False, 'error': f'proposal {proposal_id} is not a memory retirement'}
    raw = prop.get('content')
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        data = {}
    key = str(data.get('key') or data.get('fact_key') or '') if isinstance(data, dict) else ''
    if not key:
        if not decide_proposal(proposal_id, 'rejected', decidedBy=decidedBy):
            return {'ok': False, 'error': f'proposal {proposal_id} was already decided; nothing changed'}
        return {'ok': True, 'decision': 'rejected', 'retired': False, 'error': 'proposal missing key'}
    # A proposal is a snapshot, not a standing instruction. It can sit in the
    # inbox while the user quotes or edits the fact, so apply only if it still
    # has the evidence that produced this proposal. The UPDATE repeats every
    # condition atomically; a stale approval is closed as rejected and the
    # next consolidation pass can file a fresh proposal if it still qualifies.
    raw_kind = str(data.get('kind') or ('preference' if ptype == 'retire-preference' else ''))
    if raw_kind not in _RETIRE_WINDOWS:
        if not decide_proposal(proposal_id, 'rejected', decidedBy=decidedBy):
            return {'ok': False, 'error': f'proposal {proposal_id} was already decided; nothing changed'}
        return {
            'ok': True,
            'decision': 'rejected',
            'retired': False,
            'error': 'proposal has an unknown fact kind',
        }
    try:
        days = int(float(str(data.get('days', 45 if raw_kind == PROFILE_FACT_KIND else 180))))
    except (TypeError, ValueError):
        days = 45 if raw_kind == PROFILE_FACT_KIND else 180
    days = max(1, min(3650, days))
    last_touch = str(data.get('lastTouch') or '')
    # `fact_key` is UNIQUE and one key has exactly one home (save_fact M-2 /
    # Part 26 6.2), so this predicate already names one row — no scope clause
    # is needed, and adding one would validate a state the schema refuses.
    conn = _conn()
    if not approve:
        if not decide_proposal(proposal_id, 'rejected', decidedBy=decidedBy):
            return {'ok': False, 'error': f'proposal {proposal_id} was already decided; nothing changed'}
        return {'ok': True, 'decision': 'rejected', 'retired': False}
    # The claim IS the guard, so take it before touching the fact and never
    # commit it separately: SQLite serialises writers, so a second approver —
    # or an approval of a row someone already rejected — matches zero rows and
    # returns False with the fact left alone. Claiming last (what this used to
    # do) left a window where the retire landed and the stamp did not, which
    # reads back as a retired fact under a 'rejected' label.
    #
    # A SAVEPOINT, not a bare `conn.rollback()`. `_conn()` is the thread-local
    # handle, and anything else this thread has written but not committed shares
    # the transaction with the claim — a fact saved moments earlier by the same
    # tool loop, a KV row, a transcript block. `rollback()` un-does all of it to
    # the last COMMIT while telling the caller only this decision failed, so the
    # unrelated work vanishes silently. The savepoint bounds the undo to the
    # claim + UPDATE this function owns.
    #
    # EVERY statement of this unit is inside the try. The first version guarded
    # only the claim and the fact UPDATE, so a failure in the corrective claim
    # (the stale-evidence branch) or in the RELEASE left `retire_decision` open
    # on the handle and let the exception escape — and the next unrelated
    # `brain_commit` on that thread then persisted the spent 'approved' claim
    # over a fact that was never retired, the exact state this function claims
    # is impossible.
    # A unique name, not a constant. `SAVEPOINT x` with an existing `x` shadows
    # the outer one and `RELEASE x` then pops the INNER one, so two units sharing
    # a name on one handle undo each other's boundaries. Nothing nests a retire
    # today; the collision is one refactor away and is silent when it happens.
    sp = f'retire_decision_{uuid.uuid4().hex}'
    conn.execute(f'SAVEPOINT {sp}')
    # Empty until the unit has actually written something: an exception before
    # this is assigned has nothing to undo, and the handler below runs on every
    # path out of the try.
    repairs: list[tuple[str, tuple]] = []
    try:
        if not claim_proposal_decision(conn, proposal_id, 'approved', decidedBy):
            conn.execute(f'ROLLBACK TO SAVEPOINT {sp}')
            conn.execute(f'RELEASE SAVEPOINT {sp}')
            return {'ok': False, 'error': f'proposal {proposal_id} was already decided; nothing changed'}
        # Read what the retirement is about to overwrite, so the unit can be
        # undone by NAME rather than by rolling a transaction back. `updated_at`
        # is part of the evidence the proposal was filed on — the retirement
        # window is computed from it — so restoring the status alone would leave
        # the fact looking freshly touched and change which future proposal it
        # earns.
        before = conn.execute('SELECT status, updated_at FROM facts WHERE fact_key = ?', (key,)).fetchone()
        prior_status = before[0] if before is not None else None
        prior_updated = before[1] if before is not None else None
        repairs = [
            (
                "UPDATE proposals SET status = 'pending', decided_at = NULL, decided_by = NULL "
                "WHERE id = ? AND status = 'approved'",
                (proposal_id,),
            ),
            (
                "UPDATE facts SET status = ?, updated_at = ? "
                "WHERE fact_key = ? AND status = 'retired'",
                (prior_status, prior_updated, key),
            ),
        ]
        cur = conn.execute(
            "UPDATE facts SET status = 'retired', updated_at = ? "
            "WHERE fact_key = ? AND kind = ? AND (status IS NULL OR status = 'active') "
            'AND COALESCE(use_count, 0) = 0 '
            "AND julianday('now') - julianday(COALESCE(NULLIF(last_used_at, ''), "
            "NULLIF(updated_at, ''), created_at)) > ? "
            "AND (? = '' OR COALESCE(NULLIF(last_used_at, ''), NULLIF(updated_at, ''), created_at) = ?)",
            (utc_now_text(), key, raw_kind, days, last_touch, last_touch),
        )
        if not cur.rowcount:
            # Evidence no longer holds. We own the claim, so correct it inside
            # the same transaction: the proposal closes as rejected, the fact
            # survives recalled, and one COMMIT makes that pair the only state a
            # crash can leave behind.
            claim_proposal_decision(
                conn, proposal_id, 'rejected', decidedBy, from_status='approved',
            )
            result = {
                'ok': True,
                'decision': 'rejected',
                'retired': False,
                'key': key,
                'error': 'memory changed after this proposal was filed; it was closed without retiring the fact',
            }
        else:
            result = {'ok': True, 'decision': 'approved', 'retired': True, 'key': key}
        # COMMIT, and no RELEASE before it. Releasing first pops the savepoint
        # while the writes are still uncommitted, so a commit that then fails
        # (a busy database is the ordinary cause) has nothing left to undo: the
        # spent 'approved' claim stays pending on the thread-local handle for the
        # NEXT unrelated commit to publish, which is the exact state the
        # claim-before-write design exists to make impossible. Committing is
        # enough on its own — a COMMIT deactivates every savepoint in the
        # transaction — and it leaves the savepoint in place for the handler below
        # to roll back to if the commit itself raises.
        brain_commit(conn)
    except Exception as exc:
        # The claim is already on this connection. Without an undo an
        # uncommitted 'approved' survives on the thread-local handle and the
        # NEXT unrelated write on this thread lands it — a proposal stamped
        # approved over a fact that was never retired, and it can never be
        # re-decided because the claim is spent. So this unit is rolled back
        # with the statement that failed, and nothing outside it is.
        undone = True
        try:
            conn.execute(f'ROLLBACK TO SAVEPOINT {sp}')
            conn.execute(f'RELEASE SAVEPOINT {sp}')
        except Exception:
            # The savepoint is gone (the COMMIT took, or the handle refused) — the
            # unit cannot be undone as a transaction boundary. It can still be
            # undone by name, which is what `repairs` is for.
            undone = False
            logger.debug('retire savepoint undo failed', exc_info=True)
        if not undone:
            # The undo could not run, so decide what to report from the one signal
            # that cannot lie about durability: is this connection still holding
            # an open transaction? Reading the proposal row would not answer it —
            # the same handle sees its OWN uncommitted 'approved', so the row says
            # "decided" whether or not anything is durable, and reporting a landed
            # decision that is merely pending invites a retry that lands twice.
            if not conn.in_transaction:
                # No transaction open means the COMMIT took, and the savepoint is
                # gone because committing is what ends every savepoint in a
                # transaction. So the decision IS durable; only the accounting
                # after it failed.
                return {
                    'ok': True,
                    'decision': 'unknown',
                    'retired': None,
                    'key': key,
                    'error': (
                        f'the decision was applied but the step after its commit failed ({exc}); '
                        're-read the proposal before deciding again'
                    ),
                }
            # A transaction is still open and the unit inside it is still
            # uncommitted, so `ok: False` alone is a lie by omission: it says
            # "nothing changed", and nothing HAS changed — on disk. On this
            # thread-local handle the spent 'approved' claim is pending, and the
            # next unrelated `brain_commit` on the same thread publishes it. What
            # makes "nothing changed" true is taking the unit out of the
            # transaction before that commit runs, and it is done with the row
            # writes this unit replaced (`repairs`) rather than with a rollback:
            # `ROLLBACK TO <sp>` would also discard anything else this thread has
            # staged since the savepoint, which is how a failed retirement came to
            # delete a user's unrelated saved fact while `commit()` reported
            # success.
            poison(repairs)
            return {
                'ok': False,
                'decision': 'unknown',
                'retired': None,
                'pending': True,
                'key': key,
                'error': f'apply_retire_decision({proposal_id}): {exc}; the decision was not '
                'applied and its partial writes have been queued for undo on this thread',
            }
        return {'ok': False, 'error': f'apply_retire_decision({proposal_id}): {exc}'}
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    except Exception:
        pass
    return result


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
        newerKey = str(newer['key'])
        # Guard BOTH sides. The check used to cover only `older`, so a chain of
        # three mutually-similar facts could pick a survivor that a previous
        # pair had already removed: the UPDATE then matched no row and the
        # DELETE still ran — a fact deleted with its text written nowhere, while
        # the run log reported it as merged.
        if older['key'] in removedKeys or newerKey in removedKeys:
            continue
        # Re-read the survivor. `newer['value']` is the snapshot captured when
        # the pairs were built, so in a chain A->B->C the second merge rebuilt C
        # from the ORIGINAL A and silently overwrote the first pair's
        # "(merged from: ...)" provenance note. The row on disk is the
        # authority for what the survivor currently holds.
        currentRow = conn.execute(
            'SELECT fact_value FROM facts WHERE fact_key = ?', (newerKey,)
        ).fetchone()
        if currentRow is None:
            notes.append(f'skipped {older["key"]!r} -> {newerKey!r}: survivor row missing')
            continue
        survivorValue = currentRow['fact_value']
        mergedValue = _merge_fact_value(survivorValue, older['title'], older['key'])
        if modelSummarize:
            summary = _model_summarize(
                f"Entry A:\n{_fact_body_text(survivorValue)}\n\nEntry B:\n{_fact_body_text(older['value'])}"
            )
            if summary:
                mergedValue = summary
        cur = conn.execute(
            "UPDATE facts SET fact_value = ?, updated_at = ? WHERE fact_key = ?",
            (mergedValue, utc_now_text(), newerKey),
        )
        # Only retire the absorbed fact once the survivor actually took the
        # write. A rowcount of 0 means the survivor is gone, and deleting
        # `older` then would destroy the last copy of the content.
        if cur.rowcount != 1:
            notes.append(f'skipped {older["key"]!r} -> {newerKey!r}: survivor row missing')
            continue
        # Snapshot the absorbed row before it disappears. A merge is a
        # HEURISTIC (slugged-key equality, or BM25 >= _MERGE_SIMILARITY), and
        # this was the one destructive memory path with no proposal and no
        # undo — while retiring a single unused fact required a human decision.
        # Same store, opposite risk policies. The snapshot does not make the
        # merge reversible on its own, but the absorbed content is recoverable
        # from `lifecycle` instead of gone.
        try:
            from app.services.memory_store.rest import record_lifecycle

            record_lifecycle(
                '',
                'fact_merged',
                {
                    'absorbedKey': str(older['key']),
                    'absorbedValue': older['value'],
                    'absorbedTitle': str(older.get('title') or ''),
                    'absorbedKind': str(older.get('kind') or 'fact'),
                    'absorbedScope': str(older.get('scope') or 'global'),
                    'survivorKey': newerKey,
                    'reason': 'slug-or-similarity',
                },
            )
        except Exception:  # noqa: BLE001
            # Never block the merge on its audit trail: the survivor already
            # took the write, so skipping the DELETE would leave two rows that
            # both claim the content.
            logger.debug('fact merge snapshot failed', exc_info=True)
        # M-3: the winner's side of the lineage. The absorbed row is DELETED
        # here (a merge is a fold, not a supersession — there is no loser row
        # left to carry `superseded_by`), so the winner's `supersedes` list
        # is the only place the absorption is recorded. The absorbed CONTENT
        # itself is in the lifecycle snapshot above, which is what a restore
        # reads.
        _append_supersedes(conn, newerKey, str(older['key']))
        conn.execute('DELETE FROM facts WHERE fact_key = ?', (older['key'],))
        removedKeys.add(str(older['key']))
        merged += 1
        notes.append(f'merged {older["key"]!r} into {newerKey!r}')
    if merged:
        brain_commit(conn)
        invalidate_fact_index()
    return merged, notes


def _append_supersedes(conn: Any, winner_key: str, loser_key: str) -> None:
    """Record that ``winner_key`` replaced ``loser_key`` (M-3, winner side).

    The loser's own row carries ``superseded_by``; the winner carries the
    LIST of the rows it replaced, because one winner can replace several
    (a near-duplicate merge folds N rows into one).

    The list is a JSON array in a TEXT column, so it is read back with a
    tolerant parse: a row whose value was written by something else (or
    hand-edited) must not make this pass throw.
    """
    if not winner_key or not loser_key:
        return
    try:
        row = conn.execute(
            'SELECT supersedes FROM facts WHERE fact_key = ?', (winner_key,)
        ).fetchone()
        current: list[str] = []
        if row is not None:
            raw = row['supersedes'] if hasattr(row, 'keys') else row[0]
            if isinstance(raw, list):
                current = [str(x) for x in raw]
            elif isinstance(raw, str) and raw.strip():
                try:
                    loaded = json.loads(raw)
                    if isinstance(loaded, list):
                        current = [str(x) for x in loaded]
                except (json.JSONDecodeError, TypeError):
                    current = []
        if loser_key not in current:
            current.append(loser_key)
        conn.execute(
            'UPDATE facts SET supersedes = ? WHERE fact_key = ?',
            (json.dumps(current), winner_key),
        )
    except Exception:
        logger.debug('supersedes lineage write failed', exc_info=True)


def _bodiesOverlap(a: str, b: str) -> float:
    """Word overlap of two fact bodies, 0.0..1.0.

    The measure that separates "the same statement, reworded" from "two
    statements that cannot both be true". A pure token-set Jaccard: the
    bodies here are one or two sentences, and a shared proper noun or a
    shared negation is exactly the signal that two entries are talking
    about the same thing.
    """
    def _tokens(text: str) -> set[str]:
        return {t for t in re.split(r'[^0-9a-z]+', (text or '').lower()) if len(t) > 2}

    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# Above this overlap two same-title entries are the same statement said
# twice: the older one is SUPERSEDED (a human can restore it). Below it they
# are a genuine CONTRADICTION and wait for a human instead.
_SAME_STATEMENT_OVERLAP = 0.5


def _supersede_contradictions() -> tuple[int, list[str]]:
    """(c) same-title entries with different bodies: keep the newest, mark
    older rows ``superseded`` (kept, not deleted — plan §3.5-c).

    M-3 wrote the lineage while this did not: the loser row now carries
    ``superseded_by`` and the winner carries ``supersedes``, so the Memory UI
    can show "replaces X" and a forget on the winner can offer to restore
    the losers.

    M-8 split the outcome in two. Two same-title entries whose bodies
    OVERLAP are the same statement said twice — the older one is superseded.
    Two whose bodies do NOT overlap cannot both be true, and silently
    superseding one of them hides a conflict from the user: they are marked
    ``contested`` and each names the other in ``contradicts``, so the
    conflict is a thing a human can see and resolve.
    """
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
        winner = group[0]
        winnerKey = str(winner['key'])
        for older in group[1:]:
            olderKey = str(older['key'])
            overlap = _bodiesOverlap(
                _fact_body_text(winner['value']), _fact_body_text(older['value'])
            )
            contested = overlap < _SAME_STATEMENT_OVERLAP
            # Both sides of the lineage, whatever the outcome: these two rows
            # are about the same thing, and the link is what the UI reads.
            _append_supersedes(conn, winnerKey, olderKey)
            if contested:
                conn.execute(
                    "UPDATE facts SET status = 'contested', superseded_by = ?, contradicts = ?, "
                    "updated_at = ? WHERE fact_key = ?",
                    (winnerKey, winnerKey, utc_now_text(), olderKey),
                )
                conn.execute(
                    "UPDATE facts SET contradicts = ?, updated_at = ? "
                    'WHERE fact_key = ?',
                    (olderKey, utc_now_text(), winnerKey),
                )
                notes.append(
                    f'contested {olderKey!r} against {winnerKey!r} '
                    f'(same title, unrelated bodies — needs a human)'
                )
            else:
                conn.execute(
                    "UPDATE facts SET status = 'superseded', superseded_by = ?, "
                    "updated_at = ? WHERE fact_key = ?",
                    (winnerKey, utc_now_text(), olderKey),
                )
                notes.append(f'superseded {olderKey!r} (same title: {norm[:40]!r})')
            superseded += 1
    if superseded:
        brain_commit(conn)
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
        # 'propose' (the shipped default) must be in this list or the scheduled
        # distiller pass silently stops running. Item 11 added the mode here and
        # forgot this branch — caught by the check-2 audit, not by a test.
        if mode in ('extract-only', 'propose', 'full'):
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
        # Usage lives in the per-skill sidecar, and `list_all`'s parse does NOT
        # return it — reading it off the catalogue row reported every skill as
        # `used=0 last=never` forever, which is the evidence a judge is asked to
        # act on when it proposes a `skill_delete`. Use the one documented
        # reader, same as the mechanical retire path below.
        try:
            usage = skill_service.read_skill_usage(name)
            used_count = as_int(usage.get('count'), 0)
            last_used = str(usage.get('lastUsed') or '')
        except Exception:
            logger.debug('skill review: usage read failed for %r', name, exc_info=True)
            used_count, last_used = 0, ''
        out.append(
            {
                'name': name,
                'description': str(s.get('description') or '')[:_REVIEW_ENTRY_CHARS],
                'trigger': str(s.get('trigger') or '')[:80],
                'category': str(s.get('category') or 'uncategorized'),
                'scope': str(s.get('scope') or ''),
                'enabled': bool(s.get('enabled', True)),
                'usageCount': used_count,
                'lastUsed': last_used,
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


# ── Never-loaded skill retirement (audit P2#13) — PROPOSAL ONLY ───────────
# The skill review above is a MODEL's opinion of the library. This is the
# mechanical counterpart, and it only ever counts two facts that cannot be
# argued with: the skill has not been loaded, and no turn measurement says
# it helps. Together they are the case for retiring it.
#
# PROPOSE-ONLY, deliberately, and the difference from deletion is the whole
# point: the pass files a `retire` proposal whose approval writes
# `status: retired` into the frontmatter. The SKILL.md, its version history
# and its usage counters all stay on disk, and an approved patch sets the
# status back. NOTHING here retires a skill on its own.
_SKILL_RETIRE_DAYS = 30
# The inbox is a decision queue, not a dump. A library that grew a dozen dead
# skills at once gets the five worst; the rest surface on the next cadence.
_SKILL_RETIRE_MAX = 5


def _skill_retire_candidates() -> list[dict[str, Any]]:
    """Agent-scope skills with no loads in the window and no measured lift.

    Bundled and project entries are excluded: the applier that would act on
    the proposal edits the AGENT root, so proposing retirement for a skill
    that lives in the install tree would file something that cannot be applied
    honestly. Disabled skills are excluded too — ``disabled: true`` is already
    the human's way of saying "not this one right now".
    """
    from app.services import skill_service

    try:
        rows = list(skill_service.list_all(None) or [])
    except Exception:
        logger.debug('skill retire: catalogue read failed', exc_info=True)
        return []
    try:
        from app.services.turn_outcomes import skill_lift

        lifts = skill_lift(_SKILL_RETIRE_DAYS)
    except Exception:
        logger.debug('skill retire: lift read failed', exc_info=True)
        # Missing evidence is not evidence of zero lift. Fail closed when the
        # measurement read itself failed; a genuine empty result still means
        # no measured lift and is handled below.
        return []
    cutoff = datetime.now(timezone.utc).timestamp() - _SKILL_RETIRE_DAYS * 86400
    out: list[dict[str, Any]] = []
    for s in rows:
        name = str(s.get('name') or '').strip()
        if not name or str(s.get('scope') or '') != 'agent':
            continue
        if not s.get('enabled', True):
            continue
        if skill_service.skill_status(s.get('status')) in ('retired', 'superseded'):
            continue
        try:
            usage = skill_service.read_skill_usage(name)
        except Exception:
            continue
        count = as_int(usage.get('count'), 0)
        last_used = str(usage.get('lastUsed') or '')
        if count > 0:
            # The sidecar carries a total, not a series: a skill with loads
            # that all predate the window is "loaded once, long ago" and is
            # not the same evidence as never loaded. Only an out-of-window
            # timestamp qualifies.
            if not last_used:
                continue
            try:
                stamp = datetime.fromisoformat(last_used).timestamp()
            except Exception:
                continue
            if stamp >= cutoff:
                continue
        # No evidence of help. Absent from the lift map means UNMEASURED,
        # which is not on its own a reason to retire — but zero loads already
        # carries the case, and a positive lift cancels it outright.
        lift = float(lifts.get(name, 0.0))
        if lift > 0:
            continue
        out.append({'name': name, 'loads': count, 'lift': lift, 'lastUsed': last_used})
    return out


def _skill_retire_pass() -> tuple[int, list[str]]:
    """File a `retire` proposal per never-loaded, never-lifted skill.

    Returns (filed, notes). Never applies anything.
    """
    notes: list[str] = []
    candidates = _skill_retire_candidates()
    if not candidates:
        return 0, notes
    try:
        from app.services.harness_self_improve import save_proposal
    except Exception:
        logger.debug('skill retire: proposal door unavailable', exc_info=True)
        return 0, notes
    pending = _open_skill_proposal_names()
    filed = 0
    for cand in candidates[:_SKILL_RETIRE_MAX]:
        name = str(cand.get('name') or '')
        if not name or name in pending:
            continue
        try:
            save_proposal(
                problem=(
                    f"Skill '{name}' has no measured effect: "
                    f"{cand['loads']} recorded load(s) and a turn-lift of {cand['lift']}."
                ),
                evidence=(
                    f'{name}: loads={cand["loads"]} lastUsed={cand["lastUsed"] or "never"} '
                    f'lift={cand["lift"]} over {_SKILL_RETIRE_DAYS}d (turn_outcomes.skills_injected)'
                ),
                proposal=(
                    f"Retire '{name}': set status: retired in its frontmatter. "
                    'The file, its version history and its counters stay; an approved '
                    'patch restores it to active.'
                ),
                rollback=(
                    'Reject the proposal, or approve a later skill_patch for this skill — '
                    'the patch sets status back to active.'
                ),
                kind='retire',
                expected_metric='the skill stops being offered in <relevant_skills> rankings',
                payload={
                    'name': name,
                    'loads': cand['loads'],
                    'lift': cand['lift'],
                    'lastUsed': cand['lastUsed'],
                },
                session_id='consolidation',
            )
            filed += 1
            notes.append(f'skill retire proposed — {name}')
        except Exception:
            logger.debug('skill retire proposal failed', exc_info=True)
    return filed, notes


# ── Archived skills: the second half of the lifecycle (2026-10-10) ─────────
# `retire` above is a LABEL — the SKILL.md, its version history and its usage
# counters all stay in the agent root, and an approved patch sets the status
# back. That is the right first step (a human can change their mind with one
# frontmatter edit), but it means a skill nobody has wanted for a year is
# still on disk, still parsed by discovery and still listed in Settings.
#
# This is the removal step, and it is deliberately a MOVE rather than a
# delete: the applier calls the SAME `_trashDir` that `deleteSkill` calls, so
# the undo is the delete-trash's own restore route
# (`POST /api/skills/restore/{trashId}`) and the whole directory — file,
# history, counters — comes back. Propose-only for the same reason the retire
# pass is: this one moves bytes, so a human decides.
#
# The window is the same idea as memory retirement's: the candidate must be
# QUIET, not merely old. Two clocks, both cheap, both required:
#   * USAGE — the per-skill sidecar (`count` / `lastUsed`), the same reader
#     the retire pass uses. A skill that was loaded recently is not stale
#     however long it has been retired.
#   * THE FILE — `updatedAt` from the parse (SKILL.md's own mtime). For a
#     retired skill the last writer is `setStatus`, so that stamp reads as
#     "how long has this been retired", and any later patch — which restates
#     the status, keeping it retired — restarts it. A skill someone touched
#     is not stale.
_SKILL_ARCHIVE_DAYS = 60
_SKILL_ARCHIVE_MAX = 5


def _skill_archive_candidates(days: int) -> list[dict[str, Any]]:
    """Agent-scope skills that are ``retired`` and have been quiet for `days`.

    Mirrors :func:`_skill_retire_candidates` and inverts its status test:
    that pass looks for a live skill with nothing to show, this one for a
    retired skill that stayed that way. Bundled, project and bot roots are
    excluded for the applier's reason — the trash manifest restores to the
    agent root, so proposing a move for a skill that lives anywhere else
    would file something that cannot be applied honestly.
    """
    from app.services import skill_service

    try:
        rows = list(skill_service.list_all(None) or [])
    except Exception:
        logger.debug('skill archive: catalogue read failed', exc_info=True)
        return []
    try:
        from app.services.turn_outcomes import skill_lift

        lifts = skill_lift(days)
    except Exception:
        logger.debug('skill archive: lift read failed', exc_info=True)
        return []
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    out: list[dict[str, Any]] = []
    for s in rows:
        name = as_str(s.get('name'), '').strip()
        if not name or as_str(s.get('scope'), '') != 'agent':
            continue
        if not s.get('enabled', True):
            continue
        if skill_service.skill_status(s.get('status')) != 'retired':
            continue
        try:
            usage = skill_service.read_skill_usage(name)
        except Exception:
            continue
        count = as_int(usage.get('count'), 0)
        last_used = as_str(usage.get('lastUsed'), '')
        if count > 0:
            if not last_used:
                continue
            try:
                stamp = datetime.fromisoformat(last_used).timestamp()
            except Exception:
                continue
            if stamp >= cutoff:
                continue
        # The file's own stamp, surfaced as `updatedAt` by the parse. A missing
        # or non-numeric one reads as "no clock" and does not disqualify.
        raw_touched = s.get('updatedAt')
        touched = float(raw_touched) if isinstance(raw_touched, (int, float)) else 0.0
        if touched and touched >= cutoff:
            continue
        lift = float(lifts.get(name, 0.0))
        if lift > 0:
            # A skill the harness measured as helping is not dead weight, even
            # retired and unused — it is the thing you reach for on purpose.
            continue
        out.append(
            {
                'name': name,
                'loads': count,
                'lift': lift,
                'lastUsed': last_used,
                'retiredForDays': days,
            }
        )
    return out


def _skill_archive_pass() -> tuple[int, list[str]]:
    """File an ``archive`` proposal per long-retired, still-quiet skill.

    Returns (filed, notes). Never applies anything — approving is what moves.
    """
    from app.services.brain_config_service import getRuntimeConfig

    try:
        cfg = getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('skillArchiveEnabled', True)):
        return 0, []
    try:
        days = int(float(str(cfg.get('skillArchiveDays', _SKILL_ARCHIVE_DAYS))))
    except (TypeError, ValueError):
        days = _SKILL_ARCHIVE_DAYS
    days = max(1, min(3650, days))
    notes: list[str] = []
    candidates = _skill_archive_candidates(days)
    if not candidates:
        return 0, notes
    try:
        from app.services.harness_self_improve import save_proposal
    except Exception:
        logger.debug('skill archive: proposal door unavailable', exc_info=True)
        return 0, notes
    pending = _open_skill_proposal_names()
    filed = 0
    for cand in candidates[:_SKILL_ARCHIVE_MAX]:
        name = as_str(cand.get('name'), '')
        if not name or name in pending:
            continue
        try:
            save_proposal(
                problem=(
                    f"Skill '{name}' has been retired and unused for "
                    f"{days}+ days — archive it?"
                ),
                evidence=(
                    f'{name}: status=retired loads={cand["loads"]} '
                    f'lastUsed={cand["lastUsed"] or "never"} '
                    f'lift={cand["lift"]} over {days}d; SKILL.md untouched since '
                    'the retirement (turn_outcomes.skills_injected)'
                ),
                proposal=(
                    f"Archive '{name}': move its directory out of the skills root "
                    'into the delete trash. The file, its version history and its '
                    'counters all survive the move, and the trash restore route '
                    'puts it back exactly where it was.'
                ),
                rollback=(
                    'Reject the proposal; or, once archived, restore it with '
                    'POST /api/skills/restore/<trashId> — the approval response '
                    'names the id.'
                ),
                kind='archive',
                expected_metric='the skill stops being discovered, parsed and listed',
                payload={
                    'name': name,
                    'loads': cand['loads'],
                    'lift': cand['lift'],
                    'lastUsed': cand['lastUsed'],
                    'days': days,
                },
                session_id='consolidation',
            )
            filed += 1
            notes.append(f'skill archive proposed — {name}')
        except Exception:
            logger.debug('skill archive proposal failed', exc_info=True)
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
            retiredProposed, retireNotes = _retire_stale_memories()
            summary['preferencesProposed'] = retiredProposed
            notes.extend(retireNotes)
        except Exception:
            logger.debug('preference retire pass failed', exc_info=True)
        # M-9: the store budget. OFF unless `factBudget` is set — the one
        # automatic curation pass in the store, so it waits for a human to
        # arm it.
        try:
            budgetArchived, budgetNotes = _enforce_fact_budget()
            summary['factsArchived'] = budgetArchived
            notes.extend(budgetNotes)
        except Exception:
            logger.debug('fact budget pass failed', exc_info=True)
        # M-12: the automation source stamp, so an automation's episodes and
        # turns are distinguishable from a person's.
        try:
            summary['automationStamped'] = _stamp_automation_sources()
        except Exception:
            logger.debug('automation source stamp failed', exc_info=True)
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
        # Never-loaded, never-lifted skills get a RETIRE proposal (P2#13).
        # Still propose-only: approving it is what writes the status.
        try:
            retireFiled, retireNotes = _skill_retire_pass()
            summary['skillRetireProposed'] = retireFiled
            notes.extend(retireNotes)
        except Exception:
            logger.debug('skill retire pass failed', exc_info=True)
        # The archive half of the skill lifecycle: a skill that has been
        # retired and has stayed quiet for its window is proposed for a TRASH
        # MOVE — reversible through the delete trash's own restore route, but
        # the decision is still a human's, so this only ever files.
        try:
            archiveFiled, archiveNotes = _skill_archive_pass()
            summary['skillArchiveProposed'] = archiveFiled
            notes.extend(archiveNotes)
        except Exception:
            logger.debug('skill archive pass failed', exc_info=True)
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
    # A pass retires/archives/merges many rows; the markdown mirror is
    # regenerated once here rather than per mutation.
    try:
        from app.services.memory_store.mirror import rebuild_mirror

        summary['mirrorFiles'] = rebuild_mirror()
    except Exception:
        logger.debug('memory mirror rebuild failed', exc_info=True)
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
