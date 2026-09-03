"""Bot roster: registry records with uiMeta, canonical Bot Chats, avatars.

One agent concept — a Bot IS an agent-registry record whose ``uiMeta``
carries the presentation fields (title, avatar, hidden, groups). The
roster functions here are the single SoT the router and the tools layer
both call; nothing else writes ``uiMeta`` directly.
"""

from __future__ import annotations

import hashlib
import logging
import math
from typing import Any

from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.services.tools import agent_registry
from app.type_aliases import JsonValue

logger = logging.getLogger('august.bot_mode')

_DEFAULT_BOT_NAME = 'assistant'
_DEFAULT_BOT_ROLE = (
    'You are the user\'s primary assistant bot. You coordinate work, answer '
    'directly, and can delegate to teammate bots when they would do a task better.'
)
_INTRO_TURN_PROMPT = (
    'Introduce yourself in one or two short sentences: who you are, what you '
    'are good at, and one thing the user can ask you right now. Do not use tools.'
)


def _normalize_ui_meta(raw: object) -> dict[str, JsonValue]:
    """Coerce anything (missing/foreign shapes) into the canonical uiMeta."""
    d = as_dict(raw) if raw is not None else {}
    return {
        'title': as_str(d.get('title')),
        'avatar': as_str(d.get('avatar')),
        'hidden': as_bool(d.get('hidden'), False),
        'groups': [as_str(g) for g in as_list(d.get('groups'), [])],
    }


def _bot_record(agent: dict[str, object]) -> dict[str, object]:
    """View of a registry record with normalized uiMeta."""
    out = dict(agent)
    out['uiMeta'] = _normalize_ui_meta(agent.get('uiMeta'))
    return out


def _is_bot(agent: dict[str, object]) -> bool:
    # Every registry record is a Bot (one agent concept, OQ1/OQ2 ruling:
    # extend the registry; the old read-only Agents view is superseded).
    return True


def list_bots() -> list[dict[str, object]]:
    """All Bots (hidden included — display filtering is the UI's job)."""
    return [_bot_record(a) for a in agent_registry.listAgents() if _is_bot(a)]


def get_bot(agent_id: str) -> dict[str, object] | None:
    agent = agent_registry.getAgent(agent_id)
    return _bot_record(agent) if agent else None


def get_default_bot() -> dict[str, object] | None:
    for bot in list_bots():
        if as_str(bot.get('name')) == _DEFAULT_BOT_NAME:
            return bot
    return None


def ensure_default_bot(actor: str = 'system') -> dict[str, object]:
    """Boot backfill: the default assistant Bot always exists."""
    existing = get_default_bot()
    if existing:
        return existing
    return create_bot(
        name=_DEFAULT_BOT_NAME,
        title='Assistant',
        description='The primary assistant bot.',
        role=_DEFAULT_BOT_ROLE,
        actor=actor,
        intro=False,
    )


def create_bot(
    name: str,
    title: str = '',
    description: str = '',
    role: str = '',
    model: str = '',
    provider: str = '',
    toolsets: list[str] | None = None,
    clone_from: str = '',
    actor: str = 'ui',
    intro: bool = True,
) -> dict[str, object]:
    """Create a Bot (idempotent on name) and its canonical Bot Chat.

    ``clone_from`` copies an existing Bot's role/description/model/provider/
    toolsets — a fork of the record, not a link (Phase A roster context).
    With ``intro=True`` the Bot introduces itself in its new chat via one
    headless turn.
    """
    existing = _find_by_name(name)
    if existing is not None:
        return existing
    if clone_from:
        src = agent_registry.getAgent(clone_from)
        if src:
            role = role or as_str(src.get('role'))
            description = description or as_str(src.get('description'))
            model = model or as_str(src.get('model'))
            provider = provider or as_str(src.get('provider'))
            toolsets = toolsets or [as_str(t) for t in as_list(src.get('toolsets'), [])]

    agent = agent_registry.createAgent(
        name=name,
        description=description,
        role=role,
        model=model,
        provider=provider,
        toolsets=toolsets,
        actor=actor,
    )
    agent['uiMeta'] = _normalize_ui_meta({'title': title or name})
    agent_registry.updateAgent(as_str(agent['id']), {'uiMeta': agent['uiMeta']}, actor=actor)

    bot = _bot_record(agent)
    if intro:
        chat = ensure_canonical_bot_chat(as_str(agent['id']))
        _run_intro_turn(as_str(agent['id']), chat.id)
    else:
        ensure_canonical_bot_chat(as_str(agent['id']))
    return bot


