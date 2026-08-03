"""Regression: the Tier1+Tier2 prompt cache is keyed on a content hash of its
inputs, not on session id. Changing workspacePath (or any other Tier1/Tier2
input) between two builds for the same session must produce a cache miss and
rebuild, so the prompt always reflects the current state."""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _clear_cache():
    from app.services.workbench.prompt_cache import getCache
    getCache().clear()
    yield
    getCache().clear()


def _make_session(workspace_path: str = 'C:/projA') -> object:
    """Minimal session-like object for buildSystemPrompt."""
    from app.services.workbench.sessions import create_workbench_session
    s = create_workbench_session(provider='test', guardMode='full')
    s.workspacePath = workspace_path
    return s


def test_workspace_path_change_produces_new_prompt():
    """Two builds with different workspacePath must yield different prompts."""
    from app.services.workbench.workbench import buildSystemPrompt

    s = _make_session('C:/projA')
    prompt_a = buildSystemPrompt(s, tools=[])

    s.workspacePath = 'C:/projB'
    prompt_b = buildSystemPrompt(s, tools=[])

    assert 'C:/projA' in prompt_a or 'projA' in prompt_a
    assert 'C:/projB' in prompt_b or 'projB' in prompt_b
    assert prompt_a != prompt_b


def test_identical_inputs_hit_cache():
    """Two builds with identical inputs must hit the cache (buildTier2 called once)."""
    from app.services.workbench.workbench import buildSystemPrompt

    s = _make_session('C:/projA')
    call_count = 0
    original_build_tier2 = None

    from app.services.memory import context_builder

    original_build_tier2 = context_builder.buildTier2

    def counting_build_tier2(session):
        nonlocal call_count
        call_count += 1
        return original_build_tier2(session)

    with patch.object(context_builder, 'buildTier2', side_effect=counting_build_tier2):
        buildSystemPrompt(s, tools=[])
        # First call is a cache miss: buildTier2 is called by ctxBuild AND by
        # the cache-write path in workbench.py → 2 calls.
        first_count = call_count
        assert first_count >= 1
        buildSystemPrompt(s, tools=[])
        # Second call is a cache hit: buildTier2 is NOT called again.
        assert call_count == first_count
