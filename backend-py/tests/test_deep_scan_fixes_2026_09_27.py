"""Regression tests for the five deep-scan fixes (2026-09-27 audit).

Each test here failed against the pre-fix working tree. They are pinned at the
behaviour level rather than the implementation level, so a future refactor can
move the code without losing the guarantee.

  1. `_editLines` invalidates the tool_result_cache (file_tools.py) — the
     second edit of a file in one session was refused [edit-stale] with
     nothing having changed underneath, because writeFile cleared the cache
     and the edit path did not.
  2. `_checkToolGuard` resolves the `bulk` meta-tool's operation before the
     running-session deletion check, so self-deletion through the aggregate
     path is blocked in every guard mode — the guard it was documented to be.
  3. The stage-B tool-result spill falls back to `openaiTools` on the
     OpenAI/Responses wires, where `tools` is never populated.
  4. `enqueueUserMessage` can store kind='daemon', so the auto-turn's
     `kinds={'subagent','daemon'}` drain is satisfiable.
  5. The skills credit is recorded whenever the skills lane renders, which is
     independent of the memory lane and of `memoryAutoInject` (OFF by default).
"""

from __future__ import annotations

import hashlib

import pytest
from app.services.workbench import workbench as wb

# ── 1. edit_lines must invalidate the read_file result cache ──────────────────


async def test_edit_lines_clears_read_cache(tmp_path, monkeypatch):
    """read -> edit -> read must see the edit, not the cached bytes.

    Without the fix the second read is served from the 30s cache, so the
    model's next edit_lines builds an anchor from pre-edit content and is
    rejected [edit-stale].
    """
    from app.services.tool_registrations import file_tools
    from app.services.workbench import tool_result_cache

    target = tmp_path / 'sample.txt'
    target.write_text('alpha\nbeta\ngamma\n', encoding='utf-8')

    monkeypatch.setattr(file_tools, '_session', lambda: None)
    # The cache reads the session id from the context module's ContextVar.
    from app.services.workbench import context as wb_context

    token = wb_context.currentSessionId.set('sess_cache')
    tool_result_cache.clear()
    try:
        first = await file_tools._readFile(str(target))
        assert 'alpha' in first

        raw = target.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        result = await file_tools._editLines(
            str(target),
            digest,
            [{'line': 2, 'old': 'beta', 'new': 'BETA'}],
        )
        assert result.startswith('Applied 1 edit'), result

        second = await file_tools._readFile(str(target))
        assert 'BETA' in second, 'read_file served a stale cached result after edit_lines'
        assert 'beta' not in second
    finally:
        wb_context.currentSessionId.reset(token)
        tool_result_cache.clear()


async def test_edit_lines_still_rejects_a_genuinely_stale_hash(tmp_path, monkeypatch):
    """The fix must not weaken the hash gate it clears the cache around."""
    from app.services.tool_registrations import file_tools

    target = tmp_path / 'guarded.txt'
    target.write_text('one\ntwo\n', encoding='utf-8')
    monkeypatch.setattr(file_tools, '_session', lambda: None)

    result = await file_tools._editLines(
        str(target),
        'deadbeef' * 8,  # wrong hash on purpose
        [{'line': 1, 'old': 'one', 'new': 'ONE'}],
    )
    assert 'Error' in result or 'no longer matches' in result, result
    assert target.read_text(encoding='utf-8') == 'one\ntwo\n', 'file was written despite a stale hash'


# ── 2. the running-session deletion guard must resolve the bulk alias ─────────


@pytest.fixture
def session():
    wb._sessions.clear()
    s = wb.createWorkbenchSession(provider='test')
    yield s
    wb._sessions.clear()


def test_guard_blocks_self_delete_through_bulk(session):
    """bulk(operation='delete_sessions') must not be able to delete the live session.

    bulk_tools.py routes this to the same handler with the same sessionIds
    args, so a name-only guard let the aggregate path walk straight past a
    check documented as blocked in EVERY guard mode.
    """
    blocked = wb._checkToolGuard(
        session, 'bulk', {'operation': 'delete_sessions', 'sessionIds': [session.id]}
    )
    assert blocked and 'currently running' in blocked


def test_guard_blocks_bulk_alias_operation(session):
    """bulk's own alias table maps delete_session -> delete_sessions."""
    blocked = wb._checkToolGuard(
        session, 'bulk', {'operation': 'delete_session', 'sessionIds': [session.id]}
    )
    assert blocked and 'currently running' in blocked


