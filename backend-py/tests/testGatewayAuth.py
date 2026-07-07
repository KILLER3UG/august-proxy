"""Tests for the External API Gateway Access feature.

Covers:
  - The ``requireGatewayKey`` dependency behaviour under each gate state.
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

from app.lib.gatewayAuth import requireGatewayKey
from app.routers.config import router as configRouter
from app.routers.proxy import router as proxyRouter


@pytest.fixture(autouse=True)
def _resetGatewayKey(isolatedData):
    """Reset the in-process ``settings.gatewayApiKey`` between tests.

    The ``isolatedData`` fixture provides a fresh data dir, but it doesn't
    touch the ``gatewayApiKey`` attribute on the Settings singleton. We
    reset it explicitly so each test starts from a known state.
    """
    from app.config import settings
    prev = settings.gatewayApiKey
    settings.gatewayApiKey = None
    settings.reload()
    yield
    settings.gatewayApiKey = prev
    settings.reload()


# ── Auth dependency behaviour ──────────────────────────────────────────


class TestRequireGatewayKey:
    """Behavioural coverage of the ``requireGatewayKey`` dependency."""

    async def test_disabled_returns_403_with_no_header(self, isolatedData):
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization=None)
        assert exc.value.status_code == 403
        assert exc.value.detail["code"] == "external_access_disabled"

    async def test_disabled_returns_403_even_with_valid_header(self, isolatedData):
        # Even with a valid Bearer, closed-gateway rejects.
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization="Bearer anything")
        assert exc.value.status_code == 403

    async def test_enabled_without_key_returns_503(self, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        # No key set
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization="Bearer x")
        assert exc.value.status_code == 503
        assert exc.value.detail["code"] == "gateway_key_unconfigured"

    async def test_enabled_no_header_returns_401(self, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "s3cret"
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization=None)
        assert exc.value.status_code == 401
        assert exc.value.detail["code"] == "auth_missing"
        assert exc.value.headers.get("WWW-Authenticate") == "Bearer"

    async def test_enabled_wrong_key_returns_401(self, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "s3cret"
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization="Bearer wrong")
        assert exc.value.status_code == 401
        assert exc.value.detail["code"] == "auth_invalid_key"

    async def test_enabled_malformed_header_returns_401(self, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "s3cret"
        with pytest.raises(HTTPException) as exc:
            await requireGatewayKey(authorization="Basic s3cret")
        assert exc.value.status_code == 401

    async def test_enabled_correct_key_returns_true(self, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "s3cret"
        result = await requireGatewayKey(authorization="Bearer s3cret")
        assert result is True

    async def test_enabled_lowercase_bearer_works(self, isolatedData):
        """Bearer is case-insensitive per RFC 7235."""
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "s3cret"
        result = await requireGatewayKey(authorization="bearer s3cret")
        assert result is True


# ── Config endpoint behaviour ───────────────────────────────────────────


@pytest.fixture
def client(isolatedData):
    """A TestClient wired against the two routers we modified."""
    app = FastAPI()
    app.include_router(configRouter)
    app.include_router(proxyRouter)
    return TestClient(app)


class TestExternalAccessConfigEndpoint:
    """GET/PUT /api/config/external-access round-trips the toggle."""

    def test_get_initial_state(self, client):
        r = client.get("/api/config/external-access")
        assert r.status_code == 200
        body = r.json()
        assert body["enabled"] is False
        assert body["hasKey"] is False
        assert body["keyPreview"] is None
        assert body["endpoints"]["anthropic"].endswith("/v1/messages")
        assert body["endpoints"]["openai"].endswith("/v1/chat/completions")
        assert body["endpoints"]["models"].endswith("/v1/models")

    def test_put_enabled_persists_to_config_json(self, client, isolatedData, monkeypatch):
        from app.config import settings
        settings.gatewayApiKey = "top-secret"

        r = client.put("/api/config/external-access", json={"enabled": True})
        assert r.status_code == 200
        body = r.json()
        assert body["enabled"] is True
        assert body["hasKey"] is True
        assert body["keyPreview"] is not None
        assert "top" in body["keyPreview"]  # masked preview shows the start

        persisted = json.loads((Path(isolatedData) / "config.json").read_text())
        assert persisted["gateway"]["externalAccess"]["enabled"] is True

    def test_put_enabled_without_key_returns_400(self, client):
        from app.config import settings
        settings.gatewayApiKey = None  # explicit no-key
        r = client.put("/api/config/external-access", json={"enabled": True})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "no_api_key"

    def test_put_disabled_clears_state(self, client, isolatedData):
        from app.config import settings
        settings.gatewayApiKey = "top-secret"
        client.put("/api/config/external-access", json={"enabled": True})
        r = client.put("/api/config/external-access", json={"enabled": False})
        assert r.status_code == 200
        assert r.json()["enabled"] is False
        persisted = json.loads((Path(isolatedData) / "config.json").read_text())
        assert persisted["gateway"]["externalAccess"]["enabled"] is False

    def test_toggle_survives_settings_reload(self, client, isolatedData):
        from app.config import settings
        settings.gatewayApiKey = "top-secret"
        client.put("/api/config/external-access", json={"enabled": True})
        settings.reload()
        r = client.get("/api/config/external-access")
        assert r.json()["enabled"] is True


# ── End-to-end protection of /v1/* ──────────────────────────────────────


class TestProxyRoutesAreProtected:
    """The full proxy stack rejects unauthenticated calls when required."""

    def test_disabled_returns_403(self, client):
        r = client.get("/v1/models")
        assert r.status_code == 403

    def test_enabled_no_header_returns_401(self, client, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "top-secret"
        r = client.get("/v1/models")
        assert r.status_code == 401

    def test_enabled_wrong_key_returns_401(self, client, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "top-secret"
        r = client.get("/v1/models", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

    def test_enabled_correct_key_passes_auth_layer(self, client, isolatedData):
        """When auth passes, the request enters the route — we don't assert
        the body (the provider/db isn't set up in the test), only that auth
        didn't short-circuit. Anything except 401/403 means auth passed."""
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": True}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "top-secret"
        r = client.get("/v1/models", headers={"Authorization": "Bearer top-secret"})
        assert r.status_code not in (401, 403)

    def test_toggle_off_kills_access_even_for_valid_key(self, client, isolatedData):
        _writeCfg(isolatedData, {"gateway": {"externalAccess": {"enabled": False}}})
        from app.config import settings
        settings.reload()
        settings.gatewayApiKey = "top-secret"
        r = client.get("/v1/models", headers={"Authorization": "Bearer top-secret"})
        assert r.status_code == 403


# ── Helpers ────────────────────────────────────────────────────────────


def _writeCfg(dataDir, cfg):
    """Write a complete config.json into the isolated data dir."""
    Path(dataDir, "config.json").write_text(json.dumps(cfg), encoding="utf-8")
