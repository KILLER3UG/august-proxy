"""v2 — Test the model fleet module."""
import pytest
from app.services.workbench import model_fleet


def test_get_model_for_role_uses_defaults():
    """Without config override, defaults from DEFAULT_FLEET apply."""
    model_fleet._reset_cache()  # clear any cached config
    assert model_fleet.get_model_for_role("cerebellum") == "claude-3-haiku-20240307"
    assert model_fleet.get_model_for_role("hippocampus") == "claude-3-haiku-20240307"
    assert model_fleet.get_model_for_role("prefrontal") == "claude-3-5-sonnet-20240620"


def test_get_model_for_role_cortex_empty():
    """Cortex role returns empty string (caller uses session's primary model)."""
    assert model_fleet.get_model_for_role("cortex") == ""


def test_get_model_for_role_unknown_returns_cortex_default():
    """Unknown role falls back to cortex (empty string)."""
    assert model_fleet.get_model_for_role("nonexistent_role") == ""


def test_get_model_for_role_config_override(monkeypatch, tmp_path):
    """User config override takes precedence over defaults."""
    # Create a config file with overrides
    config_file = tmp_path / "config.json"
    config_file.write_text('{"auxiliary": {"model_fleet": {"cerebellum": "gpt-4o-mini"}}}')
    monkeypatch.setattr(model_fleet, "_config_path", str(config_file))
    model_fleet._reset_cache()
    assert model_fleet.get_model_for_role("cerebellum") == "gpt-4o-mini"
    # Other roles still default
    assert model_fleet.get_model_for_role("hippocampus") == "claude-3-haiku-20240307"
