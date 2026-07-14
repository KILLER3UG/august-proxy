"""BTW must resolve the same LLM as chat for a session."""

from __future__ import annotations

import pytest
from app.services.workbench.providers import resolve_chat_llm


def test_resolve_chat_llm_prefers_explicit_model_over_session():
    # Without real providers, both may be empty — exercise ordering via kwargs
    provider, model = resolve_chat_llm(
        model='explicit-model',
        model_provider='',
        session_provider='',
        session_model='session-model',
    )
    # If any provider exists, model should be the explicit one
    if provider is not None:
        assert model == 'explicit-model'
    else:
        # Still returns the model hint even when provider list is empty
        assert model == 'explicit-model'


def test_resolve_chat_llm_falls_back_to_session_model():
    provider, model = resolve_chat_llm(
        model='',
        model_provider='',
        session_provider='',
        session_model='from-session',
    )
    assert model == 'from-session'


@pytest.mark.asyncio
async def test_btw_body_model_matches_chat_sticky(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.lib import paths
    from app.config import settings
    from app.services import memory_store
    from app.services.workbench import sessions as sess_mod

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    settings._config = {}
    sess_mod._sessions.clear()
    memory_store.init()

    session = sess_mod.create_workbench_session(provider='test-prov', agentId='build')
    session.model = 'chat-model-x'
    session.provider = 'test-prov'
    sess_mod.save_sessions()

    # Sticky session fields must feed resolve_chat_llm the same way chat would
    _p, model = resolve_chat_llm(
        model='',
        model_provider='',
        session_provider=session.provider,
        session_model=session.model,
    )
    assert model == 'chat-model-x'
