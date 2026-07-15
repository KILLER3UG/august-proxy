"""Service connection credentials (Google / GitHub / Slack) stored in config.json."""

from __future__ import annotations

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
        'scopes': [],
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
    has_oauth = bool(os.environ.get('GOOGLE_OAUTH_CLIENT_ID')) or bool(
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
        'missingConfig': missing and not connected,
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
    return (
        os.environ.get('GOOGLE_OAUTH_CLIENT_ID')
        or os.environ.get('GOOGLE_CLIENT_ID')
        or _mcp_global_env_map().get('GOOGLE_OAUTH_CLIENT_ID')
        or _mcp_global_env_map().get('GOOGLE_CLIENT_ID')
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
    """Build browser OAuth URL with CSRF state. Returns None if client id missing."""
    client_id = _google_client_id()
    if not client_id:
        return None
    _purge_stale_oauth_states()
    redirect = _google_redirect_uri()
    state = secrets.token_urlsafe(24)
    _oauth_pending[state] = {
        'created': time.time(),
        'email': user_email,
        'redirect_uri': redirect,
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
    }
    if user_email and user_email != 'me':
        params['login_hint'] = user_email
    auth_url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
    return {
        'authUrl': auth_url,
        'message': 'Open Google sign-in in your browser to connect Gmail / Calendar / Drive.',
    }


async def google_auth_url(email: str = '') -> dict[str, Any]:
    """Start Google OAuth.

    Prefer a registered workspace-mcp server's ``start_google_auth`` tool.
    Fall back to a native OAuth URL built from ``GOOGLE_OAUTH_*`` env vars.
    Never invent a fake success when neither path works.
    """
    sc = _sc()
    stored_email = as_str(as_dict(sc.get('google')).get('email')) if sc.get('google') else ''
    user_email = email.strip() or stored_email or ''

    # 1) MCP workspace-mcp tool (if that server is registered and running)
    try:
        from app.services.tools import mcp_client

        # Ensure tools are discovered so we can resolve the correct server id.
        for srv in list(mcp_client.listRegisteredServers()):
            sid = as_str(srv.get('id'))
            if not sid:
                continue
            try:
                await mcp_client.discoverTools(sid)
            except Exception:
                pass

        server_id = mcp_client.find_server_for_tool('start_google_auth')
        if not server_id:
            # Common package name / catalog id heuristics
            for srv in mcp_client.listRegisteredServers():
                if not isinstance(srv, dict):
                    continue
                blob = f"{srv.get('id', '')} {srv.get('name', '')} {srv.get('command', '')} {srv.get('args', '')}".lower()
                if 'workspace-mcp' in blob or 'workspace_mcp' in blob or 'google workspace' in blob:
                    server_id = as_str(srv.get('id'))
                    break

        if server_id:
            tool_name = f'mcp__{server_id}__start_google_auth'
            result = await mcp_client.executeMcpToolCall(
                tool_name,
                {
                    'service_name': 'gmail,calendar,drive,docs,sheets,slides,tasks,contacts',
                    'user_google_email': user_email or 'me',
                },
            )
            text = str(result)
            # If the server truly isn't running, fall through to native OAuth
            if text.startswith('Error: MCP server') and 'not running' in text:
                pass
            elif text.startswith('Error:'):
                pass
            else:
                import re

                match = re.search(r'https://[^\s"\'<>]+', text)
                if match:
                    return {'authUrl': match.group(0), 'message': text, 'via': 'mcp'}
                lower = text.lower()
                # Already authenticated — mark connected so the UI updates.
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
                if text.strip():
                    return {'message': text, 'authUrl': '', 'via': 'mcp'}
    except Exception:
        pass

    # 2) Native Google OAuth (full browser flow with August callback)
    native = _native_google_auth_url(user_email)
    if native:
        return {**native, 'via': 'native'}

    return {
        'authUrl': '',
        'message': (
            'Google sign-in is not configured. Install “Google Workspace MCP” from '
            'Settings → Integrations → Add (paste Client ID + Secret), or set '
            'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in MCP env.'
        ),
    }


async def google_oauth_callback(code: str = '', state: str = '', error: str = '') -> dict[str, Any]:
    """Handle Google OAuth redirect: exchange code, store tokens, mark connected."""
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
    if pending is None and state:
        # State expired or unknown — still try exchange with default redirect
        pending = {'redirect_uri': _google_redirect_uri(), 'email': ''}

    client_id = _google_client_id()
    client_secret = _google_client_secret()
    if not client_id or not client_secret:
        return {
            'ok': False,
            'error': 'missing_client',
            'html': _oauth_result_html(
                False,
                'GOOGLE_OAUTH_CLIENT_ID / SECRET not configured on the August server.',
            ),
        }

    redirect_uri = as_str((pending or {}).get('redirect_uri')) or _google_redirect_uri()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            token_res = await client.post(
                'https://oauth2.googleapis.com/token',
                data={
                    'code': code.strip(),
                    'client_id': client_id,
                    'client_secret': client_secret,
                    'redirect_uri': redirect_uri,
                    'grant_type': 'authorization_code',
                },
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
                        f'Check redirect URI matches Google Cloud: {redirect_uri}. {detail}',
                    ),
                }
            tokens = token_res.json()
            access_token = as_str(tokens.get('access_token'))
            refresh_token = as_str(tokens.get('refresh_token'))
            email = as_str((pending or {}).get('email'))
            if access_token:
                try:
                    ui = await client.get(
                        'https://www.googleapis.com/oauth2/v2/userinfo',
                        headers={'Authorization': f'Bearer {access_token}'},
                    )
                    if ui.status_code < 400:
                        email = as_str(ui.json().get('email')) or email
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

    account = email or 'your Google account'
    return {
        'ok': True,
        'email': email,
        'connection': _google_card(as_dict(sc.get('google'))),
        'html': _oauth_result_html(
            True,
            f'Connected as {account}. You can close this window and return to August.',
        ),
    }


def _oauth_result_html(ok: bool, message: str) -> str:
    title = 'Google connected' if ok else 'Google sign-in failed'
    color = '#22c55e' if ok else '#ef4444'
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
<script>try {{ window.opener && window.opener.postMessage({{ type: 'august-google-oauth', ok: {str(ok).lower()} }}, '*'); }} catch (e) {{}}</script>
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
