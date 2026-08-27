"""B0/T9 — august-bench: protocol, trajectory, integrity, runner, CLI."""

from __future__ import annotations

import io
import json
import os

import pytest
from app.bench import protocol
from app.bench.integrity import (
    is_solution_path,
    is_test_or_grader_path,
    make_integrity_handler,
)
from app.bench.protocol import (
    EXIT_ERROR,
    EXIT_INPUT,
    EXIT_OK,
    EXIT_TURN_LIMIT,
    JsonlWriter,
    bench_event,
    map_workbench_event,
    parse_final_answer,
    validate_against_schema,
)
from app.bench.runner import BenchOptions, _is_turn_limit_message, run_bench
from app.bench.trajectory import TrajectoryBuilder
from app.services.hooks.types import HookContext, HookEvent

# ---------------------------------------------------------------------------
# Protocol: envelopes, mapping, exit codes
# ---------------------------------------------------------------------------


class TestProtocol:
    def testExitCodes(self) -> None:
        assert (EXIT_OK, EXIT_ERROR, EXIT_INPUT, EXIT_TURN_LIMIT) == (0, 1, 42, 53)
        assert protocol.EXIT_NAMES[53] == 'turn-limit'

    def testBenchEventEnvelope(self) -> None:
        ev = bench_event('run/start', runId='r1', n=2)
        assert ev['type'] == 'run/start'
        assert ev['runId'] == 'r1' and ev['n'] == 2
        assert 'ts' in ev

    def testJsonlWriterOneObjectPerLine(self) -> None:
        buf = io.StringIO()
        writer = JsonlWriter(buf)
        writer.write('a', x=1)
        writer.write('b', y='two')
        lines = buf.getvalue().strip().split('\n')
        assert len(lines) == 2
        assert json.loads(lines[0])['type'] == 'a'
        assert json.loads(lines[1])['y'] == 'two'

    def testMapWorkbenchEvent(self) -> None:
        cases = {
            'started': 'run/model',
            'tool_use': 'step/tool_call',
            'toolResult': 'step/tool_result',
            'finalOutput': 'step/assistant',
            'compaction': 'context/compaction',
            'contextPressure': 'context/pressure',
            'retrying': 'run/retry',
            'warning': 'run/warning',
            'error': 'run/error',
            'done': 'run/done',
            'somethingNew': 'workbench/somethingNew',
        }
        for wb_type, bench_type in cases.items():
            mapped = map_workbench_event({'type': wb_type, 'k': 'v'})
            assert mapped is not None
            assert mapped[0] == bench_type
            assert mapped[1] == {'k': 'v'}  # payload minus the type key

    def testMapDropsUiChrome(self) -> None:
        for dropped in ('circuitMode', 'recurringTask', 'userMessageInjected', ''):
            assert map_workbench_event({'type': dropped}) is None


# ---------------------------------------------------------------------------
# Output-schema validation (dependency-free subset)
# ---------------------------------------------------------------------------


class TestSchemaValidation:
    def testTypeChecks(self) -> None:
        assert validate_against_schema({'a': 1}, {'type': 'object'})[0]
        assert not validate_against_schema([1], {'type': 'object'})[0]
        assert validate_against_schema('s', {'type': 'string'})[0]
        assert validate_against_schema(3, {'type': 'integer'})[0]
        # An integer satisfies "number".
        assert validate_against_schema(3, {'type': 'number'})[0]
        assert not validate_against_schema(3.5, {'type': 'integer'})[0]
        assert validate_against_schema(True, {'type': 'boolean'})[0]
        assert validate_against_schema(None, {'type': 'null'})[0]

    def testTypeUnion(self) -> None:
        schema = {'type': ['string', 'null']}
        assert validate_against_schema('x', schema)[0]
        assert validate_against_schema(None, schema)[0]
        assert not validate_against_schema(5, schema)[0]

    def testRequiredAndProperties(self) -> None:
        schema = {
            'type': 'object',
            'required': ['answer'],
            'properties': {'answer': {'type': 'integer'}, 'note': {'type': 'string'}},
        }
        ok, _ = validate_against_schema({'answer': 42}, schema)
        assert ok
        ok, reason = validate_against_schema({}, schema)
        assert not ok and 'answer' in reason
        ok, reason = validate_against_schema({'answer': 'forty-two'}, schema)
        assert not ok and 'answer' in reason
        # Extra keys are fine; unknown keywords are ignored.
        ok, _ = validate_against_schema({'answer': 1, 'extra': True}, schema)
        assert ok

    def testItemsAndEnum(self) -> None:
        ok, _ = validate_against_schema([1, 2], {'type': 'array', 'items': {'type': 'integer'}})
        assert ok
        ok, reason = validate_against_schema(
            [1, 'x'], {'type': 'array', 'items': {'type': 'integer'}}
        )
        assert not ok and '[1]' in reason
        ok, _ = validate_against_schema('a', {'enum': ['a', 'b']})
        assert ok
        ok, reason = validate_against_schema('z', {'enum': ['a', 'b']})
        assert not ok and 'enum' in reason


