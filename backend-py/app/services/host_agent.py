"""Host agent bridge — communicates with the host OS agent process.

Port of backend/lib/host-agent.js.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


async def get_host_info() -> dict[str, Any]:
    base_url = os.environ.get("AUGUST_HOST_AGENT_URL", "")
    if not base_url:
        return {"available": False, "reason": "AUGUST_HOST_AGENT_URL not set"}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{base_url}/health")
            return {"available": True, "status": resp.json() if resp.status_code == 200 else {"error": resp.text}}
    except httpx.RequestError as exc:
        return {"available": False, "error": str(exc)}


async def execute_host_command(command: str, args: list[str] | None = None) -> dict[str, Any]:
    base_url = os.environ.get("AUGUST_HOST_AGENT_URL", "")
    if not base_url:
        return {"error": "Host agent not available"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{base_url}/execute", json={"command": command, "args": args or []})
            return resp.json() if resp.status_code == 200 else {"error": resp.text}
    except httpx.RequestError as exc:
        return {"error": str(exc)}
