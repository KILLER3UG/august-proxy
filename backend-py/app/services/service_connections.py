"""Service connection credentials (Google / GitHub / Slack) stored in config.json."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from app.json_narrowing import as_dict, as_str
from app.services.config_service import getConfig, saveConfig

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
    sc['google'] = {
        'email': email.strip() or None,
        'status': 'connected' if email.strip() else 'disconnected',
        'updatedAt': _now(),
    }
    _save_sc(sc)
    return {'status': 'ok', 'connection': _google_card(as_dict(sc.get('google')))}


async def google_auth_url(email: str = '') -> dict[str, Any]:
    """Start Google OAuth via MCP workspace tool when available."""
    sc = _sc()
    stored_email = as_str(as_dict(sc.get('google')).get('email')) if sc.get('google') else ''
    user_email = email.strip() or stored_email or ''
    try:
        from app.services.tools import mcp_client

        result = await mcp_client.executeMcpToolCall(
            'august__mcp__workspace-mcp__start_google_auth',
            {
                'service_name': 'gmail,calendar,drive,docs,sheets,slides,tasks,contacts',
                'user_google_email': user_email or 'me',
            },
        )
        text = str(result)
        import re

        match = re.search(r'https://[^\s]+', text)
        if match:
            return {'authUrl': match.group(0), 'message': text}
        return {'message': text, 'authUrl': ''}
    except Exception as exc:
        # Honest fallback — frontend can open account console manually.
        return {
            'authUrl': '',
            'message': (
                'Google OAuth MCP tool unavailable. Configure GOOGLE_OAUTH_CLIENT_ID / '
                f'SECRET in MCP env, then retry. ({exc})'
            ),
        }


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


def set_mcp_env(env: list[dict[str, Any]] | dict[str, str]) -> dict[str, Any]:
    merged: dict[str, str] = {}
    if isinstance(env, dict):
        for k, v in env.items():
            if str(k).strip():
                merged[str(k).strip()] = str(v)
    else:
        for item in env:
            if not isinstance(item, dict):
                continue
            k = as_str(item.get('key')).strip()
            if not k:
                continue
            merged[k] = as_str(item.get('value'))
    cfg = getConfig()
    cfg['mcpGlobalEnv'] = merged
    saveConfig(cfg)
    # Export into process env for MCP subprocess inheritance.
    for k, v in merged.items():
        if v:
            os.environ[k] = v
    return get_mcp_env()
