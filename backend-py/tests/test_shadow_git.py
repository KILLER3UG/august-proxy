"""§9.3 #7 shadow-git snapshots: separate git dir per session, per-step
commits, per-message diffs, revert/unrevert. Uses real git in tmp dirs."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.workbench import shadow_git as sg  # noqa: E402


def _git(cwd: Path, *args: str) -> None:
    env = dict(os.environ)
    env.update(
        {
            'GIT_AUTHOR_NAME': 't',
            'GIT_AUTHOR_EMAIL': 't@t',
            'GIT_COMMITTER_NAME': 't',
            'GIT_COMMITTER_EMAIL': 't@t',
        }
    )
    subprocess.run(['git', *args], cwd=str(cwd), check=True, capture_output=True, env=env)


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    dataDir = tmp_path / 'data'
    monkeypatch.setenv('AUGUST_DATA_DIR', str(dataDir))
    ws = tmp_path / 'ws'
    ws.mkdir()
    return ws


class TestInitAndSnapshot:
    def testInitIdempotent(self, env: Path) -> None:
        d1 = sg.init_shadow('s1', str(env))
        d2 = sg.init_shadow('s1', str(env))
        assert d1 is not None and d1 == d2
        assert (d1 / 'HEAD').exists()

    def testAlternatesWhenWorkspaceIsGitRepo(self, env: Path) -> None:
        _git(env, 'init', '-q')
        d = sg.init_shadow('s1', str(env))
        assert d is not None
        alt = d / 'objects' / 'info' / 'alternates'
        assert alt.exists()
        assert '.git' in alt.read_text(encoding='utf-8').replace('\\', '/')

    def testNoAlternatesForPlainDir(self, env: Path) -> None:
        d = sg.init_shadow('s1', str(env))
        assert d is not None
        assert not (d / 'objects' / 'info' / 'alternates').exists()

    def testSnapshotOnlyOnChange(self, env: Path) -> None:
        (env / 'a.txt').write_text('v1')
        sha1 = sg.commit_snapshot('s1', str(env), 'first')
        assert sha1
        assert sg.commit_snapshot('s1', str(env), 'noop') is None
        (env / 'a.txt').write_text('v2')
        sha2 = sg.commit_snapshot('s1', str(env), 'second')
        assert sha2 and sha2 != sha1

    def testExcludesHeavyDirs(self, env: Path) -> None:
        (env / 'node_modules').mkdir()
        (env / 'node_modules' / 'junk.js').write_text('x')
        (env / 'real.py').write_text('y')
        sg.commit_snapshot('s1', str(env), 'snap')
        d = sg.shadow_dir('s1')
        ls = subprocess.run(
            ['git', f'--git-dir={d}', f'--work-tree={env}', 'ls-files'],
            capture_output=True,
            text=True,
            check=True,
        )
        assert 'real.py' in ls.stdout
        assert 'node_modules' not in ls.stdout

    def testExcludesEdaDerivedBinaries(self, env: Path) -> None:
        """§5.7: .sof/.pof/.glb/.hex are tool-regeneratable outputs whose
        random bytes don't compress — each compile iteration would cost its
        full size in the object store. Text EDA artifacts (.cir/.vcd/.svg)
        stay tracked (revert-protectable, ChangesCard-diffable)."""
        (env / 'build.sof').write_bytes(b'\x00' * 4096)
        (env / 'board.glb').write_bytes(b'\x00' * 4096)
        (env / 'fw.hex').write_text(':10000000C3\n')
        (env / 'deck.cir').write_text('* deck\n.tran 1m\n')
        (env / 'wave.vcd').write_text('$timescale 1us $end\n')
        (env / 'op.op.svg').write_text('<svg/>')
        sg.commit_snapshot('s1', str(env), 'snap')
        d = sg.shadow_dir('s1')
        ls = subprocess.run(
            ['git', f'--git-dir={d}', f'--work-tree={env}', 'ls-files'],
            capture_output=True,
            text=True,
            check=True,
        )
        for binary in ('build.sof', 'board.glb', 'fw.hex'):
            assert binary not in ls.stdout
        for text_artifact in ('deck.cir', 'wave.vcd', 'op.op.svg'):
            assert text_artifact in ls.stdout


class TestListAndDiff:
    def _twoSnaps(self, env: Path) -> tuple[str, str]:
        (env / 'a.txt').write_text('v1')
        sha1 = sg.commit_snapshot('s1', str(env), 'first')
        (env / 'a.txt').write_text('v2')
        sha2 = sg.commit_snapshot('s1', str(env), 'second')
        assert sha1 and sha2
        return sha1, sha2

    def testListNewestFirst(self, env: Path) -> None:
        self._twoSnaps(env)
        snaps = sg.list_snapshots('s1', str(env))
        assert [s['message'] for s in snaps] == ['second', 'first']
        assert all(len(s['sha']) == 40 for s in snaps)

    def testDiffLastShowsChange(self, env: Path) -> None:
        self._twoSnaps(env)
        diff = sg.diff_last('s1', str(env))
        assert '-v1' in diff and '+v2' in diff

    def testDiffBetweenArbitrary(self, env: Path) -> None:
        sha1, sha2 = self._twoSnaps(env)
        assert '+v2' in sg.diff_between('s1', str(env), sha1, sha2)
        assert sg.diff_between('nope', str(env), sha1, sha2) == ''

    def testEmptySession(self, env: Path) -> None:
        assert sg.list_snapshots('ghost', str(env)) == []
        assert sg.diff_last('ghost', str(env)) == ''
        assert sg.head_sha('ghost', str(env)) is None


class TestRevertUnrevert:
    def testRevertRestoresAndUnrevertBringsBack(self, env: Path) -> None:
        (env / 'a.txt').write_text('v1')
        sha1 = sg.commit_snapshot('s1', str(env), 'first')
        (env / 'a.txt').write_text('v2')
        (env / 'b.txt').write_text('new file')
        sg.commit_snapshot('s1', str(env), 'second')

        result = sg.revert_to('s1', str(env), sha1 or '')
        assert result['ok'] is True
        assert (env / 'a.txt').read_text() == 'v1'
        assert not (env / 'b.txt').exists()  # deletion synced too

        # The pre-revert state (v2 + b.txt) is recoverable.
        snaps = sg.list_snapshots('s1', str(env))
        assert any(s['message'].startswith(sg.PRE_REVERT_MARKER) for s in snaps)
        un = sg.unrevert('s1', str(env))
        assert un['ok'] is True
        assert (env / 'a.txt').read_text() == 'v2'
        assert (env / 'b.txt').exists()

    def testRevertUnknownSha(self, env: Path) -> None:
        (env / 'a.txt').write_text('v1')
        sg.commit_snapshot('s1', str(env), 'first')
        result = sg.revert_to('s1', str(env), 'deadbeef')
        assert result['ok'] is False
        assert 'unknown snapshot' in str(result['error'])

    def testUnrevertWithoutPreRevert(self, env: Path) -> None:
        (env / 'a.txt').write_text('v1')
        sg.commit_snapshot('s1', str(env), 'first')
        result = sg.unrevert('s1', str(env))
        assert result['ok'] is False
        assert 'nothing to unrevert' in str(result['error'])

    def testWorkspaceGitUntouched(self, env: Path) -> None:
        # The workspace's own git state must never be modified.
        _git(env, 'init', '-q')
        (env / 'a.txt').write_text('v1')
        _git(env, 'add', '.')
        _git(env, 'commit', '-qm', 'user commit')
        headBefore = subprocess.run(
            ['git', 'rev-parse', 'HEAD'], cwd=str(env), capture_output=True, text=True, check=True
        ).stdout.strip()
        (env / 'a.txt').write_text('v2')
        sha = sg.commit_snapshot('s1', str(env), 'shadow snap')
        assert sha
        headAfter = subprocess.run(
            ['git', 'rev-parse', 'HEAD'], cwd=str(env), capture_output=True, text=True, check=True
        ).stdout.strip()
        assert headBefore == headAfter
        status = subprocess.run(
            ['git', 'status', '--porcelain'], cwd=str(env), capture_output=True, text=True, check=True
        ).stdout
        assert 'M a.txt' in status  # working-tree change still visible to the user
