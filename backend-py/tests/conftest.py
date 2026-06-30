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
    from app.services import memoryStore
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'test_brain.sqlite'))
    monkeypatch.setattr(settings, 'data_dir', tmp_path)
    settings.reload()
    memoryStore.close()
    memoryStore.init()
    yield tmp_path
    memoryStore.close()
    settings.reload()

@pytest.fixture
def isolatedSkills(tmp_path, monkeypatch):
    """Redirect both skill roots to temp dirs (shared via conftest)."""
    from app.services import skillService
    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skillService, '_agent_skills_dir', lambda: agentRoot)
    monkeypatch.setattr(skillService, 'SKILLS_DIR', bundledRoot)
    return (agentRoot, bundledRoot)