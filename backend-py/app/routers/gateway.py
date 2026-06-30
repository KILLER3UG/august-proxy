"""Gateway API routes — webhook endpoints for platform adapters.

This module registers the Telegram adapter factory at import time (so it's
available when the gateway runner starts), and exposes the Telegram webhook
POST endpoint.
"""
from __future__ import annotations
import logging
from typing import Any
from fastapi import APIRouter, HTTPException, Request
from app.services.gateway.base import BasePlatformAdapter
from app.services.gateway.runner import GatewayRunner, registerAdapter
log = logging.getLogger(__name__)
try:
    from app.services.gateway.platforms.telegram import TelegramAdapter
    registerAdapter('telegram', lambda config=None, bridge=None: TelegramAdapter(config, bridge))
    log.debug('gateway: registered telegram adapter factory')
except ImportError:
    log.warning('gateway: telegram adapter not available (httpx?)')
try:
    from app.services.gateway.platforms.slack import SlackAdapter
    registerAdapter('slack', lambda config=None, bridge=None: SlackAdapter(config, bridge))
    log.debug('gateway: registered slack adapter factory')
except ImportError:
    log.warning('gateway: slack adapter not available (slack_sdk?)')
try:
    from app.services.gateway.platforms.discord import DiscordAdapter
    registerAdapter('discord', lambda config=None, bridge=None: DiscordAdapter(config, bridge))
    log.debug('gateway: registered discord adapter factory')
except ImportError:
    log.warning('gateway: discord adapter not available (discord.py?)')
router = APIRouter(prefix='/api/gateway')

def _getAdapter(request: Request, name: str) -> BasePlatformAdapter | None:
    runner: GatewayRunner | None = getattr(request.app.state, 'gateway_runner', None)
    if not runner:
        return None
    for a in runner.adapters:
        if a.platform == name:
            return a
    return None

@router.post('/telegram/webhook')
async def telegramWebhook(request: Request) -> dict[str, Any]:
    """Receive a Telegram update via webhook and dispatch to the adapter."""
    adapter = _getAdapter(request, 'telegram')
    if not adapter:
        raise HTTPException(status_code=503, detail='Telegram adapter not running')
    body = await request.json()
    await adapter.handle_incoming(body)
    return {'ok': True}

@router.get('/status')
async def gatewayStatus(request: Request) -> dict[str, Any]:
    """Return a summary of running gateway adapters."""
    runner: GatewayRunner | None = getattr(request.app.state, 'gateway_runner', None)
    if not runner:
        return {'enabled': False, 'adapters': []}
    return {'enabled': True, 'adapters': [{'platform': a.platform, 'connected': getattr(a, 'connected', False)} for a in runner.adapters]}