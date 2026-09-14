"""Regression tests for the 2026-09-15 harness friction audit.

One test class per finding in docs/HARNESS-FINDINGS-2026-09-15.md, so a
regression points straight at the friction the user actually hit. The
tool-loop findings (#3 continuation, #8 turn_end) live in
test_workbench_tool_loop.py, which has the stub-provider harness.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(
    os.name != 'nt',
    reason='the audit reproductions are Windows-shaped (drive paths, /c: switches)',
)


# ---------------------------------------------------------------- finding 1
class TestSoftPreflightSegmentScoping:
    """#1 — the token scan read every word of every command as a path."""

    def _preflight(self, command: str, workspace: str) -> str | None:
        from app.services.sandbox.backends.fallback import soft_preflight
        from app.services.sandbox.policy import SandboxPolicy

        return soft_preflight(command, SandboxPolicy(mode='workspace-write', workspace_root=workspace))

    def testEchoWithPathLikeTextPasses(self, tmp_path):
        assert self._preflight('echo before c:/d after', str(tmp_path)) is None

    def testFindstrSwitchWithValuePasses(self, tmp_path):
        # `/c:"ToolSearch"` is a findstr switch, not the path `/c:`.
        assert self._preflight('findstr /c:"ToolSearch" app.py', str(tmp_path)) is None

    def testViewerExemptionSurvivesChaining(self, tmp_path, monkeypatch):
        logs = tmp_path / 'appdata' / 'logs'
        logs.mkdir(parents=True)
        monkeypatch.setattr('app.services.sandbox.paths.app_logs_root', lambda: logs)
        command = f'cd /d {tmp_path} && dir "{logs / "backend.log"}"'
        assert self._preflight(command, str(tmp_path)) is None

    def testViewerExemptionIsPerSegmentNotGlobal(self, tmp_path, monkeypatch):
        # The exemption follows the segment head: a viewer segment may not
        # lend it to reading something outside the workspace entirely.
        logs = tmp_path / 'appdata' / 'logs'
        logs.mkdir(parents=True)
        monkeypatch.setattr('app.services.sandbox.paths.app_logs_root', lambda: logs)
        outside = tmp_path.parent / 'elsewhere'
        command = f'dir "{logs}" && type "{outside / "x.txt"}"'
        denial = self._preflight(command, str(tmp_path))
        assert denial is not None and 'elsewhere' in denial

    def testTextEmitterWithCommandSubstitutionStillBlocked(self, tmp_path):
        outside = tmp_path.parent / 'outside-target.txt'
        assert self._preflight(f'echo $(type {outside})', str(tmp_path)) is not None

    def testTextEmitterExemptionDoesNotCoverInputRedirects(self, tmp_path):
        # `printf %s C:\x\f` is prose, but `printf %s < C:\x\f` reads the file.
        outside = tmp_path.parent / 'secret'
        assert self._preflight(f'printf %s {outside}', str(tmp_path)) is None
        assert self._preflight(f'printf %s < {outside}', str(tmp_path)) is not None

    def testRedirectOutsideStillBlocked(self, tmp_path):
        denial = self._preflight(f'echo x > {tmp_path.parent / "evil.txt"}', str(tmp_path))
        assert denial is not None and 'redirect' in denial

    def testNetworkSegmentScanIsQuoteAware(self, tmp_path):
        assert self._preflight('echo "a && curl http://example.com"', str(tmp_path)) is None
        assert self._preflight('echo hi && curl http://example.com', str(tmp_path)) is not None

    def testDenialNamesTokenAndRejectsFullAccessFraming(self, tmp_path):
        outside = tmp_path.parent / 'secret'
        denial = self._preflight(f'type {outside / "a.txt"}', str(tmp_path))
        assert denial is not None
        assert str(outside) in denial
        assert 'not a permissions' in denial

    def testDenialTailDoesNotPushFullAccess(self, tmp_path):
        from app.services.tool_registrations.file_tools import _denial_tail

        tail = _denial_tail('path outside workspace blocked: C:\\x')
        assert 'Point it inside the workspace' in tail
        assert 'network: true' in _denial_tail('network disabled in sandbox (blocked: curl)')


