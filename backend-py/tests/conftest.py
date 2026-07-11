"""Shared pytest fixtures for the new self-configuration / browser tests.

The ``isolated_data`` fixture redirects the data directory and brain SQLite
file to a temp path so tests that mutate aliases / fallback / agents never
touch the user's real ``config.json`` or ``august_brain.sqlite``. It is
opt-in — existing tests are unaffected.
"""

from __future__ import annotations
import pytest


@pytest.fixture
def isolatedData(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import memory_store

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'test_brain.sqlite'))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    memory_store.close()
    memory_store.init()
    yield tmp_path
    memory_store.close()
    settings.reload()


@pytest.fixture
def isolatedSkills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs (shared via conftest)."""
    from app.services import skill_service

    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundledRoot)
    return (agentRoot, bundledRoot)
