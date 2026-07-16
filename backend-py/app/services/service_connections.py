"""Service connection credentials (Google / GitHub / Slack) stored in config.json."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

import httpx

from app.json_narrowing import as_dict, as_str
from app.services.config_service import getConfig, saveConfig

# Pending native OAuth states: state -> {created, email, redirect_uri}
_oauth_pending: dict[str, dict[str, Any]] = {}
_OAUTH_STATE_TTL_S = 15 * 60

SERVICE_META: dict[str, dict[str, Any]] = {
    'google': {
        'label': 'Google Workspace',
        'description': 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts.',
        'services': [
            'Gmail read',
            'Gmail send',
            'Calendar',
            'Drive',
            'Docs',
            'Sheets',
            'Slides',
            'Tasks',
            'Contacts',
        ],
        'scopes': [
            'gmail.read',
            'gmail.send',
            'calendar',
            'drive',
            'docs',
            'sheets',
            'slides',
            'tasks',
            'contacts',
        ],
    },
    'github': {
        'label': 'GitHub',
        'description': 'Repositories, issues, pull requests, and code search.',
        'services': ['Repositories', 'Pull requests', 'Issues', 'Gists'],
        'scopes': ['repo', 'read:user', 'workflow', 'gist'],
    },
    'slack': {
        'label': 'Slack',
        'description': 'Channels, messages, threads, and reactions.',
        'services': ['Channels', 'Messages', 'Files', 'Workspace'],
        # Bot token scopes checklist (OAuth / app config)
        'scopes': [
            'channels:history',
            'channels:read',
            'chat:write',
            'users:read',
            'files:read',
            'groups:history',
            'im:history',
            'mpim:history',
        ],
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sc() -> dict[str, Any]:
    cfg = getConfig()
    raw = cfg.get('serviceConnections')
    return as_dict(raw) if raw is not None else {}


def _save_sc(sc: dict[str, Any]) -> None:
    cfg = getConfig()
    cfg['serviceConnections'] = sc
    saveConfig(cfg)
    try:
        from app.config import settings

        settings.reload()
    except Exception:
        pass


def _mask(token: str) -> str:
    if len(token) <= 8:
        return '****'
    return f'{token[:4]}…{token[-4:]}'


def _google_card(raw: dict[str, Any] | None) -> dict[str, Any]:
    meta = SERVICE_META['google']
    email = as_str((raw or {}).get('email') or (raw or {}).get('account'))
    has_client = bool(_google_client_id())
    has_oauth = has_client or bool(
        (raw or {}).get('refreshToken') or (raw or {}).get('tokens')
    )
    connected = bool(email) or bool((raw or {}).get('status') == 'connected')
    missing = not has_oauth and not connected
    status = 'connected' if connected else ('needs_config' if missing else 'disconnected')
    return {
        'name': 'google',
        'label': meta['label'],
        'description': meta['description'],
        'services': meta['services'],
        'scopes': meta['scopes'],
        'status': status,
        'connected': connected,
        'account': email or None,
        'email': email or None,
        'displayName': as_str((raw or {}).get('displayName') or (raw or {}).get('name')) or None,
        'picture': as_str((raw or {}).get('picture')) or None,
        'googleSub': as_str((raw or {}).get('googleSub') or (raw or {}).get('sub')) or None,
        'missingConfig': missing and not connected,
        'hasClientId': has_client,
        'pkceReady': has_client,  # one-click browser sign-in when client id is set
        'redirectUri': _google_redirect_uri() if has_client or missing else None,
        'updatedAt': (raw or {}).get('updatedAt'),
    }


def _github_card(raw: dict[str, Any] | None) -> dict[str, Any]:
    meta = SERVICE_META['github']
    token = as_str((raw or {}).get('token') or os.environ.get('GITHUB_TOKEN', ''))
    connected = bool(token)
    return {
        'name': 'github',
        'label': meta['label'],
        'description': meta['description'],
        'services': meta['services'],
        'scopes': meta['scopes'],
        'status': 'connected' if connected else 'disconnected',
        'connected': connected,
        'maskedToken': _mask(token) if token else None,
        'account': (raw or {}).get('account') or (raw or {}).get('login'),
        'updatedAt': (raw or {}).get('updatedAt'),
    }


def _slack_card(raw: dict[str, Any] | None) -> dict[str, Any]:
    meta = SERVICE_META['slack']
    token = as_str((raw or {}).get('botToken') or os.environ.get('SLACK_BOT_TOKEN', ''))
    team_id = as_str((raw or {}).get('teamId') or os.environ.get('SLACK_TEAM_ID', ''))
    connected = bool(token)
    return {
        'name': 'slack',
        'label': meta['label'],
        'description': meta['description'],
        'services': meta['services'],
        'scopes': meta['scopes'],
        'status': 'connected' if connected else 'disconnected',
        'connected': connected,
        'maskedToken': _mask(token) if token else None,
        'teamId': team_id or None,
        'updatedAt': (raw or {}).get('updatedAt'),
    }


def list_connections() -> dict[str, Any]:
    sc = _sc()
    return {
        'connections': {
            'google': _google_card(as_dict(sc.get('google')) if sc.get('google') else None),
            'github': _github_card(as_dict(sc.get('github')) if sc.get('github') else None),
            'slack': _slack_card(as_dict(sc.get('slack')) if sc.get('slack') else None),
        }
    }


def connect_github(token: str) -> dict[str, Any]:
    sc = _sc()
    if token.strip():
        sc['github'] = {'token': token.strip(), 'status': 'connected', 'updatedAt': _now()}
        os.environ['GITHUB_TOKEN'] = token.strip()
    else:
        sc.pop('github', None)
        os.environ.pop('GITHUB_TOKEN', None)
    _save_sc(sc)
    return {'status': 'ok', 'connection': _github_card(as_dict(sc.get('github')) if sc.get('github') else None)}


def connect_slack(bot_token: str, team_id: str = '') -> dict[str, Any]:
    sc = _sc()
    if bot_token.strip():
        sc['slack'] = {
            'botToken': bot_token.strip(),
            'teamId': team_id.strip(),
            'status': 'connected',
            'updatedAt': _now(),
        }
        os.environ['SLACK_BOT_TOKEN'] = bot_token.strip()
        if team_id.strip():
            os.environ['SLACK_TEAM_ID'] = team_id.strip()
    else:
        sc.pop('slack', None)
        os.environ.pop('SLACK_BOT_TOKEN', None)
    _save_sc(sc)
    return {'status': 'ok', 'connection': _slack_card(as_dict(sc.get('slack')) if sc.get('slack') else None)}


async def test_github(token: str | None = None) -> dict[str, Any]:
    """Validate a GitHub PAT via GET /user. Uses stored token when token is empty."""
    tok = (token or '').strip()
    if not tok:
        sc = _sc()
        raw = as_dict(sc.get('github')) if sc.get('github') else {}
        tok = as_str(raw.get('token') or os.environ.get('GITHUB_TOKEN', ''))
    if not tok:
        return {'ok': False, 'error': 'No GitHub token configured'}
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            res = await client.get(
                'https://api.github.com/user',
                headers={
                    'Authorization': f'Bearer {tok}',
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            )
            if res.status_code >= 400:
                return {
                    'ok': False,
                    'error': f'GitHub API {res.status_code}: {res.text[:200]}',
                }
            data = res.json()
            login = as_str(data.get('login'))
            # Persist login when testing stored connection
            if login and not (token or '').strip():
                sc = _sc()
                gh = as_dict(sc.get('github')) if sc.get('github') else {}
                gh['account'] = login
                gh['updatedAt'] = _now()
                sc['github'] = gh
                _save_sc(sc)
            scopes = res.headers.get('x-oauth-scopes') or res.headers.get('X-OAuth-Scopes') or ''
            return {
                'ok': True,
                'login': login,
                'name': as_str(data.get('name')),
                'scopes': [s.strip() for s in scopes.split(',') if s.strip()],
                'detail': f'Authenticated as @{login}' if login else 'Token valid',
            }
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


async def test_slack(bot_token: str | None = None, channel: str = '') -> dict[str, Any]:
    """Validate Slack bot token via auth.test; optional chat.postMessage test send."""
    tok = (bot_token or '').strip()
    if not tok:
        sc = _sc()
        raw = as_dict(sc.get('slack')) if sc.get('slack') else {}
        tok = as_str(raw.get('botToken') or os.environ.get('SLACK_BOT_TOKEN', ''))
    if not tok:
        return {'ok': False, 'error': 'No Slack bot token configured'}
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            res = await client.post(
                'https://slack.com/api/auth.test',
                headers={'Authorization': f'Bearer {tok}'},
            )
            data = res.json() if res.status_code < 500 else {}
            if not data.get('ok'):
                return {
                    'ok': False,
                    'error': as_str(data.get('error') or f'HTTP {res.status_code}'),
                }
            result: dict[str, Any] = {
                'ok': True,
                'team': as_str(data.get('team')),
                'user': as_str(data.get('user')),
                'teamId': as_str(data.get('team_id')),
                'detail': f"Connected as {data.get('user')} on {data.get('team')}",
            }
            ch = (channel or '').strip()
            if ch:
                send = await client.post(
                    'https://slack.com/api/chat.postMessage',
                    headers={'Authorization': f'Bearer {tok}'},
                    json={
                        'channel': ch,
                        'text': 'August connectivity test — you can ignore this message.',
                    },
                )
                sdata = send.json() if send.status_code < 500 else {}
                if sdata.get('ok'):
                    result['testSend'] = True
                    result['detail'] = f"{result['detail']} · test message sent to {ch}"
                else:
                    result['testSend'] = False
                    result['testSendError'] = as_str(sdata.get('error') or 'send failed')
            return result
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def connect_google(email: str = '') -> dict[str, Any]:
    sc = _sc()
    existing = as_dict(sc.get('google')) if sc.get('google') else {}
    sc['google'] = {
        **existing,
        'email': email.strip() or existing.get('email') or None,
        'status': 'connected' if (email.strip() or existing.get('refreshToken') or existing.get('email')) else 'disconnected',
        'updatedAt': _now(),
    }
    if email.strip() or existing.get('refreshToken') or existing.get('email'):
        sc['google']['status'] = 'connected'
    _save_sc(sc)
    return {'status': 'ok', 'connection': _google_card(as_dict(sc.get('google')))}


def _mcp_global_env_map() -> dict[str, str]:
    try:
        cfg = getConfig()
        raw = as_dict(cfg.get('mcpGlobalEnv')) if cfg.get('mcpGlobalEnv') is not None else {}
        return {str(k): str(v) for k, v in raw.items() if str(k).strip()}
    except Exception:
        return {}


def _google_client_id() -> str:
    """Resolve OAuth client id: user env → MCP env → optional product default."""
    return (
        os.environ.get('GOOGLE_OAUTH_CLIENT_ID')
        or os.environ.get('GOOGLE_CLIENT_ID')
        or _mcp_global_env_map().get('GOOGLE_OAUTH_CLIENT_ID')
        or _mcp_global_env_map().get('GOOGLE_CLIENT_ID')
        # Optional ship-time public Desktop client (PKCE, no secret).
        or os.environ.get('AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID')
        or _mcp_global_env_map().get('AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID')
        or ''
    ).strip()


def _google_client_secret() -> str:
    return (
        os.environ.get('GOOGLE_OAUTH_CLIENT_SECRET')
        or os.environ.get('GOOGLE_CLIENT_SECRET')
        or _mcp_global_env_map().get('GOOGLE_OAUTH_CLIENT_SECRET')
        or _mcp_global_env_map().get('GOOGLE_CLIENT_SECRET')
        or ''
    ).strip()


def _pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for OAuth PKCE S256."""
    # 64 url-safe bytes → ~86 chars (within 43–128)
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode('ascii')).digest()
    challenge = base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')
    return verifier, challenge


