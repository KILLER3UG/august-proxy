"""Host agent bridge — communicates with the host OS agent process.

Port of backend/lib/host-agent.js.
"""

from __future__ import annotations
import os
import httpx


async def getHostInfo() -> dict[str, object]:
    """Host-agent health shaped for both simple status and HostAgentHealth UI."""
    from datetime import datetime, timezone

    at = datetime.now(timezone.utc).isoformat()
    baseUrl = os.environ.get('AUGUST_HOST_AGENT_URL', '')
    base = {
        'lastComputerActionAt': None,
        'lastComputerAction': None,
        'lastComputerTarget': None,
        'lastObservationAt': None,
        'lastObservedApp': None,
        'postObservationCount': 0,
        'at': at,
    }
    if not baseUrl:
        return {
            **base,
            'available': False,
            'status': 'disconnected',
            'reason': 'AUGUST_HOST_AGENT_URL not set',
        }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f'{baseUrl}/health')
            if resp.status_code == 200:
                payload = resp.json() if resp.headers.get('content-type', '').startswith('application/json') else {}
                if not isinstance(payload, dict):
                    payload = {}
                return {
                    **base,
                    **payload,
                    'available': True,
                    'status': payload.get('status') or 'connected',
                }
            return {
                **base,
                'available': False,
                'status': 'error',
                'error': resp.text,
            }
    except httpx.RequestError as exc:
        return {
            **base,
            'available': False,
            'status': 'error',
            'error': str(exc),
        }


async def executeHostCommand(command: str, args: list[str] | None = None) -> dict[str, object]:
    baseUrl = os.environ.get('AUGUST_HOST_AGENT_URL', '')
    if not baseUrl:
        return {'error': 'Host agent not available'}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f'{baseUrl}/execute', json={'command': command, 'args': args or []})
            return resp.json() if resp.status_code == 200 else {'error': resp.text}
    except httpx.RequestError as exc:
        return {'error': str(exc)}
