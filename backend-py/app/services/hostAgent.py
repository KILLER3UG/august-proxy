"""Host agent bridge — communicates with the host OS agent process.

Port of backend/lib/host-agent.js.
"""
from __future__ import annotations
import os
import httpx

async def getHostInfo() -> dict[str, object]:
    baseUrl = os.environ.get('AUGUST_HOST_AGENT_URL', '')
    if not baseUrl:
        return {'available': False, 'reason': 'AUGUST_HOST_AGENT_URL not set'}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f'{baseUrl}/health')
            return {'available': True, 'status': resp.json() if resp.status_code == 200 else {'error': resp.text}}
    except httpx.RequestError as exc:
        return {'available': False, 'error': str(exc)}

async def executeHostCommand(command: str, args: list[str] | None=None) -> dict[str, object]:
    baseUrl = os.environ.get('AUGUST_HOST_AGENT_URL', '')
    if not baseUrl:
        return {'error': 'Host agent not available'}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f'{baseUrl}/execute', json={'command': command, 'args': args or []})
            return resp.json() if resp.status_code == 200 else {'error': resp.text}
    except httpx.RequestError as exc:
        return {'error': str(exc)}