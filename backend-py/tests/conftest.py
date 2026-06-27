"""Shared pytest fixtures for the new self-configuration / browser tests.

The ``isolated_data`` fixture redirects the data directory and brain SQLite
file to a temp path so tests that mutate aliases / fallback / agents never
touch the user's real ``config.json`` or ``august_brain.sqlite``. It is
opt-in — existing tests are unaffected.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def isolated_data(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import memory_store

    monkeypatch.setenv("AUGUST_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUGUST_BRAIN_SQLITE_FILE", str(tmp_path / "test_brain.sqlite"))
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    settings.reload()  # read the empty temp config

    # Reset the thread-local SQLite connection so it points at the temp DB.
    memory_store.close()
    memory_store.init()

    yield tmp_path

    memory_store.close()
    settings.reload()