def _find_by_name(name: str) -> dict[str, object] | None:
    for bot in list_bots():
        if as_str(bot.get('name')) == name:
            return bot
    return None


def update_bot(agent_id: str, ui_meta: dict[str, object], actor: str = 'ui') -> dict[str, object] | None:
    """Merge uiMeta fields (title/avatar/hidden/groups) into the record."""
    agent = agent_registry.getAgent(agent_id)
    if not agent:
        return None
    merged = _normalize_ui_meta(agent.get('uiMeta'))
    incoming = _normalize_ui_meta({**merged, **{k: v for k, v in ui_meta.items()}})
    agent_registry.updateAgent(agent_id, {'uiMeta': incoming}, actor=actor)
    updated = agent_registry.getAgent(agent_id)
    return _bot_record(updated) if updated else None


def update_bot_by_name(name: str, ui_meta: dict[str, object], actor: str = 'ui') -> dict[str, object] | None:
    bot = _find_by_name(name)
    return update_bot(as_str(bot.get('id')), ui_meta, actor=actor) if bot else None


def delete_bot(agent_id: str, actor: str = 'ui') -> bool:
    """Delete a Bot record. The default assistant Bot is undeletable."""
    default = get_default_bot()
    if default and as_str(default.get('id')) == agent_id:
        return False
    return agent_registry.deleteAgent(agent_id, actor=actor)


# ── canonical Bot Chat ─────────────────────────────────────────────────────

CANONICAL_CHAT_TITLE = 'Bot Chat'


def ensure_canonical_bot_chat(agent_id: str) -> Any:
    """Find or create the Bot's one pinned canonical chat.

    Idempotent across restarts: scans the workbench store for a session
    stamped ``metadata.canonicalBotChat == agent_id`` before creating.
    """
    from app.services.workbench import sessions as sessions_mod

    agents = agent_registry.getAgent(agent_id)
    if not agents:
        raise ValueError(f'unknown agentId {agent_id!r}')
    existing = find_canonical_bot_chat(agent_id)
    if existing is not None:
        return existing
    session = sessions_mod.create_workbench_session(
        agentId=agent_id,
        guardMode='full',
        goal='',
    )
    session.title = CANONICAL_CHAT_TITLE
    meta = dict(session.metadata or {})
    meta['canonicalBotChat'] = agent_id
    session.metadata = meta
    sessions_mod.save_sessions(immediate=True)
    sessions_mod._emit_session_status(session.id)
    return session


def find_canonical_bot_chat(agent_id: str) -> Any | None:
    """Return the canonical chat session for a Bot, or None.

    Memory window first (the hot path), then the SQLite blob list so a
    restart (pruned window) still resolves the pinned chat.
    """
    from app.services.workbench import sessions as sessions_mod

    for session in list(sessions_mod._sessions.values()):
        if as_str(session.metadata.get('canonicalBotChat')) == agent_id:
            return session
    try:
        for summary in sessions_mod.list_workbench_sessions():
            if summary.get('agentId') != agent_id:
                continue
            loaded = sessions_mod.get_workbench_session(as_str(summary.get('id')))
            if loaded is not None and as_str(loaded.metadata.get('canonicalBotChat')) == agent_id:
                return loaded
    except Exception:
        logger.debug('canonical chat scan failed for %s', agent_id, exc_info=True)
    return None


def is_canonical_bot_chat(session: Any) -> bool:
    """True when ``session`` is a Bot's canonical chat (the /new gate)."""
    try:
        return as_str(session.metadata.get('canonicalBotChat')) != ''
    except Exception:
        return False


