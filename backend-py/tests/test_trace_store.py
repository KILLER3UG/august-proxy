"""Trace store + model drift report."""

from __future__ import annotations

from app.services.routing_evidence import drift_report, record_turn
from app.services.trace_store import list_session_traces, recent_traces, record_turn_trace


def test_record_and_list_trace():
    record_turn_trace(
        session_id='trace-test-sess',
        turn_seq=3,
        prompt_hash='abc123',
        prompt_preview='do the thing',
        task_type='bugfix',
        model='m1',
        provider='p1',
        outcome='tool_error',
        rounds=4,
        tools_offered=12,
        tool_calls=['run_command', 'read_file'],
        self_heal_events={'parse_failures': 1, 'refusals': 0},
        evidence_state='unverified',
        input_tokens=100,
        output_tokens=50,
        duration_ms=1234,
        error='',
    )
    traces = list_session_traces('trace-test-sess')
    assert traces, 'trace not recorded'
    row = traces[0]
    assert row['session_id'] == 'trace-test-sess'
    assert row['turn_seq'] == 3
    assert row['prompt_hash'] == 'abc123'
    assert row['outcome'] == 'tool_error'
    assert row['rounds'] == 4
    assert row['tools_offered'] == 12
    assert row['tool_calls'] == ['run_command', 'read_file']
    assert row['self_heal_events']['parse_failures'] == 1


def test_recent_traces_and_session_filter():
    record_turn_trace(session_id='trace-a', model='m1', outcome='ok')
    record_turn_trace(session_id='trace-b', model='m2', outcome='error')
    all_rows = recent_traces(limit=10)
    assert any(r['session_id'] == 'trace-a' for r in all_rows)
    assert any(r['session_id'] == 'trace-b' for r in all_rows)
    only_a = list_session_traces('trace-a')
    assert only_a and all(r['session_id'] == 'trace-a' for r in only_a)


def _backdate(model: str, days: int) -> None:
    from app.services.routing_evidence import _conn

    _conn().execute(
        "UPDATE routing_evidence SET created_at = datetime('now', ?) WHERE model = ?",
        (f'-{days} hours', model),
    )
    _conn().commit()


def test_drift_report_flags_regressed_model():
    # Baseline turns (win) backdated into the baseline window...
    for i in range(20):
        record_turn(
            session_id=f'drift-base-{i}', task_type='bugfix', model='drift-m1',
            provider='dp', ok=True, source='turn', outcome='verified',
        )
    for i in range(20):
        record_turn(
            session_id=f'ok-base-{i}', task_type='bugfix', model='ok-m1',
            provider='dp', ok=True, source='turn', outcome='verified',
        )
    _backdate('drift-m1', 36)
    _backdate('ok-m1', 36)
    # ...then recent turns at 'now' (inside the recent window).
    for i in range(12):
        record_turn(
            session_id=f'drift-new-{i}', task_type='bugfix', model='drift-m1',
            provider='dp', ok=False, source='turn', outcome='error',
        )
    for i in range(12):
        record_turn(
            session_id=f'ok-new-{i}', task_type='bugfix', model='ok-m1',
            provider='dp', ok=True, source='turn', outcome='verified',
        )
    drift = drift_report(recent_days=1, baseline_days=1, min_recent_samples=5, drop=0.2)
    flagged = {r['model'] for r in drift}
    assert 'drift-m1' in flagged, f'drift-m1 not flagged: {drift}'
    assert 'ok-m1' not in flagged


def test_drift_report_respects_graded_outcome():
    """Refusals/thinking-only count as losses even when ok=1."""
    for i in range(10):
        record_turn(
            session_id=f'ref-base-{i}', task_type='bugfix', model='ref-m1',
            provider='dp', ok=True, source='turn', outcome='verified',
        )
    _backdate('ref-m1', 36)
    for i in range(10):
        record_turn(
            session_id=f'ref-new-{i}', task_type='bugfix', model='ref-m1',
            provider='dp', ok=True, source='turn', outcome='refusal',
        )
    drift = drift_report(recent_days=1, baseline_days=1, min_recent_samples=5, drop=0.5)
    flagged = {r['model'] for r in drift}
    assert 'ref-m1' in flagged, f'refusal-only model should be flagged: {drift}'


def test_capability_fingerprint_suggests_text_surface():
    """A model that never uses tools and keeps refusing gets toolSurface=text."""
    from app.services.trace_store import capability_fingerprint, record_turn_trace

    for i in range(12):
        record_turn_trace(
            session_id=f'fp-sess-{i}',
            model='fp-model',
            outcome='refusal',
            self_heal_events={'parse_failures': 0, 'refusals': 2, 'stall_nudges': 0},
            tool_calls=[],
        )
    fp = capability_fingerprint('fp-model', min_turns=10)
    assert fp['total'] == 12
    assert fp['refusal_rate'] >= 0.9
    assert fp['tool_use_rate'] == 0
    suggested = fp.get('suggestedProfile')
    assert isinstance(suggested, dict)
    assert suggested.get('toolSurface') == 'text'


def test_capability_fingerprint_suggests_reduced_for_bad_json():
    from app.services.trace_store import capability_fingerprint, record_turn_trace

    for i in range(12):
        record_turn_trace(
            session_id=f'fj-sess-{i}',
            model='fj-model',
            outcome='tool_error',
            self_heal_events={'parse_failures': 4, 'refusals': 0, 'stall_nudges': 0},
            tool_calls=['run_command'],
        )
    fp = capability_fingerprint('fj-model', min_turns=10)
    suggested = fp.get('suggestedProfile')
    assert isinstance(suggested, dict)
    assert suggested.get('toolSurface') in ('reduced', 'bare')


def test_capability_fingerprint_healthy_model_no_suggestion():
    from app.services.trace_store import capability_fingerprint, record_turn_trace

    for i in range(12):
        record_turn_trace(
            session_id=f'ok-sess-{i}',
            model='ok-model',
            outcome='verified',
            self_heal_events={'parse_failures': 0, 'refusals': 0, 'stall_nudges': 0},
            tool_calls=['read_file'],
        )
    fp = capability_fingerprint('ok-model', min_turns=10)
    assert fp.get('suggestedProfile') is None


def test_capability_fingerprint_needs_min_turns():
    from app.services.trace_store import capability_fingerprint, record_turn_trace

    record_turn_trace(session_id='min-sess', model='min-model', outcome='refusal')
    fp = capability_fingerprint('min-model', min_turns=10)
    assert fp.get('suggestedProfile') is None
