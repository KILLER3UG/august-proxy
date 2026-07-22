"""Model fleet — single SoT via model_fleet_service (workbench re-export)."""

import pytest
from app.services import model_fleet_service
from app.services.workbench import model_fleet


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    model_fleet.invalidate_cache()
    model_fleet_service.invalidate_cache()
    yield tmp_path
    model_fleet.invalidate_cache()
    settings.reload()


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


def testGetModelForRoleConfigOverride(tmp_path):
    """User config override takes precedence over defaults."""
    import json

    from app.lib.paths import dataPath

    cfgPath = dataPath('config.json')
    cfgPath.parent.mkdir(parents=True, exist_ok=True)
    # Modern path: nested cognitive.fleet
    cfgPath.write_text(
        json.dumps({'auxiliary': {'cognitive': {'fleet': {'cerebellum': 'gpt-4o-mini'}}}})
    )
    model_fleet.invalidate_cache()
    assert model_fleet.getModelForRole('cerebellum') == 'gpt-4o-mini'
    assert model_fleet.getModelForRole('hippocampus') == 'claude-3-haiku-20240307'


def testGetModelForRoleLegacyFleetMigrates(tmp_path):
    """Flat auxiliary.model_fleet migrates into cognitive.fleet once."""
    import json

    from app.lib.paths import dataPath

    cfgPath = dataPath('config.json')
    cfgPath.parent.mkdir(parents=True, exist_ok=True)
    cfgPath.write_text(json.dumps({'auxiliary': {'model_fleet': {'cerebellum': 'legacy-model'}}}))
    model_fleet.invalidate_cache()
    assert model_fleet.getModelForRole('cerebellum') == 'legacy-model'
    # Legacy key removed after migrate
    saved = json.loads(cfgPath.read_text('utf-8'))
    assert 'model_fleet' not in saved.get('auxiliary', {})
    assert saved['auxiliary']['cognitive']['fleet']['cerebellum'] == 'legacy-model'


def testUpdateFleetVisibleWithoutRestart():
    """Settings save must update getModelForRole immediately."""
    ok, err, fleet = model_fleet_service.updateFleet({'cerebellum': 'instant-model'})
    assert ok, err
    assert model_fleet.getModelForRole('cerebellum') == 'instant-model'
    assert fleet['cerebellum'] == 'instant-model'