def reroute_new_for_canonical_chat(session_id: str) -> bool:
    """/new inside a canonical Bot Chat → compaction, never a fork.

    Returns True when the session IS canonical and compaction ran (or was a
    no-op because the chat is still tiny); False when the session is a
    regular chat (caller may proceed with a normal new chat).
    """
    from app.services.workbench import sessions as sessions_mod

    session = sessions_mod.get_workbench_session(session_id)
    if session is None or not is_canonical_bot_chat(session):
        return False
    import asyncio

    async def _compact() -> None:
        try:
            await sessions_mod.compact_workbench_session_now(session_id)
        except Exception:
            logger.debug('canonical-chat compact reroute failed', exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        loop.create_task(_compact())
    else:
        asyncio.run(_compact())
    return True


def _run_intro_turn(agent_id: str, session_id: str) -> object | None:
    """One headless turn so a new Bot introduces itself (roster alive at birth).

    Synchronous when no asyncio loop is running (tests / CLI callers get a
    deterministic, completed turn). Under a live loop the turn is spawned as
    a fire-and-forget task: chat turns can take minutes and Bot creation
    must not block on the model. Failures only log — an empty chat is valid.
    """
    import asyncio

    async def _intro() -> None:
        try:
            from app.services.workbench import workbench as wb

            agent = agent_registry.getAgent(agent_id) or {}
            role = as_str(agent.get('role'))
            prompt = _INTRO_TURN_PROMPT
            if role:
                prompt = f'{role}\n\n{prompt}'
            await wb.sendWorkbenchMessageStream(
                sessionId=session_id,
                message=prompt,
                agentId=agent_id,
            )
        except Exception:
            logger.debug('intro turn failed for %s', agent_id, exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        return loop.create_task(_intro())
    asyncio.run(_intro())
    return None


# ── deterministic identicon avatars ────────────────────────────────────────

_PALETTE = [
    ('#6d28d9', '#a78bfa'),
    ('#0f766e', '#5eead4'),
    ('#b45309', '#fcd34d'),
    ('#be123c', '#fda4af'),
    ('#1d4ed8', '#93c5fd'),
    ('#4d7c0f', '#bef264'),
    ('#701a75', '#f0abfc'),
    ('#0e7490', '#67e8f9'),
]


def _hash_points(name: str, salt: str = '') -> list[float]:
    digest = hashlib.sha256(f'{salt}:{name}'.encode('utf-8')).hexdigest()
    return [int(digest[i : i + 4], 16) / 0xFFFF for i in range(0, 32, 4)]


def _svg_attr_escape(text: str) -> str:
    """XML attribute escaping — bot names are free-form user/agent input and
    land inside the SVG's aria-label (mirror of the client's escapeAttr)."""
    return (
        (text or '')
        .replace('&', '&amp;')
        .replace('"', '&quot;')
        .replace('<', '&lt;')
    )


def avatar_svg(name: str, salt: str = '') -> str:
    """Deterministic blob-face SVG: same name (+salt) → identical bytes.

    Pure hash math — zero storage, zero network, no deps. The UI renders
    this string inline; uploads/AI portraits set ``uiMeta.avatar`` to a
    path instead and the identicon becomes the fallback.
    """
    points = _hash_points(name, salt)
    fg, bg = _PALETTE[math.floor(points[0] * len(_PALETTE)) % len(_PALETTE)]
    cx = 32.0
    cy = 32.0
    # Blob body: 8-point rounded polygon jittered by the name hash.
    verts: list[tuple[float, float]] = []
    for i in range(8):
        ang = (i / 8) * 2 * math.pi
        r = 20.0 + (points[(i % 7) + 1] - 0.5) * 10.0
        verts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    path = 'M ' + ' L '.join(f'{x:.2f} {y:.2f}' for x, y in verts) + ' Z'
    eye_y = cy - 2.0
    eye_dx = 5.5 + points[2] * 3.0
    eye_r = 2.2 + points[3] * 1.5
    smile_w = 8.0 + points[4] * 4.0
    smile_y = cy + 7.0 + points[5] * 2.0
    smile_r = smile_w * (0.8 + points[6] * 0.3)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        f'width="64" height="64" role="img" aria-label="{_svg_attr_escape(name)} avatar">'
        f'<path d="{path}" fill="{bg}"/>'
        f'<circle cx="{cx - eye_dx:.2f}" cy="{eye_y:.2f}" r="{eye_r:.2f}" fill="{fg}"/>'
        f'<circle cx="{cx + eye_dx:.2f}" cy="{eye_y:.2f}" r="{eye_r:.2f}" fill="{fg}"/>'
        f'<path d="M {cx - smile_w:.2f} {smile_y:.2f} '
        f'A {smile_r:.2f} {smile_r:.2f} 0 0 1 {cx + smile_w:.2f} {smile_y:.2f}" '
        f'stroke="{fg}" stroke-width="2.6" stroke-linecap="round" fill="none"/>'
        '</svg>'
    )
