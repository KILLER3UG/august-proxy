"""Model-initiated plan mode + plan-file flow.

Covers:
  • enterPlanMode — model switches the session into plan mode (entry only).
  • is_plan_file_write / _checkToolGuard — the ONLY write allowed in plan
    mode is the plan markdown file (.aug/plans/plan.md); everything else
    stays blocked (fail closed).
  • _loadPlanPayload — submit_plan reads the plan markdown file; legacy
    inline payloads still work; nothing usable → None (model is told to
    write the file first).
  • Barrier prose — full mode points at enter_plan_mode, plan mode at the
    fixed plan file path.
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
    assert '.aug/plans/plan.md' in msg
    assert emitted == [{'type': 'guardModeChanged', 'guardMode': 'plan', 'agentId': 'plan'}]


def test_enter_plan_mode_is_noop_when_already_plan(monkeypatch, tmp_path):
    _patchSideEffects(monkeypatch)
    session = _session(tmp_path, guardMode='plan')
    emitted = []

    msg = wb.enterPlanMode(session, emit=emitted.append)

    assert session.guardMode == 'plan'
    assert 'Already in Plan mode' in msg
    assert emitted == []  # no duplicate UI event


# ── plan-file guard exception ──────────────────────────────────────────


def test_is_plan_file_write_accepts_only_the_plan_file(tmp_path):
    workspace = str(tmp_path)
    planAbs = str(tmp_path / '.aug' / 'plans' / 'plan.md')

    # Absolute + relative forms of the exact plan path are allowed.
    assert wb.is_plan_file_write(workspace, 'write_file', {'path': planAbs})
    assert wb.is_plan_file_write(workspace, 'write_file', {'path': '.aug/plans/plan.md'})
    assert wb.is_plan_file_write(workspace, 'edit_file', {'path': '.aug/plans/plan.md'})

    # Anything else fails closed.
    assert not wb.is_plan_file_write(workspace, 'write_file', {'path': 'src/app.py'})
    assert not wb.is_plan_file_write(workspace, 'write_file', {'path': '.aug/plans/other.md'})
    assert not wb.is_plan_file_write(workspace, 'write_file', {'path': 'foo/../../secret.md'})
    assert not wb.is_plan_file_write(workspace, 'write_file', {})  # no path → block
    assert not wb.is_plan_file_write(workspace, 'read_file', {'path': planAbs})  # not a writer
    assert not wb.is_plan_file_write(workspace, 'run_command', {'path': planAbs})
    assert not wb.is_plan_file_write(None, 'write_file', {'path': planAbs})  # no workspace


def test_check_tool_guard_plan_mode_allows_only_plan_file(monkeypatch, tmp_path):
    session = _session(tmp_path, guardMode='plan')
    planAbs = str(tmp_path / '.aug' / 'plans' / 'plan.md')

    assert wb._checkToolGuard(session, 'write_file', {'path': planAbs, 'content': '# Plan'}) is None
    assert wb._checkToolGuard(session, 'read_file', {'path': 'anything.py'}) is None

    blocked = wb._checkToolGuard(session, 'write_file', {'path': 'src/app.py', 'content': 'x'})
    assert blocked is not None and '.aug/plans/plan.md' in blocked
    assert wb._checkToolGuard(session, 'run_command', {'command': 'rm -rf /'}) is not None

    # Once approved, the guard lifts entirely.
    session.planApproved = True
    assert wb._checkToolGuard(session, 'write_file', {'path': 'src/app.py', 'content': 'x'}) is None


# ── submit_plan plan-file loading ──────────────────────────────────────


def test_load_plan_payload_reads_default_plan_file(tmp_path):
    planDir = tmp_path / '.aug' / 'plans'
    planDir.mkdir(parents=True)
    (planDir / 'plan.md').write_text('# My Plan\n\n- step one\n', encoding='utf-8')
    session = _session(tmp_path, guardMode='plan')

    payload = wb._loadPlanPayload(session, {})

    assert payload is not None
    assert payload['markdown'] == '# My Plan\n\n- step one\n'
    assert payload['planPath'] == '.aug/plans/plan.md'


def test_load_plan_payload_honors_explicit_planpath_inside_workspace(tmp_path):
    (tmp_path / 'custom-plan.md').write_text('# Custom', encoding='utf-8')
    session = _session(tmp_path, guardMode='plan')

    payload = wb._loadPlanPayload(session, {'planPath': 'custom-plan.md'})

    assert payload is not None and payload['markdown'] == '# Custom'


def test_load_plan_payload_rejects_planpath_outside_workspace(tmp_path):
    outside = tmp_path.parent / 'outside.md'
    outside.write_text('# Evil', encoding='utf-8')
    session = _session(tmp_path, guardMode='plan')

    # Escaping the workspace falls back to the (missing) default → no payload.
    payload = wb._loadPlanPayload(session, {'planPath': '../outside.md'})
    assert payload is None


def test_load_plan_payload_legacy_inline_and_empty(tmp_path):
    session = _session(tmp_path, guardMode='plan')

    # No plan file, inline string payload → legacy shape.
    assert wb._loadPlanPayload(session, {'plan': 'do the thing'}) == {'plan': 'do the thing'}
    # Nothing at all → None so the loop tells the model to write the file.
    assert wb._loadPlanPayload(session, {}) is None


# ── barrier prose ──────────────────────────────────────────────────────


def test_full_barrier_offers_enter_plan_mode():
    text = '\n'.join(_guard_mode_barrier_lines('full'))
    assert 'enter_plan_mode' in text
    assert '.aug/plans/plan.md' in text


def test_plan_barrier_names_the_fixed_plan_file():
    text = '\n'.join(_guard_mode_barrier_lines('plan'))
    assert '.aug/plans/plan.md' in text
    assert 'submit_plan' in text