class TestParseFinalAnswer:
    SCHEMA = {'type': 'object', 'required': ['answer']}

    def testBareJson(self) -> None:
        ok, parsed, _ = parse_final_answer('{"answer": 42}', self.SCHEMA)
        assert ok and parsed == {'answer': 42}

    def testFencedJson(self) -> None:
        text = 'The result:\n```json\n{"answer": 7}\n```\nDone.'
        ok, parsed, _ = parse_final_answer(text, self.SCHEMA)
        assert ok and parsed == {'answer': 7}

    def testProseAroundJson(self) -> None:
        ok, parsed, _ = parse_final_answer('I conclude {"answer": 1} here.', self.SCHEMA)
        assert ok and parsed == {'answer': 1}

    def testSchemaMismatchReported(self) -> None:
        ok, parsed, reason = parse_final_answer('{"nope": 1}', self.SCHEMA)
        assert not ok
        assert parsed == {'nope': 1}
        assert 'answer' in reason

    def testNoJson(self) -> None:
        ok, parsed, reason = parse_final_answer('just words', self.SCHEMA)
        assert not ok and parsed is None and 'JSON' in reason

    def testEmpty(self) -> None:
        ok, _, reason = parse_final_answer('   ', self.SCHEMA)
        assert not ok and 'empty' in reason


# ---------------------------------------------------------------------------
# Trajectory builder (ATIF conventions)
# ---------------------------------------------------------------------------


def _ev(event_type: str, **payload):
    return {'type': event_type, 'ts': 't', **payload}


class TestTrajectory:
    def _builder(self) -> TrajectoryBuilder:
        return TrajectoryBuilder(
            run_id='r1', task='do it', model='m', provider='p'
        )

    def testOneStepPerApiTurn(self) -> None:
        tb = self._builder()
        # Turn 1: pressure → tool call → tool result → assistant text.
        tb.ingest(_ev('context/pressure', totalTokens=1000, maxContext=128000))
        tb.ingest(_ev('step/tool_call', id='t1', name='read_file', input={'path': 'a'}))
        tb.ingest(_ev('step/tool_result', id='t1', name='read_file', content='ok'))
        tb.ingest(_ev('step/assistant', content='I read the file.'))
        # Turn 2: next pressure opens a new step.
        tb.ingest(_ev('context/pressure', totalTokens=2000, maxContext=128000))
        tb.ingest(_ev('step/assistant', content='Done.'))
        assert len(tb.steps) == 2
        step1, step2 = tb.steps
        assert step1['index'] == 1 and step2['index'] == 2
        assert step1['tool_calls'][0]['name'] == 'read_file'
        assert step1['tool_results'][0]['content'] == 'ok'
        assert step1['assistant_text'] == 'I read the file.'
        assert step2['assistant_text'] == 'Done.'

    def testPeakContextAndSummarization(self) -> None:
        tb = self._builder()
        tb.ingest(_ev('context/pressure', totalTokens=1000, maxContext=128000))
        tb.ingest(_ev('context/pressure', totalTokens=5000, maxContext=128000))
        tb.ingest(_ev('context/pressure', totalTokens=3000, maxContext=128000))
        tb.ingest(_ev('context/compaction'))
        tb.ingest(_ev('context/compaction'))
        tb.ingest(_ev('run/retry'))
        assert tb.peak_context_tokens == 5000
        assert tb.max_context == 128000
        assert tb.summarization_count == 2
        assert tb.retries == 1

    def testNoFabricatedText(self) -> None:
        tb = self._builder()
        tb.ingest(_ev('context/pressure', totalTokens=10, maxContext=100))
        tb.ingest(_ev('step/tool_call', id='t1', name='x', input={}))
        # A step with only tool calls carries NO assistant text.
        assert tb.steps[0]['assistant_text'] == ''

    def testFinishAndWrite(self, tmp_path) -> None:
        tb = self._builder()
        tb.ingest(_ev('context/pressure', totalTokens=10, maxContext=100))
        tb.ingest(_ev('step/assistant', content='final'))
        tb.finish(
            exit_code=0,
            exit_reason='completed',
            final_answer='final',
            final_answer_parsed={'answer': 1},
            budgets={'maxTurns': 5},
            session_totals={'totalInputTokens': 10},
        )
        path = str(tmp_path / 'trajectory.json')
        tb.write(path)
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        assert doc['schema_version'].startswith('atif')
        assert doc['exit_code'] == 0
        assert doc['step_count'] == 1
        assert doc['final_answer_parsed'] == {'answer': 1}
        assert doc['integrity_violations'] == []