def _google_redirect_uri() -> str:
    explicit = (
        os.environ.get('GOOGLE_OAUTH_REDIRECT_URI')
        or _mcp_global_env_map().get('GOOGLE_OAUTH_REDIRECT_URI')
        or ''
    ).strip()
    if explicit:
        return explicit
    try:
        from app.config import settings

        port = int(getattr(settings, 'port', 8085) or 8085)
    except Exception:
        port = int(os.environ.get('AUGUST_PROXY_PORT', '8085'))
    return f'http://127.0.0.1:{port}/api/service-connections/google/callback'


def _purge_stale_oauth_states() -> None:
    now = time.time()
    dead = [k for k, v in _oauth_pending.items() if now - float(v.get('created', 0)) > _OAUTH_STATE_TTL_S]
    for k in dead:
        _oauth_pending.pop(k, None)


def _native_google_auth_url(user_email: str = '') -> dict[str, Any] | None:
    """Build browser OAuth URL with CSRF state + PKCE.

    Works with:
    - **Desktop / public clients** (client id only + PKCE, no secret)
    - **Web / confidential clients** (client id + secret; PKCE still sent)
    """
    client_id = _google_client_id()
    if not client_id:
        return None
    _purge_stale_oauth_states()
    redirect = _google_redirect_uri()
    state = secrets.token_urlsafe(24)
    verifier, challenge = _pkce_pair()
    _oauth_pending[state] = {
        'created': time.time(),
        'email': user_email,
        'redirect_uri': redirect,
        'code_verifier': verifier,
        'pkce': True,
    }
    scopes = [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive.readonly',
    ]
    params: dict[str, str] = {
        'client_id': client_id,
        'redirect_uri': redirect,
        'response_type': 'code',
        'scope': ' '.join(scopes),
        'access_type': 'offline',
        'prompt': 'consent',
        'include_granted_scopes': 'true',
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    }
    if user_email and user_email != 'me':
        params['login_hint'] = user_email
    auth_url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
    has_secret = bool(_google_client_secret())
    return {
        'authUrl': auth_url,
        'message': (
            'Open Google sign-in in your browser to connect Gmail / Calendar / Drive.'
            + ('' if has_secret else ' Using secure one-click PKCE (no client secret required).')
        ),
        'pkce': True,
        'needsSecret': not has_secret,
    }


