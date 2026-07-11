"""v2 — Test the model fleet module."""
import pytest
from app.services.workbench import model_fleet

def testGetModelForRoleUsesDefaults():
    """Without config override, defaults from DEFAULT_FLEET apply."""
    model_fleet._reset_cache()
    assert model_fleet.getModelForRole('cerebellum') == 'claude-3-haiku-20240307'
    assert model_fleet.getModelForRole('hippocampus') == 'claude-3-haiku-20240307'
    assert model_fleet.getModelForRole('prefrontal') == 'claude-3-5-sonnet-20240620'

def testGetModelForRoleCortexEmpty():
    """Cortex role returns empty string (caller uses session's primary model)."""
    assert model_fleet.getModelForRole('cortex') == ''

def testGetModelForRoleUnknownReturnsCortexDefault():
    """Unknown role falls back to cortex (empty string)."""
    assert model_fleet.getModelForRole('nonexistent_role') == ''

def testGetModelForRoleConfigOverride(monkeypatch, tmp_path):
    """User config override takes precedence over defaults."""
    configFile = tmp_path / 'config.json'
    configFile.write_text('{"auxiliary": {"model_fleet": {"cerebellum": "gpt-4o-mini"}}}')
    monkeypatch.setattr(model_fleet, '_config_path', str(configFile))
    model_fleet._reset_cache()
    assert model_fleet.getModelForRole('cerebellum') == 'gpt-4o-mini'
    assert model_fleet.getModelForRole('hippocampus') == 'claude-3-haiku-20240307'