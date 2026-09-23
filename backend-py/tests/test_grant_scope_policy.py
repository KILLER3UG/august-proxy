"""Grant scopes: what may be made permanent, and what must not.

`always` is written to disk and covers every later call carrying the same key,
so it is only meaningful while the key is specific to the arguments that were
approved. The dangerous shape is a wildcard or an unsandboxed-escape key — the
latter is produced by a failure fallback, so a transient exception could
otherwise turn one "run this unsandboxed" click into permanent policy.
"""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.grant_policy import durable_grant_allowed, effective_scope

# ── policy table ──────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    'key, allowed',
    [
        ('run_command:cmd:9f2c1a', True),          # one specific command
        ('write_file:/app/x.py', True),             # one specific path
        ('bulk:/a,/b', True),                       # one specific target set
        ('run_command:sandbox:unsandboxed:*', False),
        ('run_command:*', False),
        ('delete_file:*', False),
        ('anything:sandbox:unsandboxed:deadbeef', False),
    ],
)
def test_durable_grant_rule(key: str, allowed: bool) -> None:
    got, reason = durable_grant_allowed(key)
    assert got is allowed
    assert bool(reason) is (not allowed)
    if not allowed:
        assert 'this chat' in reason


def test_only_always_is_clamped() -> None:
    wildcard = 'run_command:*'
    assert effective_scope(wildcard, 'once') == ('once', '')
    assert effective_scope(wildcard, 'session') == ('session', '')
    assert effective_scope(wildcard, 'always')[0] == 'session'
    assert effective_scope('run_command:cmd:abc', 'always') == ('always', '')


def test_unknown_scope_still_falls_back_to_once() -> None:
    assert effective_scope('write_file:/x', 'forever')[0] == 'once'
    assert effective_scope('write_file:/x', '')[0] == 'once'
    assert effective_scope('write_file:/x', ' ALWAYS ')[0] == 'always'


# ── wiring into the real grant path ──────────────────────────────────────

@pytest.fixture()
def saved_grants(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record what would be written to disk as a permanent grant."""
    written: list[str] = []
    monkeypatch.setattr(
        wb, '_save_always_grant',
        lambda workspace, key: written.append(key),
    )
    return written


def _session(workspace: str | None = None):
    return wb.createWorkbenchSession(provider='stub-anthropic', workspacePath=workspace or '')


def test_escape_grant_is_not_made_permanent(saved_grants: list[str]) -> None:
    session = _session('/tmp/ws')
    escape_args = {'command': 'reg add somekey', 'sandboxEscape': True}
    key = wb._mutation_grant_key('run_command', escape_args)
    assert '*' in key or 'unsandboxed' in key, f'expected an escape-shaped key, got {key}'

    stored, note = wb.add_tool_grant(session, 'run_command', escape_args, scope='always')

    assert stored == 'session', 'an escape grant must not be recorded as always'
    assert note, 'the caller needs a reason to show the user'
    assert saved_grants == [], f'nothing may reach disk: {saved_grants}'
    # The approval still covers this session's call — it is not a refusal.
    assert wb.has_tool_grant(session, 'run_command', escape_args) is True


def test_specific_command_grant_still_becomes_permanent(saved_grants: list[str]) -> None:
    """The clamp must not quietly remove a working affordance."""
    session = _session('/tmp/ws')
    args = {'command': 'git status'}
    stored, note = wb.add_tool_grant(session, 'run_command', args, scope='always')
    assert stored == 'always'
    assert note == ''
    assert saved_grants == [wb._mutation_grant_key('run_command', args)]


def test_once_grant_return_shape_is_usable(saved_grants: list[str]) -> None:
    session = _session('/tmp/ws')
    stored, note = wb.add_tool_grant(session, 'write_file', {'path': '/tmp/ws/a.py'}, scope='once')
    assert (stored, note) == ('once', '')
    assert wb.has_tool_grant(session, 'write_file', {'path': '/tmp/ws/a.py'}) is True
    # once is consumed by the match above
    assert wb.has_tool_grant(session, 'write_file', {'path': '/tmp/ws/a.py'}) is False
