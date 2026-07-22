"""v4.2 — Test /api/config/live endpoints (STT/TTS Live settings)."""

import json

import pytest


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Redirect config.json to a temp path so tests don't touch real config."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'test_brain.sqlite'))
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    yield tmp_path
    settings.reload()


def testGetReturnsDefaultsWhenConfigIsEmpty():
    """GET returns the live config merged with defaults."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.get('/api/config/live')
    assert resp.status_code == 200
    data = resp.json()
    assert data['sttProvider'] == ''
    assert data['ttsProvider'] == ''
    assert data['sttModel'] == ''
    assert data['ttsModel'] == ''
    assert data['ttsVoice'] == ''


def testGetMergesUserOverridesWithDefaults():
    from app.lib.paths import dataPath
    from app.main import app
    from fastapi.testclient import TestClient

    dataPath('config.json').parent.mkdir(exist_ok=True)
    dataPath('config.json').write_text(
        json.dumps({'auxiliary': {'live': {'sttProvider': 'openai', 'sttModel': 'whisper-1'}}})
    )
    client = TestClient(app)
    data = client.get('/api/config/live').json()
    assert data['sttProvider'] == 'openai'
    assert data['sttModel'] == 'whisper-1'
    assert data['ttsProvider'] == ''
    assert data['ttsVoice'] == ''


def testPutPartialUpdatePersists():
    from app.lib.paths import dataPath
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.put('/api/config/live', json={'ttsProvider': 'elevenlabs', 'ttsVoice': 'alloy'})
    assert resp.status_code == 200
    assert resp.json()['ttsProvider'] == 'elevenlabs'
    cfg = json.loads(dataPath('config.json').read_text())
    assert cfg['auxiliary']['live']['ttsProvider'] == 'elevenlabs'
    assert cfg['auxiliary']['live']['ttsVoice'] == 'alloy'


def testPutAllowsEmptyProviderUseBrowserDefault():
    """Empty provider field = "use browser default" per spec §14."""
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.put('/api/config/live', json={'sttProvider': ''})
    assert resp.status_code == 200
    assert resp.json()['sttProvider'] == ''


def testPutRejectsUnknownField():
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.put('/api/config/live', json={'invented': 'x'})
    assert resp.status_code == 400


def testPutRejectsNonStringValue():
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    resp = client.put('/api/config/live', json={'sttProvider': 42})
    assert resp.status_code == 400
