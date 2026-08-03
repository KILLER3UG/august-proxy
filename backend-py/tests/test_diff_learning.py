"""Diff learning — correction rules learned from git history."""

from __future__ import annotations

import json
import subprocess

import pytest


def _git(repo, *args):
    subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True, text=True)


@pytest.fixture()
def git_repo(tmp_path):
    """A real git repo: two real commits + one noise commit (lockfile)."""
    import shutil

    if shutil.which('git') is None:
        pytest.skip('git binary not available')
    repo = tmp_path / 'repo'
    repo.mkdir()
    _git(repo, 'init', '-q')
    _git(repo, 'config', 'user.email', 'test@example.com')
    _git(repo, 'config', 'user.name', 'Test')

    (repo / 'src').mkdir()
    (repo / 'src' / 'types.ts').write_text(
        'export function findUser(id: string) {}\n', encoding='utf-8'
    )
    (repo / 'package-lock.json').write_text('{"lockfileVersion": 3}\n', encoding='utf-8')
    _git(repo, 'add', '-A')
    _git(repo, 'commit', '-q', '-m', 'init')

    # Real correction pattern: replace `any` with a branded type.
    (repo / 'src' / 'types.ts').write_text(
        'export type UserId = string;\nexport function findUser(id: UserId) {}\n',
        encoding='utf-8',
    )
    _git(repo, 'add', '-A')
    _git(repo, 'commit', '-q', '-m', 'use branded type for user ids')

    # Noise commit: lockfile churn only.
    (repo / 'package-lock.json').write_text('{"lockfileVersion": 3, "deps": 99}\n', encoding='utf-8')
    _git(repo, 'add', '-A')
    _git(repo, 'commit', '-q', '-m', 'chore: bump lockfile')
    return repo


def test_collect_filters_noise_keeps_correction(git_repo):
    from app.services.memory.diff_learning import collect_correction_diffs

    diffs = collect_correction_diffs(str(git_repo))
    assert 'src/types.ts' in diffs
    assert 'package-lock.json' not in diffs
    assert 'UserId' in diffs


def test_collect_bounded(git_repo):
    from app.services.memory.diff_learning import collect_correction_diffs

    diffs = collect_correction_diffs(str(git_repo), max_chars=200)
    # Blocks are joined with '\n\n'; allow separator overhead beyond the cap.
    assert len(diffs) <= 200 + 4


def test_collect_non_git_dir(tmp_path):
    from app.services.memory.diff_learning import collect_correction_diffs

    assert collect_correction_diffs(str(tmp_path / 'nope')) == ''


def test_interval_defaults_to_six_hours(monkeypatch):
    from app.services.memory import diff_learning as dl

    monkeypatch.delenv('AUGUST_DIFF_LEARN_INTERVAL_S', raising=False)
    assert dl._interval_seconds() == 6 * 3600
    monkeypatch.setenv('AUGUST_DIFF_LEARN_INTERVAL_S', '30')
    assert dl._interval_seconds() == 60
    monkeypatch.setenv('AUGUST_DIFF_LEARN_INTERVAL_S', 'not-a-number')
    assert dl._interval_seconds() == 6 * 3600


@pytest.mark.asyncio
async def test_learn_from_diffs_writes_heuristic(brain_ready, git_repo, monkeypatch):
    from app.services.heuristics_service import listHeuristics
    from app.services.memory import diff_learning as dl

    async def stubLlm(_prompt):
        return json.dumps(
            {'corrections': [{'rule': 'Use branded types for IDs instead of any', 'confidence': 0.8}]}
        )

    result = await dl.learn_from_diffs(str(git_repo), llm_client=stubLlm)
    assert result['learned'] == 1
    rows = listHeuristics()
    assert rows[0]['rule'] == 'Use branded types for IDs instead of any'
    assert rows[0]['source'] == 'diff'
    assert rows[0]['category'] == 'correction'
    assert rows[0]['confidence'] == 0.8


@pytest.mark.asyncio
async def test_interval_gate_skips_second_run(brain_ready, git_repo):
    from app.services.memory import diff_learning as dl

    async def stubLlm(_prompt):
        return json.dumps({'corrections': [{'rule': 'A durable rule from git', 'confidence': 0.6}]})

    first = await dl.learn_from_diffs(str(git_repo), llm_client=stubLlm)
    assert first['learned'] == 1
    second = await dl.learn_from_diffs(str(git_repo), llm_client=stubLlm)
    assert second['learned'] == 0
    assert second['reason'] == 'interval'


@pytest.mark.asyncio
async def test_non_git_workspace_noop(brain_ready, tmp_path):
    from app.services.memory import diff_learning as dl

    async def stubLlm(_prompt):
        return json.dumps({'corrections': []})

    result = await dl.learn_from_diffs(str(tmp_path / 'not-a-repo'), llm_client=stubLlm)
    assert result['reason'] == 'no_diffs'


@pytest.mark.asyncio
async def test_feature_flag_off_noop(brain_ready, git_repo, monkeypatch):
    from app.services.memory import diff_learning as dl

    monkeypatch.setattr(
        'app.services.cognitive_config.get_features',
        lambda: {'diff_learning': False},
    )

    async def stubLlm(_prompt):
        return json.dumps({'corrections': [{'rule': 'Should never land', 'confidence': 0.9}]})

    result = await dl.learn_from_diffs(str(git_repo), llm_client=stubLlm)
    assert result['reason'] == 'feature_disabled'


@pytest.mark.asyncio
async def test_no_client_noop(brain_ready, git_repo):
    from app.services.memory import diff_learning as dl

    result = await dl.learn_from_diffs(str(git_repo), llm_client=None)
    assert result['reason'] == 'no_llm_client'