# ---------------------------------------------------------------------------
# Integrity guardrails
# ---------------------------------------------------------------------------


class TestIntegrityPaths:
    def testSolutionPaths(self) -> None:
        assert is_solution_path('solution/answer.py')
        assert is_solution_path('/task/2/solution/x.txt')
        assert is_solution_path('repo\\solution\\a.py')  # windows separators
        assert is_solution_path('solutions/a.py')
        assert not is_solution_path('my_solution.py')  # not a directory part
        assert not is_solution_path('src/solve.py')

    def testTestAndGraderPaths(self) -> None:
        assert is_test_or_grader_path('tests/test_a.py')
        assert is_test_or_grader_path('project/test/foo.py')
        assert is_test_or_grader_path('grading/run.py')
        assert is_test_or_grader_path('grader.py')
        assert is_test_or_grader_path('run-tests.sh')
        assert is_test_or_grader_path('conftest.py')
        assert is_test_or_grader_path('src/app.test.ts')
        assert not is_test_or_grader_path('src/main.py')
        assert not is_test_or_grader_path('testimony.txt')


def _ctx(tool: str, **args) -> HookContext:
    return HookContext(
        event=HookEvent.PRE_TOOL_USE, session_id='s', tool_name=tool, tool_args=args
    )


class TestIntegrityHandler:
    @pytest.mark.asyncio
    async def testDeniesSolutionRead(self) -> None:
        violations: list = []
        handler = make_integrity_handler(violations)
        result = await handler(_ctx('read_file', path='solution/answer.py'))
        assert result.action == 'deny'
        assert 'INTEGRITY' in (result.message or '')
        assert violations and violations[0]['tool'] == 'read_file'

    @pytest.mark.asyncio
    async def testDeniesTestModification(self) -> None:
        handler = make_integrity_handler()
        result = await handler(_ctx('write_file', path='tests/test_a.py', content='x'))
        assert result.action == 'deny'
        result = await handler(_ctx('edit_lines', path='grader.py'))
        assert result.action == 'deny'

    @pytest.mark.asyncio
    async def testDeniesCommandAccessToSolution(self) -> None:
        handler = make_integrity_handler()
        result = await handler(_ctx('run_command', command='cat solution/answer.py'))
        assert result.action == 'deny'

    @pytest.mark.asyncio
    async def testDeniesCommandMutationOfTests(self) -> None:
        handler = make_integrity_handler()
        result = await handler(_ctx('run_command', command='rm -rf tests/'))
        assert result.action == 'deny'
        # Reading tests is allowed (the task may require understanding them).
        result = await handler(_ctx('run_command', command='cat tests/test_a.py'))
        assert result.action == 'allow'

    @pytest.mark.asyncio
    async def testDeniesAnswerFetching(self) -> None:
        handler = make_integrity_handler()
        result = await handler(
            _ctx('web_fetch', url='https://x.com/solution/answer.md')
        )
        assert result.action == 'deny'

    @pytest.mark.asyncio
    async def testAllowsLegitimateWork(self) -> None:
        handler = make_integrity_handler()
        assert (await handler(_ctx('read_file', path='src/main.py'))).action == 'allow'
        assert (
            await handler(_ctx('write_file', path='src/fix.py', content='x'))
        ).action == 'allow'
        assert (
            await handler(_ctx('run_command', command='python -m pytest -q'))
        ).action == 'allow'

    @pytest.mark.asyncio
    async def testPatchTargetsChecked(self) -> None:
        handler = make_integrity_handler()
        patch = '*** Update File: solution/answer.py\n@@\n-old\n+new'
        result = await handler(_ctx('apply_patch', patch=patch))
        assert result.action == 'deny'


# ---------------------------------------------------------------------------
# Runner: budgets + full headless run against a stubbed workbench
# ---------------------------------------------------------------------------


class TestTurnLimitDetection:
    def testMarkers(self) -> None:
        assert _is_turn_limit_message('Tool loop exceeded maxWorkbenchToolLoops (5); stopping')
        assert _is_turn_limit_message('turn-limit reached')
        assert not _is_turn_limit_message('provider exploded')


