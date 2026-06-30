"""v2 — Test the model fleet module."""
import pytest
from app.services.workbench import modelFleet

def testGetModelForRoleUsesDefaults():
    """Without config override, defaults from DEFAULT_FLEET apply."""
    modelFleet._reset_cache()
    assert modelFleet.get_model_for_role('cerebellum') == 'claude-3-haiku-20240307'
    assert modelFleet.get_model_for_role('hippocampus') == 'claude-3-haiku-20240307'
    assert modelFleet.get_model_for_role('prefrontal') == 'claude-3-5-sonnet-20240620'

def testGetModelForRoleCortexEmpty():
    """Cortex role returns empty string (caller uses session's primary model)."""
    assert modelFleet.get_model_for_role('cortex') == ''

def testGetModelForRoleUnknownReturnsCortexDefault():
    """Unknown role falls back to cortex (empty string)."""
    assert modelFleet.get_model_for_role('nonexistent_role') == ''

def testGetModelForRoleConfigOverride(monkeypatch, tmp_path):
    """User config override takes precedence over defaults."""
    configFile = tmp_path / 'config.json'
    configFile.write_text('{"auxiliary": {"model_fleet": {"cerebellum": "gpt-4o-mini"}}}')
    monkeypatch.setattr(modelFleet, '_config_path', str(configFile))
    modelFleet._reset_cache()
    assert modelFleet.get_model_for_role('cerebellum') == 'gpt-4o-mini'
    assert modelFleet.get_model_for_role('hippocampus') == 'claude-3-haiku-20240307'