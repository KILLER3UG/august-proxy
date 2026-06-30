"""v1.1 — Test that build_system_prompt accepts cached_t12 kwarg."""
import pytest
from app.services.memory.context_builder import buildSystemPrompt

def testBuildSystemPromptAcceptsCachedT12():
    """Regression: Phase 7 cache hook must not TypeError on the kwarg."""
    result = buildSystemPrompt(session={'id': 'test'}, memory={}, tools=[], agent_context=None, cached_t12='<cached Tier 1+2 content>')
    assert '<cached Tier 1+2 content>' in result

def testBuildSystemPromptDefaultCachedT12IsNone():
    """Backward compat: omitting cached_t12 should still work (None default)."""
    result = buildSystemPrompt(session={'id': 'test'}, memory={})
    assert isinstance(result, str)

def testCachedT12ShortCircuitsT1T2():
    """When cached_t12 is provided, T1+T2 must NOT be regenerated."""
    cachePayload = 'CACHE_HIT_MARKER_XYZ'
    result = buildSystemPrompt(session={'id': 'test', 'user_state': {'profile': 'should not appear'}}, memory={}, cached_t12=cachePayload)
    assert cachePayload in result
    assert 'should not appear' not in result