def _mcp_auth_url_uses_august_callback(auth_url: str) -> bool:
    """True when an MCP-built Google URL redirects into August's callback.

    Those URLs carry MCP's own PKCE challenge; August does not have the
    verifier, so exchanging the code here always fails with missing_code_verifier.
    """
    if not auth_url:
        return False
    try:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(auth_url).query)
        redirect = urllib.parse.unquote((q.get('redirect_uri') or [''])[0])
    except Exception:
        return False
    ours = _google_redirect_uri()
    if not redirect:
        return False
    return redirect.rstrip('/') == ours.rstrip('/') or '/api/service-connections/google/callback' in redirect


async def google_auth_url(email: str = '') -> dict[str, Any]:
    """Start Google OAuth.

    Prefer August's native PKCE flow whenever a Client ID is configured.
    MCP ``start_google_auth`` URLs that bounce to August's callback cannot
    complete token exchange (Missing code verifier) — never return those.
    """
    sc = _sc()
    stored_email = as_str(as_dict(sc.get('google')).get('email')) if sc.get('google') else ''
    user_email = email.strip() or stored_email or ''

    # 1) Native Google OAuth (stores PKCE verifier for our callback)
    native = _native_google_auth_url(user_email)
    if native:
        return {**native, 'via': 'native'}

    # 2) MCP probe only when native is unavailable (no client id) — and only
    #    if workspace-mcp actually exposes start_google_auth (complete tier).
    #    Core-tier installs omit that tool; never call a missing tool.
    try:
        from app.services.tools import mcp_client

        for srv in list(mcp_client.listRegisteredServers()):
            sid = as_str(srv.get('id'))
            if not sid:
                continue
            try:
                await mcp_client.discoverTools(sid)
            except Exception:
                pass

        server_id = mcp_client.find_server_for_tool('start_google_auth')
        if server_id:
            # Call the underlying MCP tool directly (not executeMcpToolCall),
            # which intercepts start_google_auth and would recurse to native.
            text = str(
                await mcp_client.executeTool(
                    server_id,
                    'start_google_auth',
                    {
                        'service_name': 'gmail,calendar,drive,docs,sheets,slides,tasks,contacts',
                        'user_google_email': user_email or 'me',
                    },
                )
            )
            lower = text.lower()
            # FastMCP may return "Unknown tool" as content (no Error: prefix).
            if (
                text.startswith('Error:')
                or 'unknown tool' in lower
                or 'tool not found' in lower
            ):
                pass
            else:
                import re

                match = re.search(r'https://[^\s"\'<>]+', text)
                if match:
                    mcp_url = match.group(0)
                    if _mcp_auth_url_uses_august_callback(mcp_url):
                        # Would break PKCE — surface config help instead.
                        pass
                    else:
                        return {'authUrl': mcp_url, 'message': text, 'via': 'mcp'}
                if any(
                    phrase in lower
                    for phrase in (
                        'already authenticated',
                        'already authorized',
                        'credentials found',
                        'successfully authenticated',
                        'authentication successful',
                    )
                ):
                    connect_google(user_email if user_email and user_email != 'me' else '')
                    return {
                        'authUrl': '',
                        'message': text,
                        'connected': True,
                        'via': 'mcp',
                    }
    except Exception:
        pass

    return {
        'authUrl': '',
        'needsClientId': True,
        'message': (
            'Add a Google OAuth Client ID to sign in with one click. '
            'Create a Desktop app in Google Cloud Console (PKCE — secret optional), '
            'set GOOGLE_OAUTH_CLIENT_ID in Settings → Integrations, then try again. '
            'Redirect URI: '
            + _google_redirect_uri()
        ),
    }