class _StubSession:
    """Just enough session surface for the runner."""

    def __init__(self) -> None:
        self.id = 'wb_bench_stub'
        self.agent_mode = ''
        self.messages: list[dict] = []
        self.totalCost = 0.0
        self.turnCount = 1
        self.mutationCount = 0
        self.totalInputTokens = 0
        self.totalOutputTokens = 0
        self.cacheHitTokens = 0


def _stub_workbench(monkeypatch, events: list[dict], assistant_text: str = ''):
    """Point the runner at a scripted workbench loop."""
    from app.services.workbench import workbench as wb

    session = _StubSession()
    if assistant_text:
        session.messages.append({'role': 'assistant', 'content': assistant_text})

    monkeypatch.setattr(wb, 'createWorkbenchSession', lambda **kw: session)

    async def fake_stream(session_id, message, **kw):
        emit = kw.get('emit')
        signal = kw.get('signal')
        from app.services.hooks import registry as hook_registry

        for ev in events:
            if signal is not None and signal.is_set():
                break
            # Like the real loop: every tool call passes the PRE_TOOL_USE
            # hooks before it would execute.
            if ev.get('type') == 'tool_use':
                await hook_registry.emit(
                    HookEvent.PRE_TOOL_USE,
                    HookContext(
                        event=HookEvent.PRE_TOOL_USE,
                        session_id=session_id,
                        tool_name=ev.get('name'),
                        tool_args=ev.get('input') or {},
                    ),
                )
            if emit:
                emit(dict(ev))
        if kw.get('emit'):
            emit({'type': 'done', 'sessionId': session_id})

    monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fake_stream)
    return session


def _opts(tmp_path, **overrides) -> BenchOptions:
    defaults = dict(
        task='do the thing',
        workspace=str(tmp_path),
        max_turns=50,
        max_duration_s=60.0,
        trajectory_path=str(tmp_path / 'trajectory.json'),
        events_path=str(tmp_path / 'events.jsonl'),
    )
    defaults.update(overrides)
    return BenchOptions(**defaults)


def _read_jsonl(path) -> list[dict]:
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


