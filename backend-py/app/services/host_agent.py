"""Host agent bridge — communicates with the host OS agent process.

Port of backend/lib/host-agent.js.
"""

from __future__ import annotations
import os
import httpx


async def getHostInfo() -> dict[str, object]:
    """Host-agent health shaped for both simple status and HostAgentHealth UI.

    When the URL is unset, reports ``local_desktop`` if local automation is
    importable; computer-use tools stay available locally. When URL is set
    but unreachable, status is disconnected so the UI can hide computer-use.
    """
    from datetime import datetime, timezone

    at = datetime.now(timezone.utc).isoformat()
    baseUrl = os.environ.get('AUGUST_HOST_AGENT_URL', '')
    from app.services.post_observation import count_observations, latest_observation_meta

    obs_meta = latest_observation_meta()
    base = {
        'lastComputerActionAt': None,
        'lastComputerAction': None,
        'lastComputerTarget': None,
        'lastObservationAt': obs_meta.get('lastObservationAt'),
        'lastObservedApp': obs_meta.get('lastObservedApp'),
        'postObservationCount': count_observations(),
        'at': at,
        'computerUseEnabled': False,
    }
    if not baseUrl:
        local_ok = False
        try:
            import app.services.desktop_automation  # noqa: F401

            local_ok = True
        except Exception:
            local_ok = False
        return {
            **base,
            'available': local_ok,
            'status': 'local_desktop' if local_ok else 'disconnected',
            'reason': (
                'No AUGUST_HOST_AGENT_URL; using local desktop automation'
                if local_ok
                else 'AUGUST_HOST_AGENT_URL not set and local desktop unavailable'
            ),
            'computerUseEnabled': local_ok,
            'mode': 'local' if local_ok else 'off',
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
                    'computerUseEnabled': True,
                    'mode': 'remote',
                }
            return {
                **base,
                'available': False,
                'status': 'error',
                'error': resp.text,
                'computerUseEnabled': False,
                'mode': 'remote',
            }
    except httpx.RequestError as exc:
        return {
            **base,
            'available': False,
            'status': 'error',
            'error': str(exc),
            'computerUseEnabled': False,
            'mode': 'remote',
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