async def google_oauth_callback(code: str = '', state: str = '', error: str = '') -> dict[str, Any]:
    """Handle Google OAuth redirect: exchange code (PKCE and/or secret), store tokens."""
    if error:
        return {
            'ok': False,
            'error': error,
            'html': _oauth_result_html(False, f'Google returned an error: {error}'),
        }
    if not code.strip():
        return {
            'ok': False,
            'error': 'missing_code',
            'html': _oauth_result_html(False, 'Missing authorization code.'),
        }

    _purge_stale_oauth_states()
    pending = _oauth_pending.pop(state, None) if state else None
    # Allow missing state in dev if only one pending (desktop loopback quirks)
    if pending is None and len(_oauth_pending) == 1:
        _, pending = _oauth_pending.popitem()

    client_id = _google_client_id()
    client_secret = _google_client_secret()
    code_verifier = as_str((pending or {}).get('code_verifier'))
    if not client_id:
        return {
            'ok': False,
            'error': 'missing_client',
            'html': _oauth_result_html(
                False,
                'GOOGLE_OAUTH_CLIENT_ID is not configured on the August server.',
            ),
        }
    # Never invent a pending session without a verifier — Google returns
    # invalid_grant "Missing code verifier" when the auth URL used PKCE
    # (August native + most MCP flows) but we omit the verifier here.
    if not code_verifier:
        return {
            'ok': False,
            'error': 'missing_pkce_or_secret',
            'html': _oauth_result_html(
                False,
                'OAuth session expired or this sign-in was not started from August. '
                'Close this window and click Sign in with Google in Settings → Integrations '
                '(or ask the agent again after signing in there). '
                'Do not use an MCP auth link that redirects to August — that skips PKCE.',
            ),
        }

    redirect_uri = as_str((pending or {}).get('redirect_uri')) or _google_redirect_uri()
    token_body: dict[str, str] = {
        'code': code.strip(),
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'grant_type': 'authorization_code',
    }
    if client_secret:
        token_body['client_secret'] = client_secret
    if code_verifier:
        token_body['code_verifier'] = code_verifier

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            token_res = await client.post(
                'https://oauth2.googleapis.com/token',
                data=token_body,
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
            )
            if token_res.status_code >= 400:
                detail = token_res.text[:400]
                return {
                    'ok': False,
                    'error': 'token_exchange_failed',
                    'html': _oauth_result_html(
                        False,
                        f'Token exchange failed ({token_res.status_code}). '
                        f'Use a Desktop OAuth client with PKCE, or a Web client with secret. '
                        f'Redirect URI must be exactly: {redirect_uri}. {detail}',
                    ),
                }
            tokens = token_res.json()
            access_token = as_str(tokens.get('access_token'))
            refresh_token = as_str(tokens.get('refresh_token'))
            email = as_str((pending or {}).get('email'))
            display_name = ''
            picture = ''
            google_sub = ''
            if access_token:
                try:
                    ui = await client.get(
                        'https://www.googleapis.com/oauth2/v2/userinfo',
                        headers={'Authorization': f'Bearer {access_token}'},
                    )
                    if ui.status_code < 400:
                        profile = ui.json()
                        email = as_str(profile.get('email')) or email
                        display_name = as_str(profile.get('name')) or as_str(profile.get('given_name'))
                        picture = as_str(profile.get('picture'))
                        google_sub = as_str(profile.get('id')) or as_str(profile.get('sub'))
                except Exception:
                    pass
    except Exception as exc:
        return {
            'ok': False,
            'error': 'network',
            'html': _oauth_result_html(False, f'Network error talking to Google: {exc}'),
        }

    sc = _sc()
    existing = as_dict(sc.get('google')) if sc.get('google') else {}
    sc['google'] = {
        **existing,
        'email': email or existing.get('email'),
        'displayName': display_name or existing.get('displayName') or existing.get('name'),
        'picture': picture or existing.get('picture'),
        'googleSub': google_sub or existing.get('googleSub') or existing.get('sub'),
        'status': 'connected',
        'accessToken': access_token or existing.get('accessToken'),
        'refreshToken': refresh_token or existing.get('refreshToken'),
        'tokenType': as_str(tokens.get('token_type')) or 'Bearer',
        'expiresIn': tokens.get('expires_in'),
        'scope': as_str(tokens.get('scope')),
        'updatedAt': _now(),
    }
    _save_sc(sc)
    # Also export a hint for MCP tools that read env (not the full tokens).
    if email:
        os.environ['USER_GOOGLE_EMAIL'] = email
        try:
            set_mcp_env({'USER_GOOGLE_EMAIL': email}, merge=True)
        except Exception:
            pass
    # Bridge tokens into workspace-mcp's credential store so Google MCP tools
    # stop forcing a second (broken) browser sign-in after Integrations connect.
    try:
        _write_workspace_mcp_credentials(
            email=email,
            access_token=access_token,
            refresh_token=refresh_token,
            client_id=client_id,
            client_secret=client_secret,
            scopes=as_str(tokens.get('scope')),
        )
    except Exception:
        pass

    account = email or 'your Google account'
    return {
        'ok': True,
        'email': email,
        'displayName': display_name,
        'picture': picture,
        'googleSub': google_sub,
        'connection': _google_card(as_dict(sc.get('google'))),
        'html': _oauth_result_html(
            True,
            f'Signed in as {account}. You can close this window and return to August.',
            email=email,
            display_name=display_name,
            picture=picture,
        ),
    }