class TestRunBench:
    @pytest.mark.asyncio
    async def testMissingTaskIsInputError(self, tmp_path, monkeypatch) -> None:
        monkeypatch.delenv('AUGUST_HEADLESS', raising=False)
        opts = _opts(tmp_path, task='  ')
        assert await run_bench(opts) == EXIT_INPUT

    @pytest.mark.asyncio
    async def testCompletedRunExitsZero(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        events = [
            {'type': 'started', 'sessionId': 's', 'model': 'm'},
            {'type': 'contextPressure', 'totalTokens': 1200, 'maxContext': 128000},
            {'type': 'tool_use', 'id': 't1', 'name': 'read_file', 'input': {'path': 'a'}},
            {'type': 'toolResult', 'id': 't1', 'name': 'read_file', 'content': 'ok'},
            {'type': 'finalOutput', 'content': 'all done'},
        ]
        _stub_workbench(monkeypatch, events, assistant_text='all done')
        code = await run_bench(_opts(tmp_path))
        assert code == EXIT_OK
        # Events file: lossless typed stream.
        stream = _read_jsonl(str(tmp_path / 'events.jsonl'))
        types = [e['type'] for e in stream]
        assert types[0] == 'run/start'
        assert 'step/tool_call' in types and 'step/tool_result' in types
        assert 'step/assistant' in types
        assert types[-1] == 'run/end'
        end = stream[-1]
        assert end['exitCode'] == 0 and end['exitName'] == 'ok'
        # Trajectory: honest steps + totals.
        with open(tmp_path / 'trajectory.json', encoding='utf-8') as f:
            traj = json.load(f)
        assert traj['exit_code'] == 0
        assert traj['final_answer'] == 'all done'
        assert traj['peak_context_tokens'] == 1200
        assert traj['steps'][0]['tool_calls'][0]['name'] == 'read_file'
        # Headless stance was set for the run.
        assert os.environ.get('AUGUST_HEADLESS') == '1'

    @pytest.mark.asyncio
    async def testTurnBudgetExhaustionExits53(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        # Three model rounds with a budget of one: the signal aborts the stream.
        events = [
            {'type': 'contextPressure', 'totalTokens': 100, 'maxContext': 1000},
            {'type': 'tool_use', 'id': 'a', 'name': 'x', 'input': {}},
            {'type': 'contextPressure', 'totalTokens': 200, 'maxContext': 1000},
            {'type': 'tool_use', 'id': 'b', 'name': 'x', 'input': {}},
            {'type': 'contextPressure', 'totalTokens': 300, 'maxContext': 1000},
        ]
        _stub_workbench(monkeypatch, events, assistant_text='still working')
        code = await run_bench(_opts(tmp_path, max_turns=1))
        assert code == EXIT_TURN_LIMIT
        end = _read_jsonl(str(tmp_path / 'events.jsonl'))[-1]
        assert end['exitCode'] == 53 and end['exitName'] == 'turn-limit'

    @pytest.mark.asyncio
    async def testLoopCapMessageExits53(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        events = [
            {'type': 'contextPressure', 'totalTokens': 100, 'maxContext': 1000},
            {
                'type': 'error',
                'message': 'Tool loop exceeded maxWorkbenchToolLoops (5); stopping',
            },
        ]
        _stub_workbench(monkeypatch, events)
        code = await run_bench(_opts(tmp_path))
        assert code == EXIT_TURN_LIMIT

    @pytest.mark.asyncio
    async def testProviderErrorExitsOne(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        events = [{'type': 'error', 'message': 'provider exploded [500]'}]
        _stub_workbench(monkeypatch, events)
        code = await run_bench(_opts(tmp_path))
        assert code == EXIT_ERROR
        end = _read_jsonl(str(tmp_path / 'events.jsonl'))[-1]
        assert end['exitCode'] == 1 and 'provider exploded' in end['exitReason']

    @pytest.mark.asyncio
    async def testOutputSchemaPassAndFail(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        schema = {'type': 'object', 'required': ['answer']}
        # Passing answer.
        events = [{'type': 'finalOutput', 'content': '{"answer": 42}'}]
        _stub_workbench(monkeypatch, events, assistant_text='{"answer": 42}')
        code = await run_bench(_opts(tmp_path, output_schema=schema))
        assert code == EXIT_OK
        with open(tmp_path / 'trajectory.json', encoding='utf-8') as f:
            assert json.load(f)['final_answer_parsed'] == {'answer': 42}
        # Failing answer downgrades a completed run to error.
        _stub_workbench(monkeypatch, events, assistant_text='no json here')
        code = await run_bench(_opts(tmp_path, output_schema=schema))
        assert code == EXIT_ERROR

    @pytest.mark.asyncio
    async def testIntegrityViolationsRecorded(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        events = [
            {'type': 'contextPressure', 'totalTokens': 10, 'maxContext': 100},
            {'type': 'tool_use', 'id': 't', 'name': 'read_file', 'input': {'path': 'solution/a.py'}},
        ]
        _stub_workbench(monkeypatch, events, assistant_text='done')
        code = await run_bench(_opts(tmp_path))
        assert code == EXIT_OK  # the run itself completes; the attempt is logged
        with open(tmp_path / 'trajectory.json', encoding='utf-8') as f:
            traj = json.load(f)
        assert len(traj['integrity_violations']) >= 1
        assert traj['integrity_violations'][0]['tool'] == 'read_file'
        # The hook is unregistered after the run.
        from app.services.hooks import registry as hook_registry

        assert not any(h.name == 'bench_integrity' for h in hook_registry._hooks)

    @pytest.mark.asyncio
    async def testTaskFileInput(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_HEADLESS', '')
        task_file = tmp_path / 'task.md'
        task_file.write_text('fix the bug', encoding='utf-8')
        events = [{'type': 'finalOutput', 'content': 'fixed'}]
        _stub_workbench(monkeypatch, events, assistant_text='fixed')
        code = await run_bench(_opts(tmp_path, task='', task_file=str(task_file)))
        assert code == EXIT_OK
        with open(tmp_path / 'trajectory.json', encoding='utf-8') as f:
            assert json.load(f)['task'] == 'fix the bug'


# ---------------------------------------------------------------------------
# CLI argument handling
# ---------------------------------------------------------------------------


class TestCli:
    def testNoTaskExits42(self) -> None:
        from app.bench.cli import main

        assert main(['--workspace', '/tmp']) == EXIT_INPUT

    def testBadSchemaFileExits42(self, tmp_path) -> None:
        from app.bench.cli import main

        assert main(['--task', 'x', '--output-schema', str(tmp_path / 'nope.json')]) == EXIT_INPUT

    def testBadMaxTurnsExits42(self) -> None:
        from app.bench.cli import main

        assert main(['--task', 'x', '--max-turns', '0']) == EXIT_INPUT

    def testParserDefaults(self) -> None:
        from app.bench.cli import build_parser

        args = build_parser().parse_args(['--task', 'x'])
        assert args.max_turns == 50
        assert args.sandbox_mode == 'workspace-write'
        assert args.events == '-'
