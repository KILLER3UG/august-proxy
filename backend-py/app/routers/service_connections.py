"""Service connections + MCP global env API.

  GET    /api/service-connections
  POST   /api/service-connections/github
  POST   /api/service-connections/slack
  POST   /api/service-connections/google
  POST   /api/service-connections/google/auth
  GET    /api/service-connections/google/callback
  DELETE /api/service-connections/{name}

  GET/POST /api/mcp-env
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse

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
    # gmail | calendar | drive — limits OAuth scopes to that service.
    facet: str = 'gmail'


class McpEnvBody(CamelModel):
    env: list[dict[str, str]] | dict[str, str] = []
    merge: bool = False


@router.get('/api/service-connections')
async def list_service_connections():
    return sc.list_connections()


@router.post('/api/service-connections/github')
async def post_github(body: GithubBody):
    return sc.connect_github(body.token)


@router.post('/api/service-connections/slack')
async def post_slack(body: SlackBody):
    return sc.connect_slack(body.bot_token, body.team_id)


class GithubTestBody(CamelModel):
    token: str = ''


class SlackTestBody(CamelModel):
    bot_token: str = ''
    channel: str = ''


@router.post('/api/service-connections/github/test')
async def test_github(body: GithubTestBody):
    """Validate PAT (or stored token) against api.github.com/user."""
    return await sc.test_github(body.token or None)


@router.post('/api/service-connections/slack/test')
async def test_slack(body: SlackTestBody):
    """Validate bot token via auth.test; optional channel for test send."""
    return await sc.test_slack(body.bot_token or None, channel=body.channel or '')


@router.get('/api/service-connections/github/scopes')
async def github_scopes():
    meta = sc.SERVICE_META.get('github') or {}
    return {
        'provider': 'github',
        'scopes': meta.get('scopes') or [],
        'helpUrl': 'https://github.com/settings/tokens',
        'guide': [
            'Open GitHub → Settings → Developer settings → Personal access tokens',
            'Create a classic or fine-grained token',
            'Enable the scopes below (repo for private code, read:user for identity)',
            'Paste the token and run Test connection',
        ],
    }


@router.get('/api/service-connections/slack/scopes')
async def slack_scopes():
    meta = sc.SERVICE_META.get('slack') or {}
    return {
        'provider': 'slack',
        'scopes': meta.get('scopes') or [],
        'helpUrl': 'https://api.slack.com/apps',
        'guide': [
            'Create or open a Slack app at api.slack.com/apps',
            'OAuth & Permissions → Bot Token Scopes — add the checklist below',
            'Install to workspace and copy the Bot User OAuth Token (xoxb-…)',
            'Paste token, optional team id, then Test (and optional test send channel)',
        ],
    }


@router.post('/api/service-connections/google')
async def post_google(body: GoogleBody):
    return sc.connect_google(body.email)


@router.post('/api/service-connections/google/auth')
async def post_google_auth(body: GoogleAuthBody):
    return await sc.google_auth_url(body.email, facet=body.facet or 'gmail')


@router.get('/api/service-connections/google/callback')
async def google_oauth_callback(
    code: str = Query(default=''),
    state: str = Query(default=''),
    error: str = Query(default=''),
):
    """Browser redirect target after Google consent — exchanges code and shows HTML."""
    result = await sc.google_oauth_callback(code=code, state=state, error=error)
    html = str(result.get('html') or '')
    status = 200 if result.get('ok') else 400
    return HTMLResponse(content=html, status_code=status)


@router.delete('/api/service-connections/{name}')
async def delete_connection(
    name: str,
    facet: str = Query(default=''),
):
    try:
        return sc.disconnect(name, facet=facet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/api/mcp-env')
async def get_mcp_env():
    return sc.get_mcp_env()


@router.post('/api/mcp-env')
async def post_mcp_env(body: McpEnvBody):
    return sc.set_mcp_env(body.env, merge=bool(body.merge))
