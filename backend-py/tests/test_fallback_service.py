"""Fallback service tests (isolated data dir)."""
import pytest
from app.services import fallback_service


def test_get_default_shape(isolated_data):
    fb = fallback_service.get_fallback()
    assert "enabled" in fb and "mode" in fb and "provider" in fb and "model" in fb


def test_configure_partial(isolated_data):
    fb = fallback_service.configure_fallback(mode="session_only", actor="test")
    assert fb["mode"] == "session_only"
    # Unspecified fields preserved.
    assert "enabled" in fb


def test_invalid_mode_rejected(isolated_data):
    with pytest.raises(ValueError):
        fallback_service.configure_fallback(mode="bogus", actor="test")


def test_active_fallback_validates_provider(isolated_data):
    with pytest.raises(ValueError):
        fallback_service.configure_fallback(
            enabled=True, mode="always", provider="ZZZ_NoProvider", model="m", actor="test"
        )


def test_test_fallback_resolves(isolated_data):
    # test_fallback never saves; it just probes resolution.
    result = fallback_service.test_fallback("claude-sonnet-4-7")
    assert "ok" in result
