"""Shared pytest fixtures.

**Live production data isolation is mandatory and autouse.**

Every test runs with:
  * ``AUGUST_DATA_DIR`` → a throwaway temp directory
  * ``AUGUST_BRAIN_SQLITE_FILE`` → temp ``test_brain.sqlite`` under that dir
  * ``settings.dataDir`` pointed at the same temp dir

This prevents the suite from reading/writing the user's real
``data/august_brain.sqlite``, ``config.json``, workbench session files, etc.

Tests that need the temp path can still request ``isolatedData`` (yields the
``Path``). Tests that do not request it still get isolation.

Do **not** remove ``autouse=True`` without an explicit safety review.
"""

from __future__ import annotations

import sys

import pytest

# Hard gate: syntax like ``type X = ...`` and project policy require 3.12+.
if sys.version_info < (3, 12):
    raise SystemExit(
        f'august-proxy requires Python >= 3.12 (running {sys.version.split()[0]}). '
        'Use: cd backend-py && uv run pytest'
        '  (or activate backend-py/.venv after install.ps1 / install.sh).'
    )


@pytest.fixture(autouse=True)
def isolatedData(tmp_path, monkeypatch):
    """Redirect data dir + brain SQLite to a per-test temp path (autouse)."""
    import json

    from app.config import settings
    from app.services import memory_store

    brain = tmp_path / 'test_brain.sqlite'
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(brain))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)

    # Minimal providers.json so route tests don't depend on the live store.
    providers_path = tmp_path / 'providers.json'
    if not providers_path.exists():
        providers_path.write_text(
            json.dumps(
                {
                    'providers': [
                        {
                            'id': 'test-openai',
                            'name': 'Test OpenAI',
                            'apiFormat': 'openaiChat',
                            'baseUrl': 'https://api.openai.com/v1',
                            'enabled': True,
                            'models': [
                                {
                                    'id': 'gpt-4o-mini',
                                    'name': 'gpt-4o-mini',
                                    'contextWindow': 128000,
                                }
                            ],
                        }
                    ]
                }
            ),
            encoding='utf-8',
        )
    config_path = tmp_path / 'config.json'
    if not config_path.exists():
        config_path.write_text('{}', encoding='utf-8')

    try:
        settings.reload()
    except Exception:
        pass
    memory_store.close()
    memory_store.init()
    yield tmp_path
    memory_store.close()
    try:
        settings.reload()
    except Exception:
        pass


@pytest.fixture
def isolatedSkills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs (shared via conftest)."""
    from app.services import skill_service
    from app.services.workbench import prompt_segments_cache

    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundledRoot)
    # Skills catalogue is cached ~30s for prompt build; wipe so isolated roots win.
    prompt_segments_cache.clear()
    yield (agentRoot, bundledRoot)
    prompt_segments_cache.clear()
