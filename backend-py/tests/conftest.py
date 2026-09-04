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
    # Gateway auth tests expect a clean key. Use empty string (not delenv) so
    # settings.reload() → load_dotenv(override=False) cannot rehydrate from .env.
    monkeypatch.setenv('GATEWAY_API_KEY', '')
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    monkeypatch.setattr(settings, 'gatewayApiKey', None)

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
    # reload() can rehydrate GATEWAY_API_KEY from a local .env — clear again.
    settings.gatewayApiKey = None
    # Invalidate model cache so per-test providers.json is picked up (M7 fix).
    try:
        from app.services.model_service import invalidate_cache
        invalidate_cache()
    except Exception:
        pass
    memory_store.close()
    memory_store.init()
    yield tmp_path
    # Cancel leaked background tasks before closing SQLite to prevent
    # 'database is locked' errors from fire-and-forget workbench tasks.
    import asyncio

    try:
        loop = asyncio.get_running_loop()
        tasks = [t for t in asyncio.all_tasks(loop) if t is not asyncio.current_task() and not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
    except RuntimeError:
        pass  # No running loop (sync test)
    memory_store.close()
    try:
        settings.reload()
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _reset_module_singletons():
    """Reset in-memory module singletons between tests so cross-file
    ordering cannot leak state (prompt cache, MCP servers, service-connections
    config cache, prompt segments cache, model cache, tool registry)."""
    try:
        from app.services import tool_registry as _tr

        _registry_snapshot = dict(_tr._registry)
        _generation_snapshot = _tr._generation
    except Exception:
        _registry_snapshot, _generation_snapshot = None, None
    yield
    try:
        from app.services.tools import mcp_client
        mcp_client._servers.clear()
    except Exception:
        pass
    try:
        from app.services.workbench import prompt_segments_cache
        prompt_segments_cache.clear()
    except Exception:
        pass
    try:
        from app.services.model_service import invalidate_cache
        invalidate_cache()
    except Exception:
        pass
    if _registry_snapshot is not None:
        try:
            from app.services import tool_registry as _tr2

            _tr2._registry.clear()
            _tr2._registry.update(_registry_snapshot)
            _tr2._generation = _generation_snapshot
        except Exception:
            pass
    try:
        from app.services.workbench import workbench as _wb
        _wb._git_probe_cache.clear()
    except Exception:
        pass


@pytest.fixture()
def brain_ready(tmp_path, monkeypatch):
    """Shared brain DB fixture: temp data dir + full schema on the brain conn."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import _conn

    c = _conn()
    ensure_schema(c)
    c.commit()
    return c


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
    skill_service._flat_migrate_done = False
    # Skills catalogue is cached ~30s for prompt build; wipe so isolated roots win.
    prompt_segments_cache.clear()
    yield (agentRoot, bundledRoot)
    prompt_segments_cache.clear()
    skill_service._flat_migrate_done = False
