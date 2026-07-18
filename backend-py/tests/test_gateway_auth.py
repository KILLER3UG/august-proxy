"""Tests for the External API Gateway Access feature.

Covers:
  - The ``require_gateway_key`` dependency behaviour under each gate state.
  - The ``GET /api/config/external-access`` and ``PUT`` handlers in
    ``app.routers.config``.
  - End-to-end protection of the ``/v1/*`` proxy routes via
    ``fastapi.testclient.TestClient``.

These tests use the existing ``isolatedData`` fixture from
``tests/conftest.py`` so they don't touch the user's real ``config.json``.
"""

from __future__ import annotations
import json
from pathlib import Path
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.lib.gateway_auth import require_gateway_key
from app.routers.config import router as configRouter
from app.routers.proxy import router as proxyRouter


@pytest.fixture(autouse=True)
def _resetGatewayKey(isolatedData, monkeypatch):
    """Reset the in-process ``settings.gatewayApiKey`` between tests.

    The ``isolatedData`` fixture provides a fresh data dir, but it doesn't
    touch the ``gatewayApiKey`` attribute on the Settings singleton. We
    reset it explicitly so each test starts from a known state.
    """
    from app.config import settings

    prev = settings.gatewayApiKey
    # Empty env blocks dotenv rehydrate on reload (override=False).
    monkeypatch.setenv('GATEWAY_API_KEY', '')
    settings.gatewayApiKey = None
    settings.reload()
    settings.gatewayApiKey = None
    yield
    settings.gatewayApiKey = prev
    settings.reload()


