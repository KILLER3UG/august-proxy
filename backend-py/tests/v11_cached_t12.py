"""v1.1 — Test that build_system_prompt accepts cached_t12 kwarg."""
import pytest
from app.services.memory.context_builder import build_system_prompt


def test_build_system_prompt_accepts_cached_t12():
    """Regression: Phase 7 cache hook must not TypeError on the kwarg."""
    # Should not raise TypeError
    result = build_system_prompt(
        session={"id": "test"},
        memory={},
        tools=[],
        agent_context=None,
        cached_t12="<cached Tier 1+2 content>",
    )
    # Result should include the cached content
    assert "<cached Tier 1+2 content>" in result


def test_build_system_prompt_default_cached_t12_is_none():
    """Backward compat: omitting cached_t12 should still work (None default)."""
    result = build_system_prompt(
        session={"id": "test"},
        memory={},
    )
    # No exception, returns a string
    assert isinstance(result, str)


def test_cached_t12_short_circuits_t1_t2():
    """When cached_t12 is provided, T1+T2 must NOT be regenerated."""
    # Provide a distinctive cached payload; assert T1+T2 builder functions
    # are not called when the cache is present. We do this by checking
    # that the cached payload appears verbatim in the result.
    cache_payload = "CACHE_HIT_MARKER_XYZ"
    result = build_system_prompt(
        session={"id": "test", "user_state": {"profile": "should not appear"}},
        memory={},
        cached_t12=cache_payload,
    )
    assert cache_payload in result
    # The T1 user_state content should not have been rebuilt
    # (this verifies the cache short-circuits the T1+T2 path)
    assert "should not appear" not in result
