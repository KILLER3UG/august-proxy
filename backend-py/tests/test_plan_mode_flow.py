"""Model-initiated plan mode + plan-file flow.

Covers:
  • enterPlanMode — model switches the session into plan mode (entry only).
  • is_plan_file_write / _checkToolGuard — the ONLY write allowed in plan
    mode is this session's plan markdown file (.aug/plans/<sessionId>.md);
    everything else stays blocked (fail closed).
  • _loadPlanPayload — submit_plan reads the session's own plan markdown
    file (never another session's); legacy inline payloads still work;
    nothing usable → None (model is told to write the file first).
  • Barrier prose — full mode points at enter_plan_mode, plan mode at the
    session-scoped plan file path.
"""

from types import SimpleNamespace

from app.services.memory.context_builder import _guard_mode_barrier_lines
from app.services.workbench import workbench as wb


def _session(tmp_path, *, guardMode='full'):
    return SimpleNamespace(
        id='s-test',
        guardMode=guardMode,
        agentId='build',
        updatedAt='',
        workspacePath=str(tmp_path),
        sandboxMode='workspace-write',
        plan=None,
        planApproved=False,
        metadata={},
    )


def _patchSideEffects(monkeypatch):
    """Neutralize persistence/realtime side effects for unit tests."""
    monkeypatch.setattr(wb, '_emitSessionStatus', lambda _sid: None)
    monkeypatch.setattr('app.services.workbench.sessions.save_sessions', lambda: None)
    monkeypatch.setattr(
        'app.services.workbench.prompt_cache.getCache',
        lambda: SimpleNamespace(invalidate=lambda _sid: None),
    )
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)
    monkeypatch.setattr('app.services.realtime_bus.emit_realtime', lambda *a, **kw: None)


# ── enterPlanMode ──────────────────────────────────────────────────────


def test_enter_plan_mode_switches_session(monkeypatch, tmp_path):
    _patchSideEffects(monkeypatch)
    session = _session(tmp_path, guardMode='full')
    emitted = []

    msg = wb.enterPlanMode(session, emit=emitted.append)

    assert session.guardMode == 'plan'
    assert session.agentId == 'plan'
    assert 'Plan mode enabled' in msg
    assert wb.plan_file_relpath('s-test') in msg
    assert emitted == [{'type': 'guardModeChanged', 'guardMode': 'plan', 'agentId': 'plan'}]


def test_enter_plan_mode_is_noop_when_already_plan(monkeypatch, tmp_path):
    _patchSideEffects(monkeypatch)
    session = _session(tmp_path, guardMode='plan')
    emitted = []

    msg = wb.enterPlanMode(session, emit=emitted.append)

    assert session.guardMode == 'plan'
    assert 'Already in Plan mode' in msg
    assert emitted == []  # no duplicate UI event


def test_enter_plan_mode_stashes_agent_role_and_restores(monkeypatch, tmp_path):
    """Plan mode must not permanently clobber a user-selected agent role —
    entering stashes the previous agentId; leaving plan mode restores it."""
    _patchSideEffects(monkeypatch)
    session = _session(tmp_path, guardMode='full')
    session.agentId = 'general'

    wb.enterPlanMode(session)
    assert session.guardMode == 'plan'
    assert session.agentId == 'plan'
    assert session.metadata.get('planAgentId') == 'general'

    # Leaving plan mode (guard-mode switch) restores the stashed role.
    from app.routers.workbench import restoreAgentAfterPlan

    session.agentId = 'plan'
    restoreAgentAfterPlan(session)
    assert session.agentId == 'general'
    assert session.metadata.get('planAgentId') is None

    # Without a stash the default role mapping applies.
    session2 = _session(tmp_path)
    restoreAgentAfterPlan(session2)
    assert session2.agentId == 'build'


# ── plan-file guard exception ──────────────────────────────────────────


def test_is_plan_file_write_accepts_only_the_plan_file(tmp_path):
    session = _session(tmp_path)
    planRel = wb.plan_file_relpath(session.id)
    planAbs = str(tmp_path / '.aug' / 'plans' / f'{session.id}.md')

    # Absolute + relative forms of the exact plan path are allowed.
    assert wb.is_plan_file_write(session, 'write_file', {'path': planAbs})
    assert wb.is_plan_file_write(session, 'write_file', {'path': planRel})
    assert wb.is_plan_file_write(session, 'edit_file', {'path': planRel})

    # Anything else fails closed — including the legacy shared plan.md and
    # another session's plan file.
    assert not wb.is_plan_file_write(session, 'write_file', {'path': 'src/app.py'})
    assert not wb.is_plan_file_write(session, 'write_file', {'path': '.aug/plans/plan.md'})
    assert not wb.is_plan_file_write(session, 'write_file', {'path': '.aug/plans/other.md'})
    assert not wb.is_plan_file_write(session, 'write_file', {'path': 'foo/../../secret.md'})
    assert not wb.is_plan_file_write(session, 'write_file', {})  # no path → block
    assert not wb.is_plan_file_write(session, 'read_file', {'path': planAbs})  # not a writer
    assert not wb.is_plan_file_write(session, 'run_command', {'path': planAbs})
    noWorkspace = SimpleNamespace(id='s-test', workspacePath=None)
    assert not wb.is_plan_file_write(noWorkspace, 'write_file', {'path': planAbs})


