"""Interceptions must land in the evidence trail, not just in a return string.

Roadmap #7. A hash-anchored edit whose ``fileHash`` no longer matches is the
loudest self-correction signal the loop produces — the harness caught the model
about to overwrite text it had not actually read. It returned an error string
and nothing else: no log (contrast the PRE-hook failure two lines away), no
counter, no ``record_guardrail_block``.

``tool_guardrail_log`` has exactly one writer, and ``turn_close`` builds the
per-turn ``guardrail_classes`` digest from that table. So every stale-write
block — the one case where the harness demonstrably SAVED a file from being
clobbered — was invisible to the evidence trail built to learn from it, and
could never reach the failure-lesson path. Structurally always zero, so
nothing noticed.

Same for the two timeout seams: a tool the harness killed mid-flight is an
interception, not a tool that merely returned an error.
"""

from __future__ import annotations

import hashlib

import pytest


@pytest.fixture(autouse=True)
def _sid(monkeypatch):
    """Pin the session id the tools read out of the context var."""
    from app.services.workbench import context as ctx

    token = ctx.currentSessionId.set('sess-intercept')
    yield 'sess-intercept'
    ctx.currentSessionId.reset(token)


def _blocks(reason: str | None = None) -> list[dict]:
    from app.services.memory_conn import conn

    rows = conn().execute(
        'SELECT session_id, tool_name, reason FROM tool_guardrail_log'
        + (' WHERE reason = ?' if reason else '')
        + ' ORDER BY id',
        ((reason,) if reason else ()),
    ).fetchall()
    return [dict(r) for r in rows]


@pytest.fixture
def workspace(isolatedData, tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_WORKSPACE', str(tmp_path))
    from app.services.tool_registrations import file_tools

    monkeypatch.setattr(file_tools, '_workspace', lambda: str(tmp_path))
    return tmp_path


class TestStaleWriteIsRecorded:
    @pytest.mark.asyncio
    async def test_a_stale_hash_records_a_guardrail_block(self, workspace):
        from app.services.tool_registrations import file_tools

        target = workspace / 'a.py'
        target.write_text('original\n', encoding='utf-8')
        stale = hashlib.sha256(b'something else entirely').hexdigest()

        out = await file_tools._editLines(
            str(target), stale, [{'line': 1, 'old': 'original', 'new': 'clobbered'}]
        )
        assert 'no longer matches' in out, 'the edit was not rejected'
        rows = _blocks('stale_write')
        assert len(rows) == 1, f'the interception landed nowhere: {rows}'
        assert rows[0]['tool_name'] == 'edit_lines'
        assert rows[0]['session_id'] == 'sess-intercept'

    @pytest.mark.asyncio
    async def test_apply_patch_stale_hash_is_recorded_too(self, workspace):
        from app.services.tool_registrations import file_tools

        target = workspace / 'b.py'
        target.write_text('original\n', encoding='utf-8')
        stale = hashlib.sha256(b'nope').hexdigest()
        patch = '--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-original\n+clobbered\n'
        out = await file_tools._applyPatch(str(target), patch, fileHash=stale)
        assert 'no longer matches' in out or 'Error' in out
        rows = _blocks('stale_write')
        assert len(rows) == 1, f'the interception landed nowhere: {rows}'
        assert rows[0]['tool_name'] == 'apply_patch'

    @pytest.mark.asyncio
    async def test_the_file_is_untouched(self, workspace):
        """The record must not change the outcome: the write is still refused."""
        from app.services.tool_registrations import file_tools

        target = workspace / 'c.py'
        target.write_text('original\n', encoding='utf-8')
        stale = hashlib.sha256(b'x').hexdigest()
        await file_tools._editLines(
            str(target), stale, [{'line': 1, 'old': 'original', 'new': 'clobbered'}]
        )
        assert target.read_text(encoding='utf-8') == 'original\n'

    @pytest.mark.asyncio
    async def test_a_correct_hash_records_nothing(self, workspace):
        """Recording is not unconditional — a clean edit must stay silent."""
        from app.services.tool_registrations import file_tools

        target = workspace / 'd.py'
        target.write_text('original\n', encoding='utf-8')
        # Hash the bytes ON DISK, not `b'original\\n'`. On Windows write_text
        # translates the newline, so the file is b'original\\r\\n' and the
        # hand-written hash is genuinely stale — which the harness correctly
        # refuses. That made this test fail until the hash came from the file.
        good = hashlib.sha256(target.read_bytes()).hexdigest()
        await file_tools._editLines(
            str(target), good, [{'line': 1, 'old': 'original', 'new': 'edited'}]
        )
        assert not _blocks('stale_write')
        assert 'edited' in target.read_text(encoding='utf-8')


class TestRecordingNeverChangesBehaviour:
    @pytest.mark.asyncio
    async def test_a_broken_brain_store_does_not_break_the_edit(self, workspace, monkeypatch):
        """Telemetry loss must not change tool behaviour."""
        from app.services.tool_registrations import file_tools

        target = workspace / 'e.py'
        target.write_text('original\n', encoding='utf-8')
        stale = hashlib.sha256(b'y').hexdigest()

        def _boom(*_a, **_kw):
            raise RuntimeError('brain store unavailable')

        monkeypatch.setattr('app.services.memory_conn.conn', _boom)
        out = await file_tools._editLines(
            str(target), stale, [{'line': 1, 'old': 'original', 'new': 'clobbered'}]
        )
        # The rejection still happens and still reaches the model.
        assert 'no longer matches' in out
        assert target.read_text(encoding='utf-8') == 'original\n'


class TestTheRecorderItself:
    def test_reason_strings_are_stable_constants(self):
        """turn_close groups by these; renaming one silently regroups history."""
        from app.services.workbench import tool_guardrails as tg

        assert tg.INTERCEPTION_STALE_WRITE == 'stale_write'
        assert tg.INTERCEPTION_TOOL_TIMEOUT == 'tool_timeout'
        assert tg.INTERCEPTION_MCP_TIMEOUT == 'mcp_timeout'
        assert tg.INTERCEPTION_ANCHOR_MISS == 'anchor_mismatch'

    def test_record_exec_interception_writes_a_row(self):
        from app.services.workbench.tool_guardrails import (
            INTERCEPTION_STALE_WRITE,
            record_exec_interception,
        )

        record_exec_interception('s-direct', 'edit_lines', INTERCEPTION_STALE_WRITE)
        rows = _blocks('stale_write')
        assert any(r['session_id'] == 's-direct' for r in rows)

    def test_an_oversized_reason_is_truncated_not_rejected(self):
        from app.services.workbench.tool_guardrails import record_exec_interception

        record_exec_interception('s-big', 'edit_lines', 'x' * 5000)
        rows = _blocks()
        assert any(len(r['reason']) == 600 for r in rows)
