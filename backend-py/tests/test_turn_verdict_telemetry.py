"""046 — the persisted turn verdict, counters, and the widened failure learning.

Three claims, one per block:

1. ``turn_end {reason, rounds}`` and the loop's turn-scoped self-correction
   counters are durable on the ``turn_outcomes`` row instead of dying with the
   SSE stream / the coroutine.
2. NULL means NOT RECORDED and is never folded into a measured zero — a turn
   nobody measured must not be reported as a clean turn (the Learning panel
   renders 'not recorded' for exactly this reason).
3. ``maybe_promote_failure_lesson`` now counts the edit-verification gate and
   the tool guardrails alongside the upstream error class, each in its own
   signature space, with the existing threshold, review gate and ``lesson``
   fact kind (no new store, no second ledger).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

NEW_COLUMNS = {
    'end_reason',
    'rounds',
    'malformed_tool_args',
    'surface_downgraded',
    'edit_verify_fails',
    'guardrail_classes',
}

_EPOCH = datetime.fromtimestamp(0, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def _db():
    from app.services.memory_conn import conn

    return conn()


def _cols() -> set[str]:
    return {r['name'] for r in _db().execute('PRAGMA table_info(turn_outcomes)').fetchall()}


def _row(sessionId: str):
    return _db().execute(
        'SELECT * FROM turn_outcomes WHERE session_id = ? ORDER BY id DESC LIMIT 1',
        (sessionId,),
    ).fetchone()


def _flush() -> None:
    from app.services.deferred_writes import flush_thread_pending

    flush_thread_pending()


def _factText(fact: object) -> str:
    assert isinstance(fact, dict)
    return str(fact.get('factValue') or fact.get('fact_value') or '')


def _lessonFacts() -> list[dict[str, object]]:
    from app.services.memory_store import list_facts

    return [f for f in list_facts(category='harness') if f.get('kind') == 'lesson']


# ── 1 + 2: the columns, and NULL-vs-zero ─────────────────────────────────


def test_verdict_columns_exist_after_init(isolatedData):
    from app.services import memory_store

    memory_store.init()
    assert NEW_COLUMNS <= _cols()


def test_reason_and_rounds_land_on_the_row(isolatedData):
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    turn_outcomes.record_turn_outcome(
        model='m',
        provider='p',
        task_type='agent',
        ok=True,
        session_id='s-reason',
        end_reason='length',
        rounds=7,
        malformed_tool_args=3,
        surface_downgraded=True,
        edit_verify_fails=0,
        guardrail_classes='',
    )
    _flush()
    row = _row('s-reason')
    assert row['end_reason'] == 'length'
    assert row['rounds'] == 7
    assert row['malformed_tool_args'] == 3
    assert row['surface_downgraded'] == 1
    # A measured zero stays a zero — and it is NOT the same as the NULL the
    # next test writes for the same column.
    assert row['edit_verify_fails'] == 0
    assert row['guardrail_classes'] == ''


def test_unmeasured_verdict_is_null_not_zero(isolatedData):
    """The whole honesty rule: an old row / unmeasured turn reads NULL."""
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    # An old caller (the signature before 046) — nothing about the verdict.
    turn_outcomes.record_turn_outcome(
        model='m', provider='p', task_type='agent', ok=True, session_id='s-legacy'
    )
    _flush()
    row = _row('s-legacy')
    for col in sorted(NEW_COLUMNS):
        assert row[col] is None, f'{col} defaulted to a measured-looking {row[col]!r}'

    # ... and the stats read reports it as unrecorded, never as a zero total.
    stats = turn_outcomes.turn_verdict_stats(days=7)
    assert stats['reasons'] == []
    assert stats['reasonUnrecorded'] == 1
    counters = stats['counters']
    assert counters['malformedToolArgs']['total'] is None
    assert counters['malformedToolArgs']['unrecorded'] == 1
    assert counters['guardrailBlocks']['total'] is None
    assert counters['rounds']['avg'] is None

    # A second turn that WAS measured and came back clean: zeros, side by side.
    turn_outcomes.record_turn_outcome(
        model='m',
        provider='p',
        task_type='agent',
        ok=True,
        session_id='s-clean',
        end_reason='finished',
        rounds=1,
        malformed_tool_args=0,
        surface_downgraded=0,
        edit_verify_fails=0,
        guardrail_classes='',
    )
    _flush()
    stats = turn_outcomes.turn_verdict_stats(days=7)
    assert [r['reason'] for r in stats['reasons']] == ['finished']
    assert stats['reasonUnrecorded'] == 1
    assert stats['counters']['malformedToolArgs']['total'] == 0
    assert stats['counters']['malformedToolArgs']['measured'] == 1
    assert stats['counters']['guardrailBlocks']['total'] == 0
    assert stats['counters']['rounds']['avg'] == 1.0


def test_row_survives_a_database_without_the_new_columns(isolatedData):
    """046 unread (failed/skipped migration) must cost the verdict columns,
    never the whole M5 row every other consumer reads."""
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    for col in sorted(NEW_COLUMNS):
        _db().execute(f'ALTER TABLE turn_outcomes DROP COLUMN {col}')
    _db().commit()
    turn_outcomes.record_turn_outcome(
        model='m',
        provider='p',
        task_type='agent',
        ok=False,
        error_class='timeout',
        session_id='s-nocolumns',
        end_reason='cap',
        rounds=4,
    )
    _flush()
    row = _db().execute(
        'SELECT model, ok, error_class FROM turn_outcomes WHERE session_id = ?',
        ('s-nocolumns',),
    ).fetchone()
    assert row is not None
    assert row['ok'] == 0 and row['error_class'] == 'timeout'


# ── migration 046 ────────────────────────────────────────────────────────


def test_migration_046_is_idempotent_when_the_columns_already_exist(isolatedData):
    """A DB whose columns arrived another way (partial run, legacy fast path):
    re-running 046 must not raise, must not lose rows, and must not wipe the
    NULL-vs-zero distinction it exists to protect."""
    from app.lib.migrations import run_migrations
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    turn_outcomes.record_turn_outcome(
        model='m',
        provider='p',
        task_type='agent',
        ok=True,
        session_id='s-before-rerun',
        end_reason='cap',
        rounds=9,
    )
    _flush()

    # Force 046 pending again on a database that already has every column.
    _db().execute('DELETE FROM schema_migrations WHERE version = 46')
    _db().execute('DELETE FROM schema_migration_failures WHERE version = 46')
    _db().commit()
    # Nothing left to apply: the ALTERs are no-ops against an existing column
    # (the runner swallows the duplicate-column error, it never aborts).
    assert run_migrations(_db()) == 0

    assert {c for c in _cols() if c in NEW_COLUMNS} == NEW_COLUMNS
    row = _row('s-before-rerun')
    assert row['end_reason'] == 'cap' and row['rounds'] == 9
    names = [r['name'] for r in _db().execute('PRAGMA table_info(turn_outcomes)').fetchall()]
    assert len(names) == len(set(names))
    # And the write path still distinguishes measured from unmeasured.
    turn_outcomes.record_turn_outcome(
        model='m', provider='p', task_type='agent', ok=True, session_id='s-after-rerun'
    )
    _flush()
    assert _row('s-after-rerun')['end_reason'] is None


def test_stats_query_degrades_on_a_pre_046_database(isolatedData):
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    for col in sorted(NEW_COLUMNS):
        _db().execute(f'ALTER TABLE turn_outcomes DROP COLUMN {col}')
    _db().commit()
    stats = turn_outcomes.turn_verdict_stats(days=7)
    assert stats['turns'] == 0
    assert stats['counters'] == {}


# ── guardrail roll-up (a read of the existing log, not a second writer) ──


def test_guardrail_digest_counts_this_turns_blocks(isolatedData):
    from app.services import memory_store, turn_outcomes
    from app.services.workbench.tool_guardrails import record_guardrail_block

    memory_store.init()
    record_guardrail_block('s-gr', 'edit_file', 'Blocked: identical arguments keep repeating')
    record_guardrail_block('s-gr', 'edit_file', 'Blocked: alternating calls')
    record_guardrail_block('s-gr', 'run_command', "Blocked: 'run_command' has failed 8 times")
    digest, samples = turn_outcomes.guardrail_class_digest('s-gr', _EPOCH)
    assert digest == ',edit_file:2,run_command:1,'
    assert turn_outcomes.parse_guardrail_digest(digest) == {'edit_file': 2, 'run_command': 1}
    assert set(samples) == {'edit_file', 'run_command'}
    assert 'identical arguments' in samples['edit_file']

    # Measured-and-empty — NOT the same as "could not measure".
    emptyDigest, emptySamples = turn_outcomes.guardrail_class_digest('s-none', _EPOCH)
    assert emptyDigest == '' and emptySamples == {}
    noSession, _ = turn_outcomes.guardrail_class_digest('', _EPOCH)
    assert noSession is None


# ── 3: widened failure learning ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_verify_and_error_signatures_stay_separate(isolatedData, monkeypatch):
    """A repeated gate miss earns ONE lesson, at its own key, and never
    collapses into the upstream error-class lesson."""
    from app.services import memory_store, turn_outcomes
    from app.services.memory_store import get_fact

    async def approve(*_a, **_k):
        return True

    def noSimilar(*_a, **_k):
        return []

    monkeypatch.setattr(turn_outcomes, '_review_lesson', approve)
    # The strict-necessity (BM25) filter has its own tests; here the two
    # candidate lessons are judged only on their signature spaces.
    monkeypatch.setattr('app.services.memory_store.fact_retrieval.find_similar_facts', noSimilar)
    memory_store.init()

    for _ in range(3):
        turn_outcomes.record_turn_outcome(
            model='mv',
            provider='pv',
            task_type='agent',
            ok=False,
            error_class='timeout',
            session_id='s-both',
            edit_verify_fails=2,
        )
    _flush()

    status = await turn_outcomes.maybe_promote_failure_lesson(
        model='mv',
        provider='pv',
        error_class='timeout',
        sample_error='request timed out after 60s',
        failure_classes=[
            turn_outcomes.FailureClass(
                turn_outcomes.KIND_EDIT_VERIFY, '', '[verification FAILED — pytest] no tests ran'
            )
        ],
    )
    assert status.count('promoted') == 2, status

    errSig = turn_outcomes._signature('pv', 'mv', 'timeout')
    evSig = turn_outcomes._signature('pv', 'mv', '', turn_outcomes.KIND_EDIT_VERIFY)
    assert errSig != evSig
    errFact = get_fact(f'harness-lesson:{errSig}')
    evFact = get_fact(f'harness-lesson:{evSig}')
    assert errFact is not None and 'error class' in _factText(errFact)
    assert 'timeout' in _factText(errFact)
    assert evFact is not None and 'edit-verification' in _factText(evFact)
    # The gate lesson never quotes the upstream error sentence, and the other
    # way round: two facts, two vocabularies, two keys.
    assert 'error class' not in _factText(evFact)
    assert 'edit-verification' not in _factText(errFact)
    assert len(_lessonFacts()) == 2

    # Cooldown is per signature too: a second pass promotes nothing new.
    again = await turn_outcomes.maybe_promote_failure_lesson(
        model='mv',
        provider='pv',
        error_class='timeout',
        sample_error='request timed out after 60s',
        failure_classes=[
            turn_outcomes.FailureClass(turn_outcomes.KIND_EDIT_VERIFY, '', 'gate rejected the fix')
        ],
    )
    assert 'promoted' not in again
    assert len(_lessonFacts()) == 2


@pytest.mark.asyncio
async def test_guardrail_promotion_uses_its_own_signature_space(isolatedData, monkeypatch):
    """Two blocked turns on ``edit_file`` is below the threshold even though
    the same model was blocked three times on ``run_command`` — the noisy tool
    neither starves nor feeds the quiet one, and a blocked-tool lesson is not
    an error-class lesson."""
    from app.services import memory_store, turn_outcomes

    async def approve(*_a, **_k):
        return True

    monkeypatch.setattr(turn_outcomes, '_review_lesson', approve)
    memory_store.init()
    for digest in (',edit_file:1,', ',edit_file:1,', ',run_command:1,', ',run_command:2,', ',run_command:1,'):
        turn_outcomes.record_turn_outcome(
            model='mg',
            provider='pg',
            task_type='agent',
            ok=True,
            session_id='s-gr-window',
            guardrail_classes=digest,
        )
    _flush()

    quiet = await turn_outcomes.maybe_promote_failure_lesson(
        model='mg',
        provider='pg',
        error_class='',
        sample_error='',
        failure_classes=[
            turn_outcomes.FailureClass(turn_outcomes.KIND_GUARDRAIL, 'edit_file', 'identical call')
        ],
    )
    assert quiet == 'below-threshold'

    loud = await turn_outcomes.maybe_promote_failure_lesson(
        model='mg',
        provider='pg',
        error_class='',
        sample_error='',
        failure_classes=[
            turn_outcomes.FailureClass(turn_outcomes.KIND_GUARDRAIL, 'run_command', 'failed 8 times')
        ],
    )
    assert loud == 'promoted'
    sig = turn_outcomes._signature('pg', 'mg', 'run_command', turn_outcomes.KIND_GUARDRAIL)
    fact = memory_store.get_fact(f'harness-lesson:{sig}')
    assert fact is not None and 'guardrail' in _factText(fact)
    # Same tool name in the error space is a different signature — no merge.
    assert sig != turn_outcomes._signature('pg', 'mg', 'run-command')


@pytest.mark.asyncio
async def test_cancelled_turns_still_never_promote(isolatedData):
    """The widened input must not resurrect the old cancelled-turn lesson."""
    from app.services import memory_store, turn_outcomes

    memory_store.init()
    for _ in range(4):
        turn_outcomes.record_turn_outcome(
            model='mc',
            provider='pc',
            task_type='agent',
            ok=False,
            error_class='cancelled',
            session_id='s-cancel',
        )
    _flush()
    assert (
        await turn_outcomes.maybe_promote_failure_lesson(
            model='mc', provider='pc', error_class='cancelled', sample_error='user cancelled'
        )
        == 'below-threshold'
    )
    assert _lessonFacts() == []


# ── the seam in turn_close ───────────────────────────────────────────────


def _fakeSession(**attrs: object) -> SimpleNamespace:
    base: dict[str, object] = {
        'id': 's-tc',
        'agent_mode': 'agent',
        'messages': [],
        'metadata': {},
        'pendingMutations': [],
        'turnCount': 1,
    }
    base.update(attrs)
    return SimpleNamespace(**base)


async def _closeTurn(
    calls: list[dict[str, object]],
    session: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
    **kwargs: object,
) -> None:
    """Drive turn_close.turnTelemetry the way the loop does, capturing the
    fire-and-forget promotion so no review model is ever called."""
    from app.services.workbench import turn_close as _tc

    async def capture(**kw: object) -> str:
        calls.append(kw)
        return 'below-threshold'

    monkeypatch.setattr(
        'app.services.turn_outcomes.maybe_promote_failure_lesson', capture
    )
    currentMessages = kwargs.pop('currentMessages', [])
    toolRound = kwargs.pop('toolRound', 6)
    turnError = kwargs.pop('turnError', None)
    await _tc.turnTelemetry(
        session=session,
        sessionId=str(session.id),
        currentMessages=list(currentMessages),
        tools=[],
        openaiTools=[],
        resolvedModel='mm',
        resolvedProvider={'name': 'pp'},
        totals=_tc.TurnTotals(inputTokens=10, outputTokens=5),
        turnStartMs=int(time.time() * 1000) - 500,
        trace=SimpleNamespace(ttft_ms=12),
        turnError=turnError,
        emit=None,
        toolRound=int(toolRound),
        **kwargs,
    )
    _flush()
    # Let the promotion task the close scheduled run to completion.
    await asyncio.sleep(0.02)


@pytest.mark.asyncio
async def test_turn_close_records_the_verdict_the_loop_reports(isolatedData, monkeypatch):
    from app.services import memory_store

    memory_store.init()
    calls: list[dict[str, object]] = []
    await _closeTurn(
        calls,
        _fakeSession(id='s-report', _verify_state={'failStreak': 2}),
        monkeypatch,
        currentMessages=[
            {'role': 'tool', 'content': '[verification FAILED — pytest] 2 failed in 0.31s'}
        ],
        turnEndReason='cap',
        parseFailures=4,
        surfaceDowngraded=True,
    )
    row = _row('s-report')
    assert row['end_reason'] == 'cap'
    assert row['rounds'] == 6
    assert row['malformed_tool_args'] == 4
    assert row['surface_downgraded'] == 1
    assert row['edit_verify_fails'] == 2
    # The gate failure rides the widened lesson path, with a real sample.
    assert calls, 'lesson promotion never fired'
    classes = calls[0]['failure_classes'] or []
    assert [c.kind for c in classes] == ['edit_verify']
    assert 'verification FAILED' in classes[0].sample


@pytest.mark.asyncio
async def test_turn_close_leaves_the_verdict_null_when_the_loop_stays_silent(isolatedData, monkeypatch):
    """Until the loop passes its own reason, the row says NOT RECORDED —
    turn_close never guesses one out of the error text."""
    from app.services import memory_store

    memory_store.init()
    calls: list[dict[str, object]] = []
    await _closeTurn(
        calls,
        _fakeSession(id='s-silent'),
        monkeypatch,
        turnError='upstream 500 bad gateway',
    )
    row = _row('s-silent')
    assert row['end_reason'] is None
    assert row['rounds'] == 6  # toolRound is always in hand
    assert row['malformed_tool_args'] is None
    assert row['surface_downgraded'] is None
    assert row['edit_verify_fails'] is None
    assert row['guardrail_classes'] == ''  # measured: this session blocked nothing
    # An errored turn still reaches the promoter, with the error class only.
    assert calls and list(calls[0]['failure_classes'] or []) == []
    assert calls[0]['error_class'] == 'upstream_5xx'


@pytest.mark.asyncio
async def test_turn_close_accepts_snake_case_aliases_and_unknown_kwargs(isolatedData, monkeypatch):
    """A kwargs rename at the call site must not break the turn: a TypeError on
    this await would take down every chat over a telemetry field."""
    from app.services import memory_store

    memory_store.init()
    calls: list[dict[str, object]] = []
    await _closeTurn(
        calls,
        _fakeSession(id='s-alias'),
        monkeypatch,
        turn_reason='stall-stop',
        malformed_tool_args=1,
        surface_downgraded=0,
        stalledRounds=9,
    )
    row = _row('s-alias')
    assert row['end_reason'] == 'stall-stop'
    assert row['malformed_tool_args'] == 1
    assert row['surface_downgraded'] == 0
