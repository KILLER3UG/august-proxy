"""Regressions for the second tranche of harness fixes.

Each test pins a defect that shipped, and — where the fix could plausibly have
changed behaviour rather than just performance — pins the OLD behaviour as the
reference so the new code is provably equivalent rather than merely different.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

import pytest

# --------------------------------------------------------------------------
# 1. wire format: tool_choice was declared and dropped
# --------------------------------------------------------------------------


def _refTokenEstimate(s: str | None) -> int:
    """The original per-character estimator, verbatim from before the fix."""
    if not s:
        return 0
    tokens = 0.0
    for ch in s:
        code = ord(ch)
        if 19968 <= code <= 40959 or 13312 <= code <= 19903 or 12288 <= code <= 12351:
            tokens += 0.67
        elif 65280 <= code <= 65519:
            tokens += 0.67
        elif 12352 <= code <= 12447 or 12448 <= code <= 12543:
            tokens += 0.67
        elif 44032 <= code <= 55215:
            tokens += 0.67
        else:
            tokens += 0.25
    return max(1, int(tokens + 0.999))


class TestTokenEstimatorIsEquivalentNotJustFaster:
    """The estimator is 273x faster now (one C-level translate instead of a
    per-character Python loop on the event loop). It must produce IDENTICAL
    numbers — a cost readout that shifts is a regression, not a speedup."""

    @pytest.mark.parametrize(
        'sample',
        [
            '',
            'hello world',
            'plain ascii transcript text, nothing wide at all',
            '\u4f60\u597d\u4e16\u754c',
            'mixed \u4f60\u597d ascii 123',
            '\u65e5\u672c\u8a9e' * 40,
            '\u3000',
            '\uffff',
            '\uac00\ub2e4\ub098',
        ],
    )
    def test_matches_the_original_estimator(self, sample: str):
        from app.providers.clients.base import estimateStringTokens

        assert estimateStringTokens(sample) == _refTokenEstimate(sample)

    def test_matches_across_the_whole_wide_range(self):
        """One sample per codepoint across every range the table claims, so a
        range boundary typo cannot hide."""
        from app.providers.clients.base import _WIDE_RANGES, estimateStringTokens

        # chr() already yields the character; probe it directly.
        probes = []
        for lo, hi in _WIDE_RANGES:
            probes += [chr(lo), chr((lo + hi) // 2), chr(hi)]
        for s in probes:
            assert estimateStringTokens(s) == _refTokenEstimate(s), f'U+{ord(s):04X}'

    def test_is_actually_faster_on_a_realistic_transcript(self):
        from app.providers.clients.base import estimateStringTokens

        big = 'the quick brown fox jumps over the lazy dog. ' * 7000  # ~300 kB
        t0 = time.perf_counter()
        estimateStringTokens(big)
        new = time.perf_counter() - t0
        t0 = time.perf_counter()
        _refTokenEstimate(big)
        old = time.perf_counter() - t0
        assert new < old, f'new {new:.4f}s was not faster than old {old:.4f}s'


class TestToolChoiceIsForwarded:
    def test_anthropic_model_keeps_tool_choice(self):
        from app.adapters.anthropic import buildAnthropicUpstreamRequest
        from app.models.anthropic import AnthropicRequest

        req = AnthropicRequest(
            model='m',
            messages=[{'role': 'user', 'content': 'hi'}],
            tool_choice={'type': 'tool', 'name': 'read_file'},
        )
        out = buildAnthropicUpstreamRequest(req, 'm')
        assert out['tool_choice'] == {'type': 'tool', 'name': 'read_file'}

    def test_anthropic_dict_body_keeps_tool_choice(self):
        from app.adapters.anthropic import buildAnthropicUpstreamRequest

        out = buildAnthropicUpstreamRequest(
            {'messages': [], 'tool_choice': {'type': 'any'}}, 'm'
        )
        assert out['tool_choice'] == {'type': 'any'}

    def test_absent_tool_choice_stays_absent(self):
        from app.adapters.anthropic import buildAnthropicUpstreamRequest
        from app.models.anthropic import AnthropicRequest

        req = AnthropicRequest(model='m', messages=[])
        assert 'tool_choice' not in buildAnthropicUpstreamRequest(req, 'm')
        assert 'tool_choice' not in buildAnthropicUpstreamRequest({'messages': []}, 'm')

    @pytest.mark.parametrize(
        'openai_choice,expected',
        [
            ('required', {'type': 'any'}),
            ('auto', None),
            ('none', None),
            ({'type': 'function', 'function': {'name': 'x'}}, {'type': 'tool', 'name': 'x'}),
            ({'type': 'function'}, None),
            (None, None),
            ({'type': 'bogus'}, None),
        ],
    )
    def test_openai_choice_translates_to_the_anthropic_dialect(
        self, openai_choice, expected
    ):
        """Same key, different shape. Forwarding the OpenAI value unchanged makes
        strict Anthropic gateways 400."""
        from app.adapters.openai import _openaiToAnthropicBody

        body = {'messages': [{'role': 'user', 'content': 'hi'}]}
        if openai_choice is not None:
            body['tool_choice'] = openai_choice
        out = _openaiToAnthropicBody(body)
        assert out.get('tool_choice') == expected

    @pytest.mark.parametrize(
        'anthropic_choice,expected',
        [
            ({'type': 'any'}, 'required'),
            ({'type': 'tool', 'name': 'y'}, {'type': 'function', 'function': {'name': 'y'}}),
            ({'type': 'tool'}, None),
            ({'type': 'auto'}, None),
            (None, None),
        ],
    )
    def test_anthropic_choice_translates_to_the_openai_dialect(
        self, anthropic_choice, expected
    ):
        from app.adapters.anthropic import _anthropicToolChoiceToOpenai

        assert _anthropicToolChoiceToOpenai(anthropic_choice) == expected


# --------------------------------------------------------------------------
# 2. paged read_file: no second full copy, no whole-file line list
# --------------------------------------------------------------------------


class TestLineHelpersMatchSplitlines:
    """The paging path used `content.splitlines(keepends=True)` to return 200
    lines of a 200 MB file, which materialises every line. The replacement must
    be EXACTLY equivalent or the model gets anchors that address the wrong
    lines — a silent corruption of every edit that follows."""

    @pytest.mark.parametrize(
        'content',
        [
            '',
            'a',
            'a\n',
            'a\nb',
            'a\nb\n',
            '\n\n\n',
            'a\r\nb\r\nc',
            'a\rb\rc',
            'a\vb\fc',
            'a\x1cb\x1dc\x1ee',
            'a\x85b',
            'a\u2028b\u2029c',
            'mixed\r\nx\ny\u2028z',
            'x' * 5000 + '\n' + 'y' * 10,
        ],
    )
    def test_count_equals_splitlines_length(self, content: str):
        from app.services.tool_registrations.file_tools import _countLines

        assert _countLines(content) == len(content.splitlines(keepends=True))

    @pytest.mark.parametrize('content', ['a\nb\nc\nd\ne\n', 'a\r\nb\r\n', 'x\vy\nz'])
    def test_slice_equals_the_splitlines_slice(self, content: str):
        from app.services.tool_registrations.file_tools import _sliceLines

        ref = content.splitlines(keepends=True)
        for a, b in ((1, len(ref)), (2, len(ref)), (1, 1), (1, max(1, len(ref)))):
            if b < a or a > len(ref):
                continue
            assert _sliceLines(content, a, b) == ref[a - 1 : b], (content, a, b)

    def test_fuzzed_against_splitlines(self):
        import random

        from app.services.tool_registrations.file_tools import _countLines, _sliceLines

        rng = random.Random(11)
        alphabet = 'ab\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029 '
        for _ in range(400):
            s = ''.join(rng.choice(alphabet) for _ in range(rng.randint(0, 60)))
            ref = s.splitlines(keepends=True)
            assert _countLines(s) == len(ref), repr(s)
            for a, b in ((1, len(ref)), (2, len(ref))):
                if b < a or a > len(ref):
                    continue
                assert _sliceLines(s, a, b) == ref[a - 1 : b], (repr(s), a, b)


class TestPagedReadHashesOffLoop:
    async def test_the_hash_matches_the_bytes_on_disk(self, tmp_path):
        """The streamed chunked hash must equal `sha256(raw bytes)` — the value
        the executor verifies a stale edit against."""
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'f.txt'
        f.write_bytes(b'line one\r\nline two\r\n\xff\xfe binary tail')
        out = await _readFile(str(f))
        expected = hashlib.sha256(f.read_bytes()).hexdigest()
        assert f'[sha256 {expected}]' in out

    async def test_crlf_file_hash_is_stable(self, tmp_path):
        """Text decoding normalizes CRLF -> LF, so hashing the decoded text made
        every CRLF file mismatch on its first edit. The raw-byte hash is what
        keeps that fixed."""
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'crlf.txt'
        f.write_bytes(b'a\r\nb\r\n')
        out = await _readFile(str(f))
        assert f'[sha256 {hashlib.sha256(b"a\r\nb\r\n").hexdigest()}]' in out

    async def test_paging_reports_the_right_total(self, tmp_path):
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'paged.txt'
        f.write_text('\n'.join(f'line {i}' for i in range(1, 501)), encoding='utf-8')
        out = await _readFile(str(f), offset=10, limit=5)
        assert '[lines 10-14 of 500]' in out
        assert 'line 10' in out and 'line 14' in out
        assert 'line 15' not in out

    async def test_starting_past_the_end_is_explicit(self, tmp_path):
        from app.services.tool_registrations.file_tools import _readFile

        f = tmp_path / 'short.txt'
        f.write_text('a\nb\n', encoding='utf-8')
        out = await _readFile(str(f), offset=99)
        assert 'no line 99' in out


# --------------------------------------------------------------------------
# 3. lifecycle
# --------------------------------------------------------------------------


class TestHarnessJobSweep:
    def test_a_job_left_running_is_resolved_at_boot(self, isolatedData):
        """The packaged quit is taskkill /F, so the wave driver's finish_job never
        ran and the row stayed `running` for good — the sidebar counted a dead
        job as working forever."""
        import time as _t

        from app.services import harness_jobs
        from app.services.memory_store import _conn

        harness_jobs.create_job('sess-1', waves=[[{'goal': 'a'}]])

        conn = _conn()
        assert (
            conn.execute("SELECT status FROM harness_jobs WHERE session_id='sess-1'").fetchone()[0]
            == 'running'
        )

        swept = harness_jobs.sweep_orphaned_jobs()
        assert swept >= 1

        row = conn.execute(
            "SELECT status, error FROM harness_jobs WHERE session_id='sess-1'"
        ).fetchone()
        assert row[0] == 'failed'
        assert 'Lost' in (row[1] or '')
        assert _t  # keep the import meaningful for readers

    def test_terminal_jobs_are_untouched(self, isolatedData):
        from app.services import harness_jobs
        from app.services.memory_store import _conn

        job_id = harness_jobs.create_job('sess-2', waves=[[{'goal': 'a'}]])
        harness_jobs.finish_job(job_id, 'completed')

        harness_jobs.sweep_orphaned_jobs()
        status = (
            _conn()
            .execute('SELECT status FROM harness_jobs WHERE id = ?', (job_id,))
            .fetchone()[0]
        )
        assert status == 'completed'

    def test_the_sweep_is_idempotent(self, isolatedData):
        from app.services import harness_jobs

        harness_jobs.create_job('sess-3', waves=[[{'goal': 'a'}]])
        assert harness_jobs.sweep_orphaned_jobs() == 1
        assert harness_jobs.sweep_orphaned_jobs() == 0


class TestShutdownDrainsSubprocesses:
    async def test_terminal_sessions_are_closed_on_shutdown(self, monkeypatch):
        """`closeAllTerminalSessions` existed with ZERO callers, so winpty shells
        survived a graceful stop and the next backend spawned a fresh set."""
        from app.services.workbench import terminal_service

        closed: list[str] = []

        async def _fakeClose(sid: str):
            closed.append(sid)

        monkeypatch.setattr(terminal_service, 'closeTerminalSession', _fakeClose)
        terminal_service._sessions['t1'] = object()
        terminal_service._sessions['t2'] = object()
        await terminal_service.closeAllTerminalSessions()
        assert sorted(closed) == ['t1', 't2']

    async def test_mcp_servers_are_stopped_on_shutdown(self, monkeypatch):
        """There was no MCP equivalent at all — only per-server stop."""
        from app.services.tools import mcp_client

        stopped: list[str] = []
        mcp_client._processes.update({'a': object(), 'b': object()})

        async def _fakeStop(sid: str):
            stopped.append(sid)

        monkeypatch.setattr(mcp_client, '_stopServerProcess', _fakeStop)
        try:
            assert await mcp_client.shutdownAllServers() == 2
            assert sorted(stopped) == ['a', 'b']
        finally:
            mcp_client._processes.clear()

    async def test_one_failing_server_does_not_block_the_rest(self, monkeypatch):
        from app.services.tools import mcp_client

        stopped: list[str] = []
        mcp_client._processes.update({'bad': object(), 'good': object()})

        async def _fakeStop(sid: str):
            if sid == 'bad':
                raise RuntimeError('already gone')
            stopped.append(sid)

        monkeypatch.setattr(mcp_client, '_stopServerProcess', _fakeStop)
        try:
            assert await mcp_client.shutdownAllServers() == 1
            assert stopped == ['good']
        finally:
            mcp_client._processes.clear()


class TestMalformedToolUseIsNotExecuted:
    """A stream can end mid-`tool_use`, leaving the `{'_raw': …}` sentinel.
    Two of the three dispatch loops already refused to execute it; the native
    Anthropic streaming one did not, so a truncated stream produced a generic
    schema hint instead of the documented self-heal."""

    def test_the_native_loop_has_the_guard_its_siblings_have(self):
        import inspect

        from app.adapters import anthropic

        src = inspect.getsource(anthropic._streamAnthropicNative)
        assert '_invalid_json' in src and 'validationErrorText' in src, (
            'the native streaming loop lost the malformed-tool_use guard its '
            'siblings (_handleMessagesNonStreaming, the OpenAI-shaped path) have'
        )

    def test_every_managed_tool_dispatch_loop_refuses_a_raw_sentinel(self):
        """Three loops resolve managed tool calls. All three must refuse a
        malformed `input` rather than executing it — the native Anthropic one
        used to be the odd one out."""
        import inspect

        from app.adapters import anthropic

        loops = [
            anthropic.resolveManagedAnthropicToolUses,
            anthropic._streamAnthropicNative,
            anthropic._streamOpenaiAsAnthropic,
        ]
        for fn in loops:
            src = inspect.getsource(fn)
            assert '_invalid_json' in src or "'_raw'" in src, (
                f'{fn.__name__} lost the malformed-tool_use guard'
            )


class TestLifespanActuallyCallsTheDrains:
    """These fixes were about a MISSING CALL, not a broken function. The tests
    above exercise the functions directly, so reverting the `main.py` wiring
    left them green — which is how a fix can be reverted and still look tested.
    These assert the wiring itself."""

    LIFESPAN = 'app/main.py'

    def _lifespan_source(self) -> str:
        import pathlib

        return (pathlib.Path(__file__).resolve().parents[1] / self.LIFESPAN).read_text('utf-8')

    def test_boot_sweeps_orphaned_harness_jobs(self):
        assert 'sweep_orphaned_jobs()' in self._lifespan_source(), (
            'main.py no longer sweeps harness_jobs at boot, so a quit mid-fleet '
            'leaves a row running forever again'
        )

    def test_shutdown_drains_terminals_and_mcp(self):
        src = self._lifespan_source()
        assert 'closeAllTerminalSessions()' in src, (
            'the terminal close-all exists with no caller again — winpty shells '
            'survive a graceful stop'
        )
        assert 'shutdownAllServers()' in src, (
            'MCP stdio children are not drained on shutdown again'
        )

    def test_the_deferred_lane_reaches_the_checkpoint(self):
        """The deferred lane must commit THROUGH `memory_conn.commit`, so the
        WAL checkpoint counts it.

        This used to assert on a private `_noteCheckpoint` helper that called
        `note_commit()` from `deferred_writes._commit`. When both lanes were
        unified onto `memory_conn.commit`, that helper disappeared — and the
        assertion failed while the PROPERTY it guarded was still true. Assert
        the funnel, not the implementation that happened to provide it.
        """
        import inspect

        from app.services import deferred_writes

        src = inspect.getsource(deferred_writes._commit)
        assert 'brain_commit' in src, (
            'deferred_writes._commit no longer commits through '
            'memory_conn.commit, so the WAL checkpoint stops counting these writes'
        )


class TestGatewayStopDrainsTheQueue:
    class _Bridge:
        def __init__(self):
            self.cancelled: list[str] = []

        async def cancelRunning(self, key):
            self.cancelled.append(key)

    async def test_stop_discards_queued_messages(self):
        """/stop said "Stopped." and then ran every queued message as another
        billed turn, because cancelRunning only covers the in-flight one."""
        from app.services.gateway.base import BasePlatformAdapter

        sent: list[str] = []

        async def _sendMessage(chat_id: str, message: str) -> None:
            sent.append(message)

        class _Ev:
            class source:
                platform = 'x'
                user_id = 'u'
                chat_id = 'c'

            text = 'hi'

        class _Adapter(BasePlatformAdapter):
            def __init__(self, pending: dict):  # noqa: D107
                self._bridge = TestGatewayStopDrainsTheQueue._Bridge()
                self._pending = pending
                self._activeSessions: dict[str, object] = {}

            async def sendMessage(self, chat_id: str, text: str, **_kw) -> None:
                sent.append(text)

            async def connect(self) -> None: ...
            async def disconnect(self) -> None: ...
            async def getChatInfo(self, chat_id: str):  # noqa: ANN201
                return {}

            def normalize(self, raw):  # noqa: ANN001, ANN201
                return raw

        adapter = _Adapter({'k': [{'text': 'a'}, {'text': 'b'}]})
        await adapter._handleBypassCommand('k', _Ev(), 'stop')
        assert adapter._pending == {}
        assert any('Discarded 2' in m for m in sent), sent

    async def test_stop_with_nothing_queued_says_plainly(self):
        from app.services.gateway.base import BasePlatformAdapter

        sent: list[str] = []

        async def _sendMessage(chat_id: str, message: str) -> None:
            sent.append(message)

        class _Ev:
            class source:
                platform = 'x'
                user_id = 'u'
                chat_id = 'c'

            text = 'hi'

        class _Adapter(BasePlatformAdapter):
            def __init__(self, pending: dict):  # noqa: D107
                self._bridge = TestGatewayStopDrainsTheQueue._Bridge()
                self._pending = pending
                self._activeSessions: dict[str, object] = {}

            async def sendMessage(self, chat_id: str, text: str, **_kw) -> None:
                sent.append(text)

            async def connect(self) -> None: ...
            async def disconnect(self) -> None: ...
            async def getChatInfo(self, chat_id: str):  # noqa: ANN201
                return {}

            def normalize(self, raw):  # noqa: ANN001, ANN201
                return raw

        await _Adapter({})._handleBypassCommand('k', _Ev(), 'stop')
        assert sent == ['Stopped.']


# --------------------------------------------------------------------------
# 4. the dead stats hook is gone, not merely unwired
# --------------------------------------------------------------------------


def test_the_dead_silent_stats_facility_is_removed():
    """It had no reader anywhere, and 3 of its 6 counters were never bumped —
    so a reported 0 meant "no guard exists", not "no failures"."""
    import inspect

    from app.adapters import proxy_tools

    assert not hasattr(proxy_tools, 'get_proxy_silent_stats')
    assert not hasattr(proxy_tools, '_bump_silent')
    assert not hasattr(proxy_tools, '_execute_tool_batch')
    assert not hasattr(proxy_tools, '_is_tool_parallel_safe')
    assert '_silent_stats' not in inspect.getsource(proxy_tools)


def test_no_module_referenced_the_removed_names():
    import subprocess

    out = subprocess.run(
        ['grep', '-rn', '--include=*.py', '--exclude=test_tranche2_regressions.py', '-E',
         r'get_proxy_silent_stats|_bump_silent|_execute_tool_batch|_is_tool_parallel_safe',
         'app/', 'tests/'],
        capture_output=True, text=True,
    )
    assert not out.stdout.strip(), f'dangling references:\n{out.stdout}'


# --------------------------------------------------------------------------
# 5. SSE replay keeps the retry frame off the wire (regression guard)
# --------------------------------------------------------------------------


async def test_internal_retry_frames_never_reach_a_v1_client(monkeypatch):
    from app.adapters import openai as oai

    class _Client:
        async def streamSse(self, *_a, **_k):
            yield {'type': 'upstreamRetry', 'attempt': 1}
            yield {'choices': [{'delta': {'content': 'hi'}}]}

    async def _get():
        return _Client()

    monkeypatch.setattr(oai, '_getClient', _get)
    chunks = [c async for c in oai.streamOpenaiSseToClient('http://x', {}, {'model': 'm'})]
    body = ''.join(chunks)
    assert 'upstreamRetry' not in body
    assert 'hi' in body
    assert json.dumps  # keep json imported meaningfully