def _workspace_mcp_credentials_dir() -> str:
    explicit = (
        os.environ.get('WORKSPACE_MCP_CREDENTIALS_DIR')
        or os.environ.get('GOOGLE_MCP_CREDENTIALS_DIR')
        or _mcp_global_env_map().get('WORKSPACE_MCP_CREDENTIALS_DIR')
        or _mcp_global_env_map().get('GOOGLE_MCP_CREDENTIALS_DIR')
        or ''
    ).strip()
    if explicit:
        return os.path.expanduser(explicit)
    home = os.path.expanduser('~')
    if home and home != '~':
        return os.path.join(home, '.google_workspace_mcp', 'credentials')
    return os.path.join(os.getcwd(), '.credentials')


def sync_google_tokens_to_workspace_mcp(preferred_email: str | None = None) -> str:
    """If August already has Google tokens, write them for workspace-mcp.

    Returns the email that was synced, or '' if nothing to sync.
    """
    sc = _sc()
    raw = as_dict(sc.get('google')) if sc.get('google') else {}
    email = (
        (preferred_email or '').strip()
        or as_str(raw.get('email'))
        or as_str(raw.get('account'))
    )
    access = as_str(raw.get('accessToken'))
    refresh = as_str(raw.get('refreshToken'))
    if not email or not (access or refresh):
        return ''
    ok = _write_workspace_mcp_credentials(
        email=email,
        access_token=access,
        refresh_token=refresh,
        client_id=_google_client_id(),
        client_secret=_google_client_secret(),
        scopes=as_str(raw.get('scope')),
    )
    if not ok:
        return ''
    try:
        os.environ['USER_GOOGLE_EMAIL'] = email
        set_mcp_env({'USER_GOOGLE_EMAIL': email}, merge=True)
    except Exception:
        pass
    return email


