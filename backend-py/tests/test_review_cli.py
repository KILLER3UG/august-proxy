"""R-C part 2 (plan §10.5): CI exit-code mode for code review."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from app import review_cli
from app.services import code_review as cr


def _result(findings: list[dict], skipped: bool = False, notice: str = '') -> dict:
    counts = {'p0': 0, 'p1': 0, 'p2': 0, 'p3': 0}
    for f in findings:
        counts[f"p{f['severity']}"] += 1
    return {
        'skipped': skipped,
        'notice': notice,
        'model': 'test-model',
        'counts': counts,
        'findings': findings,
        'droppedUngrounded': 0,
        'passes': 1,
        'judge': {'ran': False, 'reason': 'test'},
    }


def _finding(severity: int, title: str, file: str = 'a.py', line: int = 10) -> dict:
    return {
        'severity': severity,
        'tag': f'P{severity}',
        'title': title,
        'body': 'explanation line one\nmore',
        'file': file,
        'line': line,
        'failSafe': False,
        'status': 'kept',
        'groundedPath': file,
        'confidence': 0.9,
    }


@pytest.fixture
def patchReview(monkeypatch):
    def _patch(result: dict):
        async def _fake(**kwargs):
            return result

        monkeypatch.setattr(cr, 'run_code_review_async', _fake)

    return _patch


@pytest.fixture
def diffFile(tmp_path: Path) -> Path:
    p = tmp_path / 'change.diff'
    p.write_text('diff --git a/a.py b/a.py\n+print(1)\n', encoding='utf-8')
    return p


class TestExitCodes:
    def testBlockingP1FailsGate(self, patchReview, diffFile, capsys):
        patchReview(_result([_finding(1, 'Off-by-one in loop')]))
        code = review_cli.main(['--diff', str(diffFile)])
        assert code == review_cli.EXIT_BLOCKING
        out = capsys.readouterr().out
        assert '[P1] a.py:10' in out
        assert '[blocking]' in out

    def testP0BlocksEvenUnderBlockOnP1(self, patchReview, diffFile):
        patchReview(_result([_finding(0, 'Data loss')]))
        assert review_cli.main(['--diff', str(diffFile)]) == review_cli.EXIT_BLOCKING

    def testAdvisoryP2PassesByDefault(self, patchReview, diffFile, capsys):
        patchReview(_result([_finding(2, 'Edge case under abnormal precondition')]))
        assert review_cli.main(['--diff', str(diffFile)]) == review_cli.EXIT_CLEAN
        assert 'No blocking findings' in capsys.readouterr().out

    def testBlockOnP2EscalatesAdvisory(self, patchReview, diffFile):
        patchReview(_result([_finding(2, 'Edge case')]))
        code = review_cli.main(['--diff', str(diffFile), '--block-on', 'p2'])
        assert code == review_cli.EXIT_BLOCKING

    def testCleanReviewExitZero(self, patchReview, diffFile):
        patchReview(_result([]))
        assert review_cli.main(['--diff', str(diffFile)]) == review_cli.EXIT_CLEAN

    def testSkippedReviewExitTwo(self, patchReview, diffFile, capsys):
        patchReview(_result([], skipped=True, notice='No review model configured'))
        code = review_cli.main(['--diff', str(diffFile)])
        assert code == review_cli.EXIT_NOT_RUN
        assert 'skipped' in capsys.readouterr().err

    def testJsonModeParses(self, patchReview, diffFile, capsys):
        patchReview(_result([_finding(1, 'Bug')]))
        code = review_cli.main(['--diff', str(diffFile), '--json'])
        assert code == review_cli.EXIT_BLOCKING
        payload = json.loads(capsys.readouterr().out)
        assert payload['counts']['p1'] == 1
        assert payload['findings'][0]['title'] == 'Bug'

    def testDiffFromStdin(self, patchReview, monkeypatch, capsys):
        monkeypatch.setattr(sys, 'stdin', io.StringIO('diff --git a/x b/x\n+1\n'))
        patchReview(_result([]))
        assert review_cli.main(['--diff', '-']) == review_cli.EXIT_CLEAN

    def testGitFailureExitThree(self, tmp_path, capsys):
        # A directory that is not a git repository.
        code = review_cli.main(['--repo', str(tmp_path)])
        assert code == review_cli.EXIT_USAGE
        assert 'august-review' in capsys.readouterr().err


class TestGitDiffSource:
    def testGitDiffAgainstBase(self, tmp_path):
        def git(*args):
            subprocess.run(
                ['git', *args],
                cwd=tmp_path,
                capture_output=True,
                check=True,
            )

        git('init', '-q')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
        (tmp_path / 'a.py').write_text('x = 1\n', encoding='utf-8')
        git('add', 'a.py')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add a.py')
        (tmp_path / 'a.py').write_text('x = 2\n', encoding='utf-8')

        diff_text, paths = review_cli._git_diff(str(tmp_path), 'HEAD')
        assert paths == ['a.py']
        assert '-x = 1' in diff_text
        assert '+x = 2' in diff_text
