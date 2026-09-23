"""T1 post-edit verification loop + T14 worktree-dedup gate.

Unit tests for app/services/workbench/edit_verification.py: auto-detect
heuristics, config merge, worktree hashing, AST-context annotation, and the
bounded fix loop / dedup / disarm state machine. The loop-level wiring lives
in test_workbench_tool_loop.py (TestPostEditVerificationInLoop).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.workbench import edit_verification as ev  # noqa: E402


def _session(workspace: Path | None, turn: int = 1) -> SimpleNamespace:
    return SimpleNamespace(
        workspacePath=str(workspace) if workspace else '',
        turnCount=turn,
        guardMode='full',
        sandboxMode=None,
    )


class TestRunGateCommandPolicy:
    @pytest.mark.asyncio
    async def testGuardModeDoesNotEnableUnsandboxedExecution(self, tmp_path: Path, monkeypatch):
        from app.services.sandbox.policy import SandboxPolicy

        captured: list[SandboxPolicy] = []

        async def fake_run(command, policy, *, timeout):  # noqa: ANN001
            captured.append(policy)
            return type('Result', (), {'ok': True, 'stdout': 'ok', 'stderr': '', 'exit_code': 0, 'denial_reason': None})()

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake_run)
        session = SimpleNamespace(
            workspacePath=str(tmp_path),
            turnCount=1,
            guardMode='full',
            sandboxMode='workspace-write',
        )
        ok, text, status = await ev._run_gate_command('pytest', tmp_path, session, 180)
        assert ok is True
        assert 'ok' in text
        assert status is False
        assert len(captured) == 1
        assert captured[0].mode == 'workspace-write'
        assert captured[0].allow_unsandboxed is False
        assert captured[0].network is False

    @pytest.mark.asyncio
    async def testExplicitFullAccessRemainsOptIn(self, tmp_path: Path, monkeypatch):
        from app.services.sandbox.policy import SandboxPolicy

        captured: list[SandboxPolicy] = []

        async def fake_run(command, policy, *, timeout):  # noqa: ANN001
            captured.append(policy)
            return type('Result', (), {'ok': True, 'stdout': 'ok', 'stderr': '', 'exit_code': 0, 'denial_reason': None})()

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake_run)
        session = SimpleNamespace(
            workspacePath=str(tmp_path),
            turnCount=1,
            guardMode='full',
            sandboxMode='danger-full-access',
        )
        await ev._run_gate_command('pytest', tmp_path, session, 180)
        assert captured[0].mode == 'danger-full-access'
        assert captured[0].allow_unsandboxed is True
        assert captured[0].network is True


class TestDetectCommands:
    def testRuffFromPyproject(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.ruff]\nline-length = 100\n')
        cmds = ev.detect_commands(tmp_path)
        assert cmds['lintCmd'] == 'ruff check {file}'

    def testRuffFromTomlFile(self, tmp_path: Path) -> None:
        (tmp_path / 'ruff.toml').write_text('line-length = 100\n')
        assert ev.detect_commands(tmp_path)['lintCmd'] == 'ruff check {file}'

    def testEslintConfig(self, tmp_path: Path) -> None:
        (tmp_path / 'eslint.config.mjs').write_text('export default [];\n')
        cmds = ev.detect_commands(tmp_path)
        assert 'eslint' in cmds['lintCmd']

    def testRuffWinsOverEslint(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.ruff]\n')
        (tmp_path / 'eslint.config.js').write_text('module.exports = [];')
        assert ev.detect_commands(tmp_path)['lintCmd'].startswith('ruff')

    def testPytestFromPyproject(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.pytest.ini_options]\naddopts = "-q"\n')
        assert ev.detect_commands(tmp_path)['testCmd'] == 'python -m pytest -q -x {file}'

    def testPytestIni(self, tmp_path: Path) -> None:
        (tmp_path / 'pytest.ini').write_text('[pytest]\n')
        assert ev.detect_commands(tmp_path)['testCmd'] == 'python -m pytest -q -x {file}'

    def testNpmTestRealScript(self, tmp_path: Path) -> None:
        (tmp_path / 'package.json').write_text(
            json.dumps({'scripts': {'test': 'vitest run'}})
        )
        assert ev.detect_commands(tmp_path)['testCmd'] == 'npm test --silent'

    def testNpmDefaultPlaceholderIgnored(self, tmp_path: Path) -> None:
        (tmp_path / 'package.json').write_text(
            json.dumps({'scripts': {'test': 'echo "Error: no test specified" && exit 1'}})
        )
        assert 'testCmd' not in ev.detect_commands(tmp_path)

    def testEmptyWorkspace(self, tmp_path: Path) -> None:
        assert ev.detect_commands(tmp_path) == {}


class TestLoadVerifyConfig:
    def testFallsBackToDetection(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.ruff]\n[tool.pytest.ini_options]\n')
        cfg = ev.load_verify_config(tmp_path)
        assert cfg['enabled'] is True
        assert cfg['lintCmd'] == 'ruff check {file}'
        assert cfg['testCmd'] == 'python -m pytest -q -x {file}'
        assert cfg['maxFixIterations'] == ev.DEFAULT_MAX_FIX_ITERATIONS

    def testConfigFileOverrides(self, tmp_path: Path) -> None:
        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(
            json.dumps(
                {
                    'lintCmd': 'my-lint {file}',
                    'testCmd': 'my-test',
                    'maxFixIterations': 5,
                }
            )
        )
        cfg = ev.load_verify_config(tmp_path)
        assert cfg['lintCmd'] == 'my-lint {file}'
        assert cfg['testCmd'] == 'my-test'
        assert cfg['maxFixIterations'] == 5

    def testDisabledFlag(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.ruff]\n')
        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(json.dumps({'enabled': False}))
        assert ev.load_verify_config(tmp_path)['enabled'] is False

    def testInvalidJsonFallsBack(self, tmp_path: Path) -> None:
        (tmp_path / 'pyproject.toml').write_text('[tool.ruff]\n')
        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text('{not json')
        cfg = ev.load_verify_config(tmp_path)
        assert cfg['enabled'] is True
        assert cfg['lintCmd'] == 'ruff check {file}'

    def testNoCommandsMeansDisabled(self, tmp_path: Path) -> None:
        assert ev.load_verify_config(tmp_path)['enabled'] is False


class TestWorktreeHash:
    def _git(self, cwd: Path, *args: str) -> None:
        subprocess.run(
            ['git', *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
            env={
                'GIT_AUTHOR_NAME': 't',
                'GIT_AUTHOR_EMAIL': 't@t',
                'GIT_COMMITTER_NAME': 't',
                'GIT_COMMITTER_EMAIL': 't@t',
                'PATH': __import__('os').environ.get('PATH', ''),
                'HOME': __import__('os').environ.get('HOME', ''),
            },
        )

    @pytest.mark.asyncio
    async def testNonGitDirReturnsNone(self, tmp_path: Path) -> None:
        assert await ev.worktree_hash(tmp_path) is None

    @pytest.mark.asyncio
    async def testStableAndContentSensitive(self, tmp_path: Path) -> None:
        (tmp_path / 'a.py').write_text('x = 1\n')
        self._git(tmp_path, 'init', '-q')
        self._git(tmp_path, 'add', '.')
        self._git(tmp_path, 'commit', '-qm', 'init')
        h1 = await ev.worktree_hash(tmp_path)
        h2 = await ev.worktree_hash(tmp_path)
        assert h1 is not None
        assert h1 == h2
        (tmp_path / 'a.py').write_text('x = 2\n')
        h3 = await ev.worktree_hash(tmp_path)
        assert h3 is not None and h3 != h1


class TestContainingFunctionContext:
    def testFindsEnclosingDef(self, tmp_path: Path) -> None:
        src = 'def outer():\n    a = 1\n\n    def inner(items):\n        total = 0\n        for i in items:\n            total += i.price / 0\n        return total\n'
        f = tmp_path / 'mod.py'
        f.write_text(src)
        block = ev.containing_function_context(f, 7)
        assert 'def inner(items):' in block
        assert 'mod.py:7' in block
        assert 'total += i.price / 0' in block

    def testClassSignature(self, tmp_path: Path) -> None:
        f = tmp_path / 'c.py'
        f.write_text('class Thing:\n    x = 1\n')
        assert 'class Thing:' in ev.containing_function_context(f, 2)

    def testNoSignatureReturnsEmpty(self, tmp_path: Path) -> None:
        f = tmp_path / 'top.py'
        f.write_text('x = 1\ny = 2\n')
        assert ev.containing_function_context(f, 2) == ''

    def testMissingFileOrBadLine(self, tmp_path: Path) -> None:
        assert ev.containing_function_context(tmp_path / 'nope.py', 3) == ''
        f = tmp_path / 'ok.py'
        f.write_text('def f():\n    pass\n')
        assert ev.containing_function_context(f, 99) == ''
        assert ev.containing_function_context(f, 0) == ''


class TestAnnotateErrorsWithContext:
    def _src(self, tmp_path: Path) -> None:
        (tmp_path / 'calc.py').write_text(
            'def calculate_total(items):\n    total = 0\n    for i in items:\n        total += i.price / 0\n    return total\n'
        )

    def testRuffStyleDiagnostic(self, tmp_path: Path) -> None:
        self._src(tmp_path)
        out = 'calc.py:4:20: F841 local variable assigned but never used'
        annotated = ev.annotate_errors_with_context(tmp_path, out)
        assert '--- error context' in annotated
        assert 'def calculate_total(items):' in annotated

    def testPytestTracebackStyle(self, tmp_path: Path) -> None:
        self._src(tmp_path)
        out = 'Traceback (most recent call last):\n  File "calc.py", line 4, in calculate_total\n    ZeroDivisionError'
        annotated = ev.annotate_errors_with_context(tmp_path, out)
        assert 'def calculate_total(items):' in annotated

    def testNoDiagnosticsUnchanged(self, tmp_path: Path) -> None:
        out = 'some random output\nwithout diagnostics'
        assert ev.annotate_errors_with_context(tmp_path, out) == out

    def testCapsSiteCount(self, tmp_path: Path) -> None:
        (tmp_path / 'many.py').write_text('def f():\n' + '    x = 1\n' * 20)
        out = '\n'.join(f'many.py:{i}:1: E501 boom' for i in range(2, 20))
        annotated = ev.annotate_errors_with_context(tmp_path, out)
        assert annotated.count('many.py:') <= ev._MAX_CONTEXT_SITES + out.count('many.py:')


class TestCapOutput:
    def testSmallUnchanged(self) -> None:
        assert ev._cap_output('small') == 'small'

    def testLargeCapped(self) -> None:
        text = 'a' * 20000
        capped = ev._cap_output(text)
        assert 'characters omitted' in capped
        assert len(capped) < len(text)
        assert capped.startswith('aaaa')
        assert capped.endswith('aaaa')


class TestVerifyAfterEdit:
    """State machine: pass/fail receipts, bounded fix loop, T14 dedup,
    disarm + re-arm. Gate execution and git hashing are faked."""

    @pytest.fixture
    def workspace(self, tmp_path: Path) -> Path:
        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(
            json.dumps({'lintCmd': 'mylint {file}', 'testCmd': 'mytest'})
        )
        (tmp_path / 'foo.py').write_text('x = 1\n')
        return tmp_path

    @pytest.fixture
    def calls(self, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, float]]:
        class _Calls(list):
            script: dict[str, object]

        recorded = _Calls()
        script: dict[str, object] = {'results': []}  # popped FIFO; default (True, 'ok')

        async def fake_run(command: str, workspace: Path, session: object, timeout: float):
            recorded.append((command, timeout))
            results = script['results']
            assert isinstance(results, list)
            if results:
                r = results.pop(0)
                # Scripts may use 2-tuples (ok, text); the real runner now
                # returns (ok, text, timed_out). Normalize.
                return (r[0], r[1], False) if len(r) == 2 else r
            return True, 'All checks passed.', False

        async def fake_hash(workspace: Path) -> str | None:
            h = script.get('hash')
            return h if isinstance(h, str) else None

        recorded.script = script
        monkeypatch.setattr(ev, '_run_gate_command', fake_run)
        monkeypatch.setattr(ev, 'worktree_hash', fake_hash)
        return recorded

    def _script(self, calls: object) -> dict[str, object]:
        return calls.script  # type: ignore[attr-defined]

    @pytest.mark.asyncio
    async def testPassReceiptResetsState(self, workspace: Path, calls: object) -> None:
        s = _session(workspace)
        receipt = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert receipt == '[verification passed] lint + tests clean — cwd=., workspace .aug/verify.json.'
        assert s._verify_state['failStreak'] == 0

    @pytest.mark.asyncio
    async def testFilePlaceholderScoped(self, workspace: Path, calls: object) -> None:
        s = _session(workspace)
        await ev.verify_after_edit(s, 'edit_lines', {'path': str(workspace / 'foo.py')})
        commands = [c for c, _ in calls]  # type: ignore[attr-defined]
        assert commands[0] == 'mylint foo.py'
        assert commands[1] == 'mytest'

    @pytest.mark.asyncio
    async def testTestCmdFileScoping(self, workspace: Path, calls: object) -> None:
        # testCmd supports {file} too, so a workspace can gate on targeted
        # tests instead of a full suite.
        (workspace / '.aug' / 'verify.json').write_text(
            json.dumps({'testCmd': 'mytest {file}'})
        )
        s = _session(workspace)
        receipt = await ev.verify_after_edit(s, 'edit_lines', {'path': 'foo.py'})
        commands = [c for c, _ in calls]  # type: ignore[attr-defined]
        assert commands == ['mytest foo.py']
        assert receipt == '[verification passed] tests clean — cwd=., workspace .aug/verify.json.'

    @pytest.mark.asyncio
    async def testGateTimeoutIsInconclusiveAndPausesTests(
        self, workspace: Path, calls: object
    ) -> None:
        # The dogfood bug: `npm test` = full monorepo suite → killed at the
        # timeout → used to feed a FAILED receipt and a fix loop that re-paid
        # the timeout on every edit. Now: inconclusive, no failStreak, and the
        # test gate pauses for the session (lint keeps running).
        self._script(calls)['results'] = [
            (True, 'lint ok', False),
            (False, 'Error: Command timed out after 180s and was killed.', True),
        ]
        s = _session(workspace)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r1.startswith('[verification inconclusive]')
        assert 'NOT a code failure' in r1
        assert 'PAUSED for the rest of this turn' in r1
        assert 'for this session' not in r1
        assert s._verify_state['failStreak'] == 0
        assert s._verify_state['testPaused'] is True
        # Second edit: lint runs, tests are skipped entirely.
        r2 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r2 == '[verification passed] lint clean — cwd=., workspace .aug/verify.json (tests paused after an earlier timeout).'
        commands = [c for c, _ in calls]  # type: ignore[attr-defined]
        assert commands == ['mylint foo.py', 'mytest', 'mylint foo.py']

    @pytest.mark.asyncio
    async def testLintTimeoutInconclusiveWithoutPause(self, workspace: Path, calls: object) -> None:
        # A lint timeout is inconclusive too, but it does NOT pause the test
        # gate (lint is file-scoped and cheap; the suite is the heavy one).
        self._script(calls)['results'] = [
            (False, 'Error: Command timed out after 60s and was killed.', True),
        ]
        s = _session(workspace)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r1.startswith('[verification inconclusive]')
        assert s._verify_state.get('testPaused') is not True
        assert len(calls) == 1  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def testLintFailureSkipsTests(self, workspace: Path, calls: object) -> None:
        self._script(calls)['results'] = [(False, 'foo.py:1:1: E999 syntax error')]
        s = _session(workspace)
        receipt = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert receipt.startswith('[verification FAILED — lint: mylint foo.py]')
        assert 'Fix iteration 1/3' in receipt
        assert 'edit the file' in receipt
        assert len(calls) == 1  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def testFailureCarriesAstContext(self, workspace: Path, calls: object) -> None:
        (workspace / 'calc.py').write_text('def calculate_total(items):\n    return 1 / 0\n')
        self._script(calls)['results'] = [(False, 'calc.py:2:12: B012 division by zero')]
        s = _session(workspace)
        receipt = await ev.verify_after_edit(s, 'write_file', {'path': 'calc.py'})
        assert 'def calculate_total(items):' in receipt

    @pytest.mark.asyncio
    async def testFixLoopEscalatesAndDisarms(self, workspace: Path, calls: object) -> None:
        # Each failed edit consumes one scripted result (lint fails → tests skipped).
        self._script(calls)['results'] = [
            (False, 'err 1'),
            (False, 'err 2'),
            (False, 'err 3'),
            (True, 'ok'),  # the re-armed gate on the next turn passes
        ]
        self._script(calls)['hash'] = None  # dedup off
        s = _session(workspace, turn=5)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert 'Fix iteration 1/3' in r1
        r2 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert 'Fix iteration 2/3' in r2
        r3 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert 'Fix iteration 3/3' in r3
        assert 'fix budget exhausted' in r3
        # Gate disarmed for the rest of the turn — no command runs.
        before = len(calls)  # type: ignore[arg-type]
        r4 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r4.startswith('[verification paused]')
        assert len(calls) == before  # type: ignore[arg-type]
        # Re-arms on the next user turn.
        s.turnCount = 6
        r5 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r5 == '[verification passed] lint + tests clean — cwd=., workspace .aug/verify.json.'

    @pytest.mark.asyncio
    async def testT14SkipsUnchangedWorktree(self, workspace: Path, calls: object) -> None:
        self._script(calls)['results'] = [(False, 'boom')]
        self._script(calls)['hash'] = 'hash-A'
        s = _session(workspace)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r1.startswith('[verification FAILED')
        # Same hash → skipped, attempt counted, no gate command runs.
        before = len(calls)  # type: ignore[arg-type]
        r2 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r2.startswith('[verification skipped]')
        assert 'edit something before retrying' in r2
        assert '(attempt 1)' in r2
        assert len(calls) == before  # type: ignore[arg-type]
        r3 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert '(attempt 2)' in r3
        # Worktree changed → gate runs again.
        self._script(calls)['hash'] = 'hash-B'
        self._script(calls)['results'] = [(True, 'ok')]
        r4 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r4 == '[verification passed] lint + tests clean — cwd=., workspace .aug/verify.json.'

    @pytest.mark.asyncio
    async def testNotAnEditTool(self, workspace: Path, calls: object) -> None:
        assert await ev.verify_after_edit(_session(workspace), 'read_file', {'path': 'foo.py'}) == ''

    @pytest.mark.asyncio
    async def testNoCommandsDetected(self, tmp_path: Path, calls: object) -> None:
        assert await ev.verify_after_edit(_session(tmp_path), 'write_file', {'path': 'a.py'}) == ''

    def testBulkEditRelpathsRejectAmbiguousTargets(self, workspace: Path) -> None:
        assert ev._bulk_edit_relpaths(
            'bulk',
            {'operation': 'write_files', 'files': [{'path': 'foo.py'}, {'path': 'foo.py'}]},
            workspace,
        ) is None
        assert ev._bulk_edit_relpaths(
            'bulk',
            {'operation': 'write_files', 'files': [{'path': '../outside.py'}]},
            workspace,
        ) is None
        assert ev._bulk_edit_relpaths(
            'bulk',
            {'operation': 'write_files', 'files': [{'path': 'foo.py'}, {'path': ''}]},
            workspace,
        ) is None

    @pytest.mark.asyncio
    async def testBulkEditDoesNotClaimPassWithoutGateForEveryTarget(
        self, workspace: Path, calls: object
    ) -> None:
        (workspace / 'sub').mkdir()
        (workspace / 'sub' / 'package.json').write_text('{}')
        (workspace / 'sub' / '.aug').mkdir()
        (workspace / 'sub' / '.aug' / 'verify.json').write_text(json.dumps({'enabled': False}))
        self._script(calls)['results'] = [(True, 'ok', False)]
        s = _session(workspace)
        receipt = await ev.verify_after_edit(
            s,
            'bulk',
            {
                'operation': 'write_files',
                'files': [{'path': 'foo.py'}, {'path': 'sub/other.py'}],
            },
        )
        assert receipt.startswith('[verification blocked]')
        assert 'no enabled lint/test gate' in receipt

    @pytest.mark.asyncio
    async def testBulkEditUsesEnabledPackageGateWhenRootIsDisabled(
        self, workspace: Path, calls: object
    ) -> None:
        (workspace / '.aug' / 'verify.json').write_text(json.dumps({'enabled': False}))
        package = workspace / 'sub'
        package.mkdir()
        (package / 'package.json').write_text('{}')
        (package / '.aug').mkdir()
        (package / '.aug' / 'verify.json').write_text(
            json.dumps(
                {
                    'enabled': True,
                    'lintCmd': 'package-lint {file}',
                    'testCmd': 'package-test {file}',
                }
            )
        )
        self._script(calls)['results'] = [
            (True, 'package lint ok', False),
            (True, 'package tests ok', False),
        ]
        s = _session(workspace)
        receipt = await ev.verify_after_edit(
            s,
            'bulk',
            {'operation': 'write_files', 'files': [{'path': 'sub/other.py'}]},
        )
        assert receipt == (
            '[verification passed] bulk edit verification clean — '
            '1 target(s): sub/other.py.'
        )
        assert [command for command, _ in calls] == [  # type: ignore[attr-defined]
            'cd sub && package-lint other.py',
            'cd sub && package-test other.py',
        ]

    @pytest.mark.asyncio
    async def testDisabledGate(self, tmp_path: Path, calls: object) -> None:
        (tmp_path / '.aug').mkdir()
        (tmp_path / '.aug' / 'verify.json').write_text(
            json.dumps({'enabled': False, 'lintCmd': 'mylint'})
        )
        assert await ev.verify_after_edit(_session(tmp_path), 'write_file', {'path': 'a.py'}) == ''

    @pytest.mark.asyncio
    async def testTestPauseResetsOnNewTurn(self, workspace: Path, calls: object) -> None:
        # After a test-timeout the gate stays paused for the rest of the
        # turn. The next user turn must clear the pause and run the suite
        # again — otherwise a single slow suite would permanently break the
        # post-edit gate.
        self._script(calls)['results'] = [
            (True, 'lint ok', False),
            (False, 'Error: Command timed out after 180s and was killed.', True),
            (True, 'lint ok', False),
            (True, 'tests ok', False),
        ]
        s = _session(workspace, turn=1)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r1.startswith('[verification inconclusive]')
        assert s._verify_state['testPaused'] is True
        s.turnCount = 2
        r2 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert 'tests paused' not in r2
        assert s._verify_state['testPaused'] is False
        commands = [c for c, _ in calls]  # type: ignore[attr-defined]
        assert commands == ['mylint foo.py', 'mytest', 'mylint foo.py', 'mytest']

    @pytest.mark.asyncio
    async def testNoTestsCollectedIsInconclusive(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # pytest exit code 5 (no tests collected) must NOT register as a code
        # failure — it is a distinct "no-tests" status, not a timeout and not
        # a failure, so the receipt says nothing was verified without pausing
        # the test gate for the session.
        from app.services.execution_world import run_sandboxed as real_run
        from app.services.sandbox.policy import SandboxResult

        result = SandboxResult(ok=False, exit_code=5, stderr='', stdout='no tests ran')

        async def fake(command, policy, *, timeout=300.0):  # noqa: ANN001
            return result

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake)
        try:
            ok, text, status = await ev._run_gate_command('pytest', tmp_path, None, 180)
            assert ok is False
            assert status == 'no-tests'
            assert 'no tests ran' in text
        finally:
            # Defensive restore so other tests in this file aren't affected.
            monkeypatch.setattr('app.services.execution_world.run_sandboxed', real_run)

    @pytest.mark.asyncio
    async def testNoTestsCollectedOnStderrIsNoTests(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # Detection checks BOTH streams: `collected 0 items` on stderr (pytest
        # writes its summary to stderr) must map to the no-tests status too.
        from app.services.execution_world import run_sandboxed as real_run
        from app.services.sandbox.policy import SandboxResult

        result = SandboxResult(ok=False, exit_code=5, stderr='collected 0 items', stdout='')

        async def fake(command, policy, *, timeout=300.0):  # noqa: ANN001
            return result

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake)
        try:
            ok, _, status = await ev._run_gate_command('pytest', tmp_path, None, 180)
            assert ok is False
            assert status == 'no-tests'
        finally:
            monkeypatch.setattr('app.services.execution_world.run_sandboxed', real_run)

    @pytest.mark.asyncio
    @pytest.mark.parametrize('exit_code, output', [(1, 'no tests ran'), (5, 'collected 3 items')])
    async def testCollectionTextDoesNotHideFailures(self, tmp_path, monkeypatch, exit_code, output):
        from app.services.sandbox.policy import SandboxResult

        async def fake(command, policy, *, timeout):
            return SandboxResult(ok=False, exit_code=exit_code, stdout=output)

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake)
        ok, _, status = await ev._run_gate_command('pytest', tmp_path, None, 180)
        assert ok is False
        assert status is False

    @pytest.mark.asyncio
    async def testTimeoutStaysDistinctFromNoTests(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.services.execution_world import run_sandboxed as real_run
        from app.services.sandbox.policy import SandboxResult

        result = SandboxResult(
            ok=False, exit_code=-1, stderr='Error: Command timed out after 180s and was killed.'
        )

        async def fake(command, policy, *, timeout=300.0):  # noqa: ANN001
            return result

        monkeypatch.setattr('app.services.execution_world.run_sandboxed', fake)
        try:
            _, _, status = await ev._run_gate_command('pytest', tmp_path, None, 180)
            assert status is True  # timeout keeps the legacy truthy slot
        finally:
            monkeypatch.setattr('app.services.execution_world.run_sandboxed', real_run)

    @pytest.mark.asyncio
    async def testNoTestsReceiptDoesNotPauseTests(self, workspace: Path, calls: object) -> None:
        self._script(calls)['results'] = [
            (True, 'lint ok', False),
            (False, 'no tests ran', 'no-tests'),
        ]
        s = _session(workspace)
        r1 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert r1.startswith('[verification inconclusive]')
        assert 'No tests collected' in r1
        assert 'timed out' not in r1 and 'killed' not in r1
        assert 'no tests verified it' in r1
        assert s._verify_state['testPaused'] is False
        assert s._verify_state['failStreak'] == 0
        r2 = await ev.verify_after_edit(s, 'write_file', {'path': 'foo.py'})
        assert '[verification passed]' in r2
        assert [command for command, _ in calls] == [
            'mylint foo.py', 'mytest', 'mylint foo.py', 'mytest',
        ]