def _write_workspace_mcp_credentials(
    *,
    email: str,
    access_token: str,
    refresh_token: str,
    client_id: str,
    client_secret: str,
    scopes: str = '',
) -> bool:
    """Persist Google tokens in the format workspace-mcp LocalDirectoryCredentialStore reads."""
    if not email or not (access_token or refresh_token):
        return False
    base = _workspace_mcp_credentials_dir()
    os.makedirs(base, mode=0o700, exist_ok=True)
    # URL-encode like workspace-mcp (quote with safe="@._-")
    safe_email = urllib.parse.quote(email, safe='@._-')
    path = os.path.join(base, f'{safe_email}.json')
    scope_list = [s for s in scopes.split() if s] if scopes else [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive.readonly',
    ]
    payload = {
        'token': access_token or None,
        'refresh_token': refresh_token or None,
        'token_uri': 'https://oauth2.googleapis.com/token',
        'client_id': client_id or None,
        'client_secret': client_secret or None,
        'scopes': scope_list,
        'expiry': None,
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    return True


def _oauth_result_html(
    ok: bool,
    message: str,
    *,
    email: str = '',
    display_name: str = '',
    picture: str = '',
) -> str:
    title = 'Google signed in' if ok else 'Google sign-in failed'
    color = '#22c55e' if ok else '#ef4444'
    payload = {
        'type': 'august-google-oauth',
        'ok': ok,
        'email': email or None,
        'displayName': display_name or None,
        'picture': picture or None,
    }
    # Keep JS object literal simple for the inline script.
    payload_js = json.dumps(payload)
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>{title}</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #0f0f10; color: #e8e8ea;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }}
  .card {{ max-width: 28rem; padding: 2rem; border-radius: 1rem;
           border: 1px solid #2a2a2e; background: #18181b; text-align: center; }}
  h1 {{ font-size: 1.15rem; margin: 0 0 0.75rem; color: {color}; }}
  p {{ font-size: 0.9rem; line-height: 1.5; color: #a1a1aa; margin: 0; }}
</style></head>
<body><div class="card"><h1>{title}</h1><p>{message}</p></div>
<script>try {{ window.opener && window.opener.postMessage({payload_js}, '*'); }} catch (e) {{}}</script>
</body></html>"""


def disconnect(name: str) -> dict[str, Any]:
    if name not in SERVICE_META:
        raise ValueError(f'Unknown service: {name}')
    sc = _sc()
    sc.pop(name, None)
    _save_sc(sc)
    if name == 'github':
        os.environ.pop('GITHUB_TOKEN', None)
    if name == 'slack':
        os.environ.pop('SLACK_BOT_TOKEN', None)
        os.environ.pop('SLACK_TEAM_ID', None)
    return {'status': 'ok', 'connection': {'status': 'disconnected', 'name': name}}


# ── MCP global env ──────────────────────────────────────────────────────

_SENSITIVE_KEYS = (
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'KEY',
    'CREDENTIAL',
    'AUTH',
)


def _is_sensitive(key: str) -> bool:
    upper = key.upper()
    # Public OAuth client IDs are not secrets ("OAUTH" contains "AUTH").
    if upper.endswith('CLIENT_ID'):
        return False
    return any(part in upper for part in _SENSITIVE_KEYS)


def get_mcp_env() -> dict[str, Any]:
    cfg = getConfig()
    raw = as_dict(cfg.get('mcpGlobalEnv')) if cfg.get('mcpGlobalEnv') is not None else {}
    env_list: list[dict[str, Any]] = []
    for key, value in sorted(raw.items(), key=lambda kv: str(kv[0]).lower()):
        k = str(key)
        v = '' if value is None else str(value)
        sensitive = _is_sensitive(k)
        env_list.append(
            {
                'key': k,
                'value': (_mask(v) if sensitive and v else v),
                'set': bool(v),
                'sensitive': sensitive,
                'masked': sensitive and bool(v),
            }
        )
    return {'env': env_list}


def set_mcp_env(
    env: list[dict[str, Any]] | dict[str, str],
    *,
    merge: bool = False,
) -> dict[str, Any]:
    """Save MCP global env. When merge=True, update keys without wiping the rest."""
    cfg = getConfig()
    existing = as_dict(cfg.get('mcpGlobalEnv')) if cfg.get('mcpGlobalEnv') is not None else {}
    base: dict[str, str] = {str(k): str(v) for k, v in existing.items()} if merge else {}
    if isinstance(env, dict):
        for k, v in env.items():
            key = str(k).strip()
            if not key:
                continue
            val = str(v)
            if merge and not val:
                base.pop(key, None)
            else:
                base[key] = val
    else:
        for item in env:
            if not isinstance(item, dict):
                continue
            k = as_str(item.get('key')).strip()
            if not k:
                continue
            val = as_str(item.get('value'))
            if merge and not val:
                base.pop(k, None)
            else:
                base[k] = val
    cfg['mcpGlobalEnv'] = base
    saveConfig(cfg)
    # Export into process env for MCP subprocess inheritance.
    for k, v in base.items():
        if v:
            os.environ[k] = v
    return get_mcp_env()