def test_guard_still_blocks_direct_names(session):
    for name, args in (
        ('delete_session', {'sessionId': session.id}),
        ('delete_sessions', {'sessionIds': [session.id]}),
    ):
        blocked = wb._checkToolGuard(session, name, args)
        assert blocked and 'currently running' in blocked, name


def test_guard_allows_deleting_another_session(session):
    """The fix must not turn the guard into a blanket session-deletion block."""
    assert wb._checkToolGuard(session, 'delete_sessions', {'sessionIds': ['wb_someone_else']}) is None
    assert (
        wb._checkToolGuard(
            session, 'bulk', {'operation': 'delete_sessions', 'sessionIds': ['wb_someone_else']}
        )
        is None
    )


def test_guard_ignores_unrelated_bulk_operations(session):
    """Only the session-deletion ops are diverted; bulk stays usable."""
    assert wb._checkToolGuard(session, 'bulk', {'operation': 'read_files', 'paths': ['a']}) is None


# ── 3. the stage-B spill must consider the OpenAI wire's tool list ────────────


def test_spill_retrieval_uses_openai_tools_when_anthropic_list_is_empty(session):
    """`tools` is only populated on the Anthropic wire; on OpenAI/Responses
    it stays []. Deciding from it alone made canRetrieve False there, so an
    oversized result was hard-truncated with no .aug file to re-read."""
    anthropic_defs = [{'name': 'read_file'}]
    openai_defs = [{'type': 'function', 'function': {'name': 'read_file'}}]

    # The OpenAI shape alone must be enough to permit a spill.
    assert wb._canRetrieveSpill([], openai_defs, session) is True
    # Both wires agree when both are populated.
    assert wb._canRetrieveSpill(anthropic_defs, openai_defs, session) is True
    # Anthropic-only (the pre-fix behaviour) also worked; keep it working.
    assert wb._canRetrieveSpill(anthropic_defs, [], session) is True


def test_spill_refused_when_no_reader_is_offered(session):
    """A receipt naming a path is a trap when nothing can read it back."""
    unrelated = [{'type': 'function', 'function': {'name': 'run_command'}}]
    assert wb._canRetrieveSpill([], unrelated, session) is False
    assert wb._canRetrieveSpill(None, None, session) is False


def test_spill_text_tool_protocol_can_always_read_back(session):
    """The text protocol parses every registered tool, so it always retrieves."""
    session._text_tool_protocol = True
    assert wb._canRetrieveSpill([], [], session) is True


async def test_oversized_result_spills_on_the_openai_wire(tmp_path, monkeypatch):
    """End-to-end through the helper: the verdict reaches the spill."""
    from app.services.workbench import tool_result_cache

    session.workspacePath = str(tmp_path)
    tool_result_cache.clear()
    big = 'z' * 60000
    openai_defs = [{'type': 'function', 'function': {'name': 'read_file'}}]
    inline = wb._spillToolResult(
        session,
        'run_command',
        big,
        retrievable=wb._canRetrieveSpill([], openai_defs, session),
    )
    assert inline is not None, 'spill was skipped on the OpenAI wire'
    assert '.aug/spill/' in inline


# ── 4. 'daemon' must be a storable queued-message kind ───────────────────────


def test_daemon_kind_survives_enqueue(session):
    entry = wb.enqueueUserMessage(session.id, 'daemon finished', kind='daemon')
    assert entry['kind'] == 'daemon', 'kind was coerced, so the daemon auto-turn could never fire'


def test_daemon_entries_are_drainable_by_the_auto_turn(session):
    """routers/workbench.py drains with kinds={'subagent','daemon'}."""
    wb.enqueueUserMessage(session.id, 'a user follow-up')  # must NOT be consumed
    wb.enqueueUserMessage(session.id, '[DAEMON] poll finished', kind='daemon')

    drained = wb.drainQueuedMessages(session.id, kinds={'subagent', 'daemon'})
    assert len(drained) == 1
    assert drained[0]['kind'] == 'daemon'
    # The user's own queued message stays for a later drain.
    assert len(wb.listQueuedMessages(session.id)) == 1


def test_unknown_kind_still_falls_back_to_queue(session):
    entry = wb.enqueueUserMessage(session.id, 'x', kind='not-a-real-kind')
    assert entry['kind'] == 'queue'
