"""Gateway API routes — webhook endpoints for platform adapters."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from app.services.gateway.base import BasePlatformAdapter
from app.services.gateway.runner import GatewayRunner, registerAdapter

log = logging.getLogger(__name__)

_PLATFORM_AVAILABILITY: dict[str, dict[str, object]] = {
    'telegram': {'available': False, 'reason': 'not registered'},
    'slack': {
        'available': False,
        'reason': 'slack_sdk not installed — pip install -e ".[gateway]"',
    },
    'discord': {
        'available': False,
        'reason': 'discord.py not installed — pip install -e ".[gateway]"',
    },
}

try:
    from app.services.gateway.platforms.telegram import TelegramAdapter

    registerAdapter('telegram', lambda config=None, bridge=None: TelegramAdapter(config, bridge))
    _PLATFORM_AVAILABILITY['telegram'] = {'available': True, 'reason': ''}
    log.debug('gateway: registered telegram adapter factory')
except ImportError:
    _PLATFORM_AVAILABILITY['telegram'] = {
        'available': False,
        'reason': 'telegram adapter import failed (httpx?)',
    }
    log.warning('gateway: telegram adapter not available (httpx?)')
try:
    from app.services.gateway.platforms.slack import SlackAdapter

    registerAdapter('slack', lambda config=None, bridge=None: SlackAdapter(config, bridge))
    _PLATFORM_AVAILABILITY['slack'] = {'available': True, 'reason': ''}
    log.debug('gateway: registered slack adapter factory')
except ImportError:
    log.warning(
        'gateway: slack adapter not available (slack_sdk?). '
        'Install optional extra: pip install -e ".[gateway]"'
    )
try:
    from app.services.gateway.platforms.discord import DiscordAdapter

    registerAdapter('discord', lambda config=None, bridge=None: DiscordAdapter(config, bridge))
    _PLATFORM_AVAILABILITY['discord'] = {'available': True, 'reason': ''}
    log.debug('gateway: registered discord adapter factory')
except ImportError:
    log.warning(
        'gateway: discord adapter not available (discord.py?). '
        'Install optional extra: pip install -e ".[gateway]"'
    )
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
async def telegramWebhook(request: Request) -> dict[str, object]:
    """Receive a Telegram update via webhook and dispatch to the adapter."""
    adapter = _getAdapter(request, 'telegram')
    if not adapter:
        raise HTTPException(status_code=503, detail='Telegram adapter not running')
    body = await request.json()
    await adapter.handleIncoming(body)
    return {'ok': True}


@router.get('/status')
async def gatewayStatus(request: Request) -> dict[str, object]:
    """Return running adapters and optional-SDK availability."""
    runner: GatewayRunner | None = getattr(request.app.state, 'gateway_runner', None)
    running = []
    if runner:
        running = [
            {'platform': a.platform, 'connected': getattr(a, 'connected', False)} for a in runner.adapters
        ]
    platforms = [
        {
            'platform': name,
            'available': bool(info.get('available')),
            'reason': str(info.get('reason') or ''),
            'running': any(r.get('platform') == name for r in running),
        }
        for name, info in _PLATFORM_AVAILABILITY.items()
    ]
    return {
        'enabled': bool(runner),
        'adapters': running,
        'platforms': platforms,
        'installHint': 'pip install -e ".[gateway]"  # discord.py + slack_sdk',
    }