# ---------------------------------------------------------------- finding 2
class TestGateResolvesPackageRoot:
    """#2 — the gate ran the monorepo root suite for a backend-only edit."""

    def _monorepo(self, tmp_path: Path) -> Path:
        (tmp_path / 'package.json').write_text(
            json.dumps({'name': 'root', 'scripts': {'test': 'npm run test:verify'}}), encoding='utf-8'
        )
        backend = tmp_path / 'backend-py'
        backend.mkdir()
        (backend / 'pyproject.toml').write_text('[tool.pytest.ini_options]\n', encoding='utf-8')
        (backend / 'uv.lock').write_text('', encoding='utf-8')
        (backend / 'ruff.toml').write_text('', encoding='utf-8')
        nested = backend / 'app' / 'services'
        nested.mkdir(parents=True)
        (nested / 'paths.py').write_text('x = 1\n', encoding='utf-8')
        return tmp_path

    def testPackageRootFor(self, tmp_path):
        from app.services.workbench.edit_verification import package_root_for

        root = self._monorepo(tmp_path)
        assert package_root_for(root, 'backend-py/app/services/paths.py').name == 'backend-py'
        assert package_root_for(root, 'README.md') == root
        assert package_root_for(root, 'backend-py\\app\\x.py').name == 'backend-py'

    def testCommandsAreFileScopedAndUvAware(self, tmp_path):
        from app.services.workbench.edit_verification import detect_commands

        root = self._monorepo(tmp_path)
        cmds = detect_commands(root / 'backend-py')
        assert cmds['testCmd'] == 'uv run pytest -q -x {file}'
        assert cmds['lintCmd'] == 'ruff check {file}'

    def testAggregatorRootIsNotASuite(self, tmp_path):
        from app.services.workbench.edit_verification import detect_commands

        root = self._monorepo(tmp_path)
        assert 'testCmd' not in detect_commands(root)

    def testConfigLayeringPrefersPackage(self, tmp_path):
        from app.services.workbench.edit_verification import load_verify_config

        root = self._monorepo(tmp_path)
        (root / '.aug').mkdir()
        (root / '.aug' / 'verify.json').write_text(json.dumps({'testCmd': 'workspace-cmd {file}'}), 'utf-8')
        (root / 'backend-py' / '.aug').mkdir()
        (root / 'backend-py' / '.aug' / 'verify.json').write_text(
            json.dumps({'testCmd': 'package-cmd {file}'}), 'utf-8'
        )
        cfg = load_verify_config(root, 'backend-py/app/services/paths.py')
        assert cfg['testCmd'] == 'package-cmd {file}'
        assert Path(str(cfg['cwd'])).name == 'backend-py'
        assert 'package' in str(cfg['source'])

    async def testBackendEditRunsBackendSuiteNotRootNpm(self, tmp_path, monkeypatch):
        from app.services.workbench import edit_verification as ev

        root = self._monorepo(tmp_path)
        ran: list[str] = []

        async def fakeRun(command, workspace, session, timeout):  # noqa: ANN001
            ran.append(command)
            return True, 'ok', False

        monkeypatch.setattr(ev, '_run_gate_command', fakeRun)
        session = SimpleNamespace(workspacePath=str(root), guardMode='full', sandboxMode=None, turnCount=1)
        receipt = await ev.verify_after_edit(
            session, 'edit_lines', {'path': 'backend-py/app/services/paths.py'}
        )
        assert ran == ['cd backend-py && ruff check app/services/paths.py',
                       'cd backend-py && uv run pytest -q -x app/services/paths.py'], ran
        assert 'verification passed' in receipt
        assert 'cwd=backend-py' in receipt

    async def testRootDocEditDoesNotTriggerMonorepoSuite(self, tmp_path, monkeypatch):
        from app.services.workbench import edit_verification as ev

        root = self._monorepo(tmp_path)
        ran: list[str] = []

        async def fakeRun(command, workspace, session, timeout):  # noqa: ANN001
            ran.append(command)
            return True, 'ok', False

        monkeypatch.setattr(ev, '_run_gate_command', fakeRun)
        session = SimpleNamespace(workspacePath=str(root), guardMode='full', sandboxMode=None, turnCount=1)
        assert await ev.verify_after_edit(session, 'edit_lines', {'path': 'README.md'}) == ''
        assert ran == []


# ---------------------------------------------------------------- finding 4
class TestNetworkFailureHint:
    """#4 — a sandboxed `git push` surfaced as an opaque CONNECT 403."""

    def _result(self, **kw: object):
        from app.services.sandbox.policy import SandboxResult

        base: dict[str, object] = {'ok': False, 'exit_code': 128}
        base.update(kw)
        return SandboxResult(**base)  # type: ignore[arg-type]

    def testGitConnectFailureGetsFlagHint(self):
        from app.services.tool_registrations.file_tools import _network_hint

        result = self._result(
            stderr="fatal: unable to access 'https://github.com/x/y/': CONNECT tunnel failed, response 403"
        )
        hint = _network_hint(result, network_on=False)
        assert 'network: true' in hint
        assert 'not a credential problem' in hint

    def testNoHintWhenNetworkAlreadyOn(self):
        from app.services.tool_registrations.file_tools import _network_hint

        result = self._result(stderr='CONNECT tunnel failed, response 403')
        assert _network_hint(result, network_on=True) == ''

    def testNoHintOnUnrelatedFailure(self):
        from app.services.tool_registrations.file_tools import _network_hint

        assert _network_hint(self._result(stderr='fatal: not a git repository'), False) == ''

    def testGenericUnableToAccessIsNotCalledNetwork(self):
        # git says "unable to access" for local problems too; guessing wrong
        # costs the model a wasted round, so the hint stays transport-specific.
        from app.services.tool_registrations.file_tools import _network_hint

        result = self._result(stderr="fatal: unable to access: 'config' file not found")
        assert _network_hint(result, network_on=False) == ''

    def testNoHintOnSuccess(self):
        from app.services.tool_registrations.file_tools import _network_hint

        assert _network_hint(self._result(ok=True, exit_code=0, stderr=''), False) == ''


# ---------------------------------------------------------------- finding 5
class TestCodeMapNoise:
    """#5 — caches, binaries and lockfiles crowded real source out of the map."""

    def _workspace(self, tmp_path: Path) -> Path:
        (tmp_path / '.gitignore').write_text('web-dist/\ndata/\nnode_modules/\n', encoding='utf-8')
        (tmp_path / 'web-dist').mkdir()
        (tmp_path / 'data').mkdir()
        (tmp_path / '.mypy_cache').mkdir()
        (tmp_path / 'src').mkdir()
        (tmp_path / 'src' / 'main.py').write_text('def main() -> int:\n    return 0\n', encoding='utf-8')
        (tmp_path / 'brain.db').write_bytes(b'SQLite format 3\x00' + b'\x00' * 5000)
        (tmp_path / 'package-lock.json').write_text('{"lockfileVersion": 3}' + ' ' * 9000, encoding='utf-8')
        return tmp_path

    def testGitignoredAndCacheDirsAreSkipped(self, tmp_path):
        from app.services.workbench.code_map import build_code_map

        block = build_code_map(str(self._workspace(tmp_path)))
        assert 'web-dist' not in block
        assert '.mypy_cache' not in block
        assert 'data/' not in block
        assert 'src/main.py' in block.replace('\\', '/')

    def testBinaryNeverReachesSignatures(self, tmp_path):
        from app.services.workbench.code_map import _is_binary, build_code_map

        workspace = self._workspace(tmp_path)
        assert _is_binary(workspace / 'brain.db') is True
        block = build_code_map(str(workspace))
        assert 'SQLite format' not in block
        assert 'brain.db' not in block

    def testSignaturesAreSourceNotLockfiles(self, tmp_path):
        from app.services.workbench.code_map import build_code_map

        block = build_code_map(str(self._workspace(tmp_path)))
        assert 'package-lock.json:' not in block
        assert 'src/main.py: def main' in block.replace('\\', '/')

    def testBigTestDirDoesNotCrowdOutSource(self, tmp_path):
        from app.services.workbench.code_map import build_code_map

        workspace = self._workspace(tmp_path)
        tests = workspace / 'tests'
        tests.mkdir()
        for i in range(60):
            (tests / f'test_{i:03d}.py').write_text(f'"""Docstring {i}."""\n', encoding='utf-8')
        block = build_code_map(str(workspace))
        assert 'more' in block  # the per-directory cap fired
        assert 'src/main.py' in block.replace('\\', '/')
        assert 'Docstring' not in block  # test docstrings never headline the map

    def testDotDirsHiddenButGithubKept(self, tmp_path):
        from app.services.workbench.code_map import build_code_map

        workspace = self._workspace(tmp_path)
        (workspace / '.zcode').mkdir()
        (workspace / '.zcode' / 'plan.md').write_text('# plan', encoding='utf-8')
        (workspace / '.github' / 'workflows').mkdir(parents=True)
        (workspace / '.github' / 'workflows' / 'ci.yml').write_text('name: ci\n', encoding='utf-8')
        block = build_code_map(str(workspace))
        assert '.zcode' not in block
        assert '.github' in block