class TestRequireGatewayKey:
    """Behavioural coverage of the ``require_gateway_key`` dependency."""

    async def testDisabledReturns403WithNoHeader(self, isolatedData):
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization=None)
        assert exc.value.status_code == 403
        assert exc.value.detail['code'] == 'external_access_disabled'

    async def testDisabledReturns403EvenWithValidHeader(self, isolatedData):
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization='Bearer anything')
        assert exc.value.status_code == 403

    async def testEnabledWithoutKeyReturns503(self, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization='Bearer x')
        assert exc.value.status_code == 503
        assert exc.value.detail['code'] == 'gateway_key_unconfigured'

    async def testEnabledNoHeaderReturns401(self, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 's3cret'
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization=None)
        assert exc.value.status_code == 401
        assert exc.value.detail['code'] == 'auth_missing'
        assert exc.value.headers.get('WWW-Authenticate') == 'Bearer'

    async def testEnabledWrongKeyReturns401(self, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 's3cret'
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization='Bearer wrong')
        assert exc.value.status_code == 401
        assert exc.value.detail['code'] == 'auth_invalid_key'

    async def testEnabledMalformedHeaderReturns401(self, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 's3cret'
        with pytest.raises(HTTPException) as exc:
            await require_gateway_key(authorization='Basic s3cret')
        assert exc.value.status_code == 401

    async def testEnabledCorrectKeyReturnsTrue(self, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 's3cret'
        result = await require_gateway_key(authorization='Bearer s3cret')
        assert result is True

    async def testEnabledLowercaseBearerWorks(self, isolatedData):
        """Bearer is case-insensitive per RFC 7235."""
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 's3cret'
        result = await require_gateway_key(authorization='bearer s3cret')
        assert result is True


@pytest.fixture
def client(isolatedData):
    """A TestClient wired against the two routers we modified."""
    app = FastAPI()
    app.include_router(configRouter)
    app.include_router(proxyRouter)
    return TestClient(app)


class TestExternalAccessConfigEndpoint:
    """GET/PUT /api/config/external-access round-trips the toggle."""

    def testGetInitialState(self, client):
        r = client.get('/api/config/external-access')
        assert r.status_code == 200
        body = r.json()
        assert body['enabled'] is False
        assert body['hasKey'] is False
        assert body['keyPreview'] is None
        assert body['endpoints']['anthropic'].endswith('/v1/messages')
        assert body['endpoints']['openai'].endswith('/v1/chat/completions')
        assert body['endpoints']['models'].endswith('/v1/models')

    def testPutEnabledPersistsToConfigJson(self, client, isolatedData, monkeypatch):
        from app.config import settings

        settings.gatewayApiKey = 'top-secret'
        r = client.put('/api/config/external-access', json={'enabled': True})
        assert r.status_code == 200
        body = r.json()
        assert body['enabled'] is True
        assert body['hasKey'] is True
        assert body['keyPreview'] is not None
        assert 'top' in body['keyPreview']
        persisted = json.loads((Path(isolatedData) / 'config.json').read_text())
        assert persisted['gateway']['externalAccess']['enabled'] is True

    def testPutEnabledWithoutKeyReturns400(self, client):
        from app.config import settings

        settings.gatewayApiKey = None
        r = client.put('/api/config/external-access', json={'enabled': True})
        assert r.status_code == 400
        assert r.json()['detail']['code'] == 'no_api_key'

    def testPutDisabledClearsState(self, client, isolatedData):
        from app.config import settings

        settings.gatewayApiKey = 'top-secret'
        client.put('/api/config/external-access', json={'enabled': True})
        r = client.put('/api/config/external-access', json={'enabled': False})
        assert r.status_code == 200
        assert r.json()['enabled'] is False
        persisted = json.loads((Path(isolatedData) / 'config.json').read_text())
        assert persisted['gateway']['externalAccess']['enabled'] is False

    def testToggleSurvivesSettingsReload(self, client, isolatedData):
        from app.config import settings

        settings.gatewayApiKey = 'top-secret'
        client.put('/api/config/external-access', json={'enabled': True})
        settings.reload()
        r = client.get('/api/config/external-access')
        assert r.json()['enabled'] is True


class TestProxyRoutesAreProtected:
    """The full proxy stack rejects unauthenticated calls when required."""

    def testDisabledReturns403(self, client):
        r = client.get('/v1/models')
        assert r.status_code == 403

    def testEnabledNoHeaderReturns401(self, client, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.get('/v1/models')
        assert r.status_code == 401

    def testEnabledWrongKeyReturns401(self, client, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.get('/v1/models', headers={'Authorization': 'Bearer wrong'})
        assert r.status_code == 401

    def testEnabledCorrectKeyPassesAuthLayer(self, client, isolatedData):
        """When auth passes, the request enters the route — we don't assert
        the body (the provider/db isn't set up in the test), only that auth
        didn't short-circuit. Anything except 401/403 means auth passed."""
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.get('/v1/models', headers={'Authorization': 'Bearer top-secret'})
        assert r.status_code not in (401, 403)

    def testToggleOffKillsAccessEvenForValidKey(self, client, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': False}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.get('/v1/models', headers={'Authorization': 'Bearer top-secret'})
        assert r.status_code == 403


class TestProxyRequestBodyValidation:
    """Malformed request bodies should yield a clean 400, not a 500."""

    def testMessagesMalformedJsonReturns400(self, client, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.post(
            '/v1/messages',
            headers={'Authorization': 'Bearer top-secret', 'Content-Type': 'application/json'},
            content=b'{not valid json',
        )
        assert r.status_code == 400
        assert r.json()['error']['code'] == 'invalid_json'

    def testChatCompletionsMalformedJsonReturns400(self, client, isolatedData):
        _writeCfg(isolatedData, {'gateway': {'externalAccess': {'enabled': True}}})
        from app.config import settings

        settings.reload()
        settings.gatewayApiKey = 'top-secret'
        r = client.post(
            '/v1/chat/completions',
            headers={'Authorization': 'Bearer top-secret', 'Content-Type': 'application/json'},
            content=b'not json at all',
        )
        assert r.status_code == 400
        assert r.json()['error']['code'] == 'invalid_json'


def _writeCfg(dataDir, cfg):
    """Write a complete config.json into the isolated data dir."""
    Path(dataDir, 'config.json').write_text(json.dumps(cfg), encoding='utf-8')
