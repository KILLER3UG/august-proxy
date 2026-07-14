"""Service connections + MCP global env API.

  GET    /api/service-connections
  POST   /api/service-connections/github
  POST   /api/service-connections/slack
  POST   /api/service-connections/google
  POST   /api/service-connections/google/auth
  DELETE /api/service-connections/{name}

  GET/POST /api/mcp-env
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services import service_connections as sc

router = APIRouter()


class GithubBody(CamelModel):
    token: str = ''


class SlackBody(CamelModel):
    bot_token: str = ''
    team_id: str = ''


class GoogleBody(CamelModel):
    email: str = ''


class GoogleAuthBody(CamelModel):
    email: str = ''


class McpEnvBody(CamelModel):
    env: list[dict[str, str]] | dict[str, str] = []


@router.get('/api/service-connections')
async def list_service_connections():
    return sc.list_connections()


@router.post('/api/service-connections/github')
async def post_github(body: GithubBody):
    return sc.connect_github(body.token)


@router.post('/api/service-connections/slack')
async def post_slack(body: SlackBody):
    return sc.connect_slack(body.bot_token, body.team_id)


@router.post('/api/service-connections/google')
async def post_google(body: GoogleBody):
    return sc.connect_google(body.email)


@router.post('/api/service-connections/google/auth')
async def post_google_auth(body: GoogleAuthBody):
    return await sc.google_auth_url(body.email)


@router.delete('/api/service-connections/{name}')
async def delete_connection(name: str):
    try:
        return sc.disconnect(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/api/mcp-env')
async def get_mcp_env():
    return sc.get_mcp_env()


@router.post('/api/mcp-env')
async def post_mcp_env(body: McpEnvBody):
    return sc.set_mcp_env(body.env)