# ---------------------------------------------------------------- finding 7
class TestRuntimeBuildInfo:
    """#7 — nothing on the running side identified its own source."""

    def testVersionReadsCheckoutPackageJson(self, tmp_path, monkeypatch):
        import app.version as version_mod

        monkeypatch.setattr(version_mod, '_VERSION_CACHE', None)
        monkeypatch.setattr(version_mod, '_PKG_ROOT', tmp_path / 'backend-py')
        (tmp_path / 'backend-py').mkdir()
        (tmp_path / 'package.json').write_text(json.dumps({'version': '0.18.10'}), encoding='utf-8')
        assert version_mod.backend_version() == '0.18.10'

    def testStagedManifestWinsOverFallback(self, tmp_path, monkeypatch):
        import app.version as version_mod

        monkeypatch.setattr(version_mod, '_VERSION_CACHE', None)
        monkeypatch.setattr(version_mod, '_PKG_ROOT', tmp_path / 'backend-py')
        (tmp_path / 'backend-py').mkdir()
        (tmp_path / 'backend-runtime.json').write_text(json.dumps({'appVersion': '0.19.1'}), encoding='utf-8')
        assert version_mod.backend_version() == '0.19.1'

    def testMissingEverywhereFallsBack(self, tmp_path, monkeypatch):
        import app.version as version_mod

        monkeypatch.setattr(version_mod, '_VERSION_CACHE', None)
        monkeypatch.setattr(version_mod, '_PKG_ROOT', tmp_path / 'nowhere' / 'backend-py')
        assert version_mod.backend_version() == '0.1.0'

    def testPackagedSourceReportsStampSha(self, tmp_path, monkeypatch):
        import app.lib.build_info as build_info

        monkeypatch.setattr(build_info, '_PKG_ROOT', tmp_path / 'backend-py')
        (tmp_path / 'backend-py').mkdir()
        (tmp_path / 'backend-runtime.json').write_text(
            json.dumps({'sourceSha': 'abc1234', 'sourceBranch': 'master', 'preparedAt': '2026-09-15T01:02:03Z'}),
            encoding='utf-8',
        )
        info = build_info.runtimeBuildInfo(refresh=True)
        assert info['source'] == 'installer-stamp'
        assert info['sha'] == 'abc1234'
        assert 'abc1234' in build_info.runtimeBuildLine()
        assert 'installer-stamp' in build_info.runtimeBuildLine()

    def testDiagnoseProxyCarriesRuntimeLine(self, monkeypatch):
        import asyncio

        import app.lib.build_info as build_info
        from app.services.tool_registrations.system_tools import _diagnoseProxy

        monkeypatch.setattr(
            build_info, 'runtimeBuildInfo', lambda *a, **kw: {'source': 'git-checkout', 'sha': 'deadbee', 'builtAt': '', 'branch': '', 'version': '0.18.10'}
        )
        out = asyncio.run(_diagnoseProxy())
        assert 'Runtime code: deadbee (git-checkout)' in out


# ---------------------------------------------------------------- finding 9
class TestSensitiveTopicExplainability:
    """#9 — `remember` refused an engineering audit twice, silently."""

    def testTechnicalDiagnoseIsNoLongerSensitive(self):
        from app.services.sensitive_topics import isSensitiveMemory, sensitiveMemoryReason

        text = (
            'Harness friction audit: diagnose_proxy showed the AppData backend; '
            'self-diagnosis of the stuck turn needed a turn_end event.'
        )
        assert isSensitiveMemory(text) is False
        assert sensitiveMemoryReason(text) is None

    def testRealHealthFactsStillRefused(self):
        from app.services.sensitive_topics import sensitiveMemoryReason

        assert sensitiveMemoryReason('user was diagnosed with diabetes') is not None
        assert sensitiveMemoryReason('user takes antidepressant medication daily') is not None
        assert sensitiveMemoryReason('SSN 123-45-6789') is not None

    def testReasonNamesTheTrigger(self):
        from app.services.sensitive_topics import sensitiveMemoryReason

        # Whatever matched is quoted back — the model can see WHY it was refused.
        assert 'psychotherapist' in str(sensitiveMemoryReason('user sees a psychotherapist weekly'))
        assert 'diagnosed with' in str(sensitiveMemoryReason('user was diagnosed with hypertension'))

    def testRememberRefusalQuotesTheTrigger(self, tmp_path, monkeypatch):
        import asyncio

        from app.config import settings

        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        settings.reload()
        from app.services.tool_registrations import session_tools

        out = json.loads(
            asyncio.run(
                session_tools._remember(
                    fact='user was diagnosed with hypertension',
                    details='taken from a clinic visit',
                )
            )
        )
        assert out['ok'] is False
        assert 'diagnosed with' in out['policy']
        assert 'false positive' in out['policy']
