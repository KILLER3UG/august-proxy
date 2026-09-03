"""M-2 (Part 21) — one shared scope-resolution rule for facts and skills.

The memory scope of a session is ``'global'`` except for a Bot's home chats,
which resolve to ``'bot:<agentId>'``. Retrieval unions global ∪ this-scope
(a Bot still recalls the user's shared memory; its private notes stay
private), and the skills catalogue prepends a bot root so a Bot can carry
its own skills. The rule lives in this one module so the facts write door,
the retrieval filter and the skills roots can never drift apart (plan M-2:
"One shared scope-resolution function with the skills root logic so the rule
can't drift").
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app.json_narrowing import as_str

GLOBAL_SCOPE = 'global'
BOT_PREFIX = 'bot:'

_UNSAFE = re.compile(r'[^A-Za-z0-9_.-]')


def sanitize_agent_id(agent_id: str) -> str:
    """Path-safe form of an agent id (scope suffix + skills dir name)."""
    return _UNSAFE.sub('_', (agent_id or '').strip())[:120]


def bot_scope(agent_id: str) -> str:
    return f'{BOT_PREFIX}{sanitize_agent_id(agent_id)}'


def is_bot_scope(scope: str) -> bool:
    return (scope or '').startswith(BOT_PREFIX)


def bot_agent_id(scope: str) -> str:
    return (scope or '')[len(BOT_PREFIX) :] if is_bot_scope(scope) else ''


def normalize_scope(scope: str) -> str:
    """Validate a caller-supplied scope; anything unrecognized is 'global'."""
    s = (scope or '').strip()
    if s == GLOBAL_SCOPE or is_bot_scope(s) or s.startswith('project:'):
        return s
    return GLOBAL_SCOPE


def resolve_scope(session: Any = None, session_id: str = '') -> str:
    """Memory scope for a session (or the current turn's session).

    Bot home = the canonical Bot Chat (``metadata.canonicalBotChat``) or a
    bot run context (``metadata.botAgentId`` — DM wakes and room rounds
    stamp it). Everything else — regular chats, build/plan agent roles,
    automation runs, gateway bridges — stays 'global'. Best-effort: any
    lookup failure resolves to 'global' (the safe, current-behavior default).
    """
    try:
        if session is None:
            sid = session_id
            if not sid:
                from app.services.workbench.context import currentSessionId

                sid = currentSessionId.get()
            if not sid or sid == 'default':
                return GLOBAL_SCOPE
            from app.services.workbench import sessions as sessions_mod

            session = sessions_mod.get_workbench_session(sid)
        if session is None:
            return GLOBAL_SCOPE
        meta = getattr(session, 'metadata', None)
        if not isinstance(meta, dict):
            return GLOBAL_SCOPE
        agent = as_str(meta.get('canonicalBotChat')) or as_str(meta.get('botAgentId'))
        return bot_scope(agent) if agent else GLOBAL_SCOPE
    except Exception:
        return GLOBAL_SCOPE


def bot_skills_root(agent_id: str) -> Path:
    """``<dataDir>/bots/<agentId>/skills`` — the Bot's private skill root."""
    from app.config import settings

    return Path(settings.dataDir) / 'bots' / sanitize_agent_id(agent_id) / 'skills'