def test_check_tool_guard_plan_mode_allows_only_plan_file(monkeypatch, tmp_path):
    session = _session(tmp_path, guardMode='plan')
    planAbs = str(tmp_path / '.aug' / 'plans' / f'{session.id}.md')

    assert wb._checkToolGuard(session, 'write_file', {'path': planAbs, 'content': '# Plan'}) is None
    assert wb._checkToolGuard(session, 'read_file', {'path': 'anything.py'}) is None

    blocked = wb._checkToolGuard(session, 'write_file', {'path': 'src/app.py', 'content': 'x'})
    assert blocked is not None and wb.plan_file_relpath(session.id) in blocked
    assert wb._checkToolGuard(session, 'run_command', {'command': 'rm -rf /'}) is not None

    # Once approved, the guard lifts entirely.
    session.planApproved = True
    assert wb._checkToolGuard(session, 'write_file', {'path': 'src/app.py', 'content': 'x'}) is None


# ── submit_plan plan-file loading ──────────────────────────────────────


def test_load_plan_payload_reads_default_plan_file(tmp_path):
    session = _session(tmp_path, guardMode='plan')
    planDir = tmp_path / '.aug' / 'plans'
    planDir.mkdir(parents=True)
    (planDir / f'{session.id}.md').write_text('# My Plan\n\n- step one\n', encoding='utf-8')

    payload = wb._loadPlanPayload(session, {})

    assert payload is not None
    assert payload['markdown'] == '# My Plan\n\n- step one\n'
    assert payload['planPath'] == wb.plan_file_relpath(session.id)


def test_load_plan_payload_only_reads_the_sessions_own_plan_file(tmp_path):
    session = _session(tmp_path, guardMode='plan')
    planDir = tmp_path / '.aug' / 'plans'
    planDir.mkdir(parents=True)
    # Another session's plan + an arbitrary workspace file.
    (planDir / 'other-session.md').write_text('# Not Yours', encoding='utf-8')
    (tmp_path / 'custom-plan.md').write_text('# Custom', encoding='utf-8')

    # Explicit planPath to any other file is ignored → nothing usable.
    assert wb._loadPlanPayload(session, {'planPath': 'custom-plan.md'}) is None
    assert wb._loadPlanPayload(session, {'planPath': '.aug/plans/other-session.md'}) is None

    # Pointing at its own file (explicitly) works.
    (planDir / f'{session.id}.md').write_text('# Mine', encoding='utf-8')
    payload = wb._loadPlanPayload(session, {'planPath': wb.plan_file_relpath(session.id)})
    assert payload is not None and payload['markdown'] == '# Mine'


def test_load_plan_payload_rejects_planpath_outside_workspace(tmp_path):
    outside = tmp_path.parent / 'outside.md'
    outside.write_text('# Evil', encoding='utf-8')
    session = _session(tmp_path, guardMode='plan')

    # Escaping the workspace falls back to the (missing) own plan file → no payload.
    payload = wb._loadPlanPayload(session, {'planPath': '../outside.md'})
    assert payload is None


def test_load_plan_payload_legacy_inline_and_empty(tmp_path):
    session = _session(tmp_path, guardMode='plan')

    # No plan file, inline string payload → legacy shape.
    assert wb._loadPlanPayload(session, {'plan': 'do the thing'}) == {'plan': 'do the thing'}
    # Nothing at all → None so the loop tells the model to write the file.
    assert wb._loadPlanPayload(session, {}) is None


def test_plans_are_isolated_between_sessions_sharing_a_workspace(tmp_path):
    """Regression: the old fixed .aug/plans/plan.md leaked one session's plan
    into every other session in the same workspace."""
    a = SimpleNamespace(id='sess-a', workspacePath=str(tmp_path))
    b = SimpleNamespace(id='sess-b', workspacePath=str(tmp_path))
    planDir = tmp_path / '.aug' / 'plans'
    planDir.mkdir(parents=True)
    (planDir / 'sess-a.md').write_text('# A plan', encoding='utf-8')

    # B sees nothing: no own file, and A's file is not readable via planPath.
    assert wb._loadPlanPayload(b, {}) is None
    assert wb._loadPlanPayload(b, {'planPath': '.aug/plans/sess-a.md'}) is None
    # B may not write A's plan file in plan mode either.
    assert not wb.is_plan_file_write(b, 'write_file', {'path': '.aug/plans/sess-a.md'})
    # A reads its own plan fine.
    payload = wb._loadPlanPayload(a, {})
    assert payload is not None and payload['markdown'] == '# A plan'


# ── barrier prose ──────────────────────────────────────────────────────


def test_full_barrier_offers_enter_plan_mode():
    text = '\n'.join(_guard_mode_barrier_lines('full', 's-test'))
    assert 'enter_plan_mode' in text
    assert wb.plan_file_relpath('s-test') in text


def test_plan_barrier_names_the_session_plan_file():
    text = '\n'.join(_guard_mode_barrier_lines('plan', 's-test'))
    assert wb.plan_file_relpath('s-test') in text
    assert 'submit_plan' in text
