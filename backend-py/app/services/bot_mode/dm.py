"""Part 19 Phase C — teammate DMs: the single ``message_agent`` send path.

A DM is a durable ``bot_dm`` inbox row (migration 034). ``message_agent`` is
the ONLY way one Bot talks to another: the @ sign is addressing sugar handled
by the composer middleware (annotation only — see ``protocol``), never a
delivery pipe. The tool validates the target against the live roster, applies
server-side attribution, runs ONE headless turn in the recipient's canonical
Bot Chat, and acks immediately (fire-and-forget). When the recipient's reply
lands, the SENDER is woken (OQ4): the reply is appended to the sender's chat
as a ``Message from 🤖 …`` user-role turn and one turn runs there so the
sender relays it — capped at one wake per DM, with an in-flight guard so two
Bots can't ping-pong concurrent DMs.

The delivery runner is injectable (``runner=``) so the round-trip + wake
ordering are unit-testable without a live model, mirroring the gateway
``SessionBridge`` pattern.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import cast

from app.json_narrowing import as_dict, as_str
from app.services.bot_mode import protocol
from app.services.memory_conn import conn as _conn

logger = logging.getLogger('august.bot_mode.dm')

# Typed failure codes (the ``reason_code`` enum in bot_dm). The sender's ack
# carries one of these so the model gets an actionable receipt, and the
# retry-once rule keys off them.
REASON_UNKNOWN_TARGET = 'unknown_target'
REASON_SELF = 'self_message'
REASON_BODY_TOO_LONG = 'body_too_long'
REASON_IN_FLIGHT = 'in_flight'
REASON_NO_CHAT = 'no_canonical_chat'
REASON_DELIVERY_ERROR = 'delivery_error'

_MESSAGE_AGENT = 'message_agent'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── durable inbox store ──────────────────────────────────────────────────────


def enqueue(
    *, from_agent: str, to_agent: str, body: str, from_session: str = '', to_session: str = ''
) -> int:
    try:
        c = _conn()
        cur = c.execute(
            'INSERT INTO bot_dm (from_agent, to_agent, from_session, to_session, body, status, created_at) '
            "VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            (from_agent, to_agent, from_session, to_session, body, _now()),
        )
        c.commit()
        return int(cur.lastrowid or 0)
    except Exception:
        logger.debug('bot_dm enqueue failed', exc_info=True)
        return 0


def _set_status(
    dm_id: int, status: str, *, reason_code: str = '', delivered: bool = False
) -> None:
    if dm_id <= 0:
        return
    try:
        c = _conn()
        if delivered:
            c.execute(
                'UPDATE bot_dm SET status = ?, reason_code = ?, delivered_at = ? WHERE id = ?',
                (status, reason_code, _now(), dm_id),
            )
        else:
            c.execute(
                'UPDATE bot_dm SET status = ?, reason_code = ? WHERE id = ?',
                (status, reason_code, dm_id),
            )
        c.commit()
    except Exception:
        logger.debug('bot_dm status update failed', exc_info=True)


def mark_running(dm_id: int) -> None:
    _set_status(dm_id, 'running')


def mark_delivered(dm_id: int) -> None:
    _set_status(dm_id, 'delivered', delivered=True)


def mark_failed(dm_id: int, reason_code: str) -> None:
    _set_status(dm_id, 'failed', reason_code=reason_code, delivered=True)


def get_dm(dm_id: int) -> dict[str, object] | None:
    try:
        row = _conn().execute('SELECT * FROM bot_dm WHERE id = ?', (dm_id,)).fetchone()
        return dict(row) if row is not None else None
    except Exception:
        return None


def list_inbox(to_agent: str, status: str = '') -> list[dict[str, object]]:
    try:
        if status:
            rows = _conn().execute(
                'SELECT * FROM bot_dm WHERE to_agent = ? AND status = ? ORDER BY id DESC',
                (to_agent, status),
            ).fetchall()
        else:
            rows = _conn().execute(
                'SELECT * FROM bot_dm WHERE to_agent = ? ORDER BY id DESC', (to_agent,)
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def has_inflight(from_agent: str, to_agent: str) -> bool:
    """A pending/running DM from→to already exists (ping-pong guard)."""
    try:
        row = _conn().execute(
            "SELECT 1 FROM bot_dm WHERE from_agent = ? AND to_agent = ? "
            "AND status IN ('pending','running') LIMIT 1",
            (from_agent, to_agent),
        ).fetchone()
        return row is not None
    except Exception:
        return False


# ── roster target resolution ─────────────────────────────────────────────────


def resolve_target(target: str) -> str:
    """Resolve a DM target (handle / display title / id) to a live agent id.

    Returns '' when nothing matches — the caller turns that into an
    ``unknown_target`` receipt carrying the live roster so the model can
    retry with a real handle. Matching is tolerant: ``@researcher``,
    ``researcher``, the display title, and the raw id all resolve.
    """
    from app.services.bot_mode import roster

    raw = (target or '').strip().lstrip('@').strip()
    if not raw:
        return ''
    low = raw.lower()
    for bot in roster.list_bots():
        bid = as_str(bot.get('id'))
        name = as_str(bot.get('name'))
        ui = as_dict(bot.get('uiMeta'), {})
        title = as_str(ui.get('title'))
        if bid == raw or name.lower() == low or title.lower() == low:
            return bid
    return ''


def _handle_for(agent_id: str) -> str:
    from app.services.bot_mode import roster

    bot = roster.get_bot(agent_id)
    return as_str(bot.get('name')) if bot else agent_id


# ── the message_agent tool ───────────────────────────────────────────────────


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


def is_dm_session(session: object) -> bool:
    """True when ``session`` is a Bot's canonical chat (the injection gate)."""
    try:
        meta = getattr(session, 'metadata', None)
        meta = meta if isinstance(meta, dict) else {}
        return as_str(meta.get('canonicalBotChat')) != ''
    except Exception:
        return False


def filter_dm_tools(tools: list[dict[str, object]], session: object) -> list[dict[str, object]]:
    """Drop ``message_agent`` unless the session is a canonical Bot Chat.

    Called from BOTH tool-definition paths (Anthropic + OpenAI) so the gate
    can't drift. A regular chat or a subagent never sees the tool; the tool
    executor re-checks so a forged call still fails closed.
    """
    if is_dm_session(session):
        return tools
    def _name(t: dict[str, object]) -> str:
        fn = as_dict(t.get('function'), {})
        return as_str(t.get('name') or fn.get('name'), '')

    return [t for t in tools if _name(t) != _MESSAGE_AGENT]


async def messageAgent(target: str = '', message: str = '') -> str:
    """Send one DM to another Bot (the single send path).

    Gate re-check: only a canonical Bot Chat may send. Validates the target
    against the live roster, applies the body cap + self/in-flight guards,
    enqueues the inbox row, and spawns the delivery task — returning an ack
    immediately (fire-and-forget). The recipient's reply wakes the sender.
    """
    from app.services.workbench.workbench import get_session

    session = get_session()
    sender_agent = as_str(getattr(session, 'agentId', '')) if session else ''
    if not is_dm_session(session) or not sender_agent:
        return _err(
            'message_agent is only available in a Bot\'s own chat.',
            reason_code=REASON_NO_CHAT,
        )
    body = (message or '').strip()
    if not body:
        return _err('message is required.')
    if len(body) > protocol.MAX_DM_BODY:
        return _err(
            f'message exceeds {protocol.MAX_DM_BODY} chars — compose a short '
            'paraphrase, never forward a transcript.',
            reason_code=REASON_BODY_TOO_LONG,
        )
    to_agent = resolve_target(target)
    if not to_agent:
        return _err(
            f"No Bot matches target {target!r}. Live roster: "
            f"{', '.join(protocol.roster_lines()) or '(none)'}",
            reason_code=REASON_UNKNOWN_TARGET,
        )
    if to_agent == sender_agent:
        return _err('Cannot message yourself.', reason_code=REASON_SELF)
    if has_inflight(sender_agent, to_agent):
        return _err(
            'A message to this Bot is already in flight — wait for its reply '
            'instead of sending another (no ping-pong).',
            reason_code=REASON_IN_FLIGHT,
        )
    from app.services.bot_mode import roster

    try:
        chat = roster.ensure_canonical_bot_chat(to_agent)
        to_session = as_str(getattr(chat, 'id', ''))
    except Exception:
        to_session = ''
    if not to_session:
        return _err(
            f'Bot {_handle_for(to_agent)} has no chat to deliver into.',
            reason_code=REASON_NO_CHAT,
        )
    sender_session = as_str(getattr(session, 'id', ''))
    attributed = f'Message from 🤖 {_handle_for(sender_agent)} (@{_handle_for(sender_agent)}):\n{body}'
    dm_id = enqueue(
        from_agent=sender_agent,
        to_agent=to_agent,
        body=attributed,
        from_session=sender_session,
        to_session=to_session,
    )
    if dm_id <= 0:
        return _err('Could not enqueue the message.', reason_code=REASON_DELIVERY_ERROR)
    _spawn(deliver(dm_id))
    return _ok(
        delivered='queued',
        dm_id=dm_id,
        to=_handle_for(to_agent),
        note='The recipient Bot is running one turn now; its reply will wake '
        'you and you relay it to the user. Do not send a second message to '
        'this Bot until you hear back.',
    )


# ── delivery + sender wake ───────────────────────────────────────────────────


def _spawn(coro: object) -> None:
    """Run a delivery coroutine now (tests) or fire-and-forget (live loop)."""

    async def _driver() -> None:
        try:
            await coro  # type: ignore[misc]
        except Exception:
            logger.debug('dm delivery driver failed', exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        loop.create_task(_driver())
    else:
        asyncio.run(_driver())


async def _run_turn(session_id: str, message: str, agent_id: str, runner: object) -> str:
    """Run one turn, accumulating the assistant reply text."""
    from app.services.workbench.emit_types import ASSISTANT_TEXT_EMIT_TYPES

    parts: list[str] = []

    def emit(ev: dict[str, object]) -> None:
        if isinstance(ev, dict) and ev.get('type') in ASSISTANT_TEXT_EMIT_TYPES and ev.get('content'):
            parts.append(as_str(ev['content']))

    from collections.abc import Awaitable, Callable

    run = cast(Callable[..., Awaitable[None]], runner or _default_runner())
    await run(sessionId=session_id, message=message, agentId=agent_id, emit=emit)
    return ''.join(parts).strip()


def _default_runner() -> object:
    from app.services.workbench import workbench as wb

    return wb.sendWorkbenchMessageStream


async def deliver(dm_id: int, *, runner: object = None) -> str:
    """Deliver one DM: recipient turn → append reply to sender → sender wake.

    Fire-and-forget from the tool's perspective. Marks the row running →
    delivered (or failed with a typed reason). The sender wake is capped at
    ONE turn per DM (this function runs it exactly once) and the in-flight
    guard in ``messageAgent`` stops concurrent ping-pong.
    """
    from app.services.bot_mode import roster

    row = get_dm(dm_id)
    if not row:
        return 'no-row'
    mark_running(dm_id)
    to_agent = as_str(row.get('to_agent'))
    from_agent = as_str(row.get('from_agent'))
    to_session = as_str(row.get('to_session'))
    from_session = as_str(row.get('from_session'))
    body = as_str(row.get('body'))
    try:
        if not to_session:
            chat = roster.ensure_canonical_bot_chat(to_agent)
            to_session = as_str(getattr(chat, 'id', ''))
        if not to_session:
            mark_failed(dm_id, REASON_NO_CHAT)
            return REASON_NO_CHAT
        reply = await _run_turn(to_session, body, to_agent, runner)
        mark_delivered(dm_id)
        # Sender wake: run ONE turn in the sender's chat carrying the reply, so
        # the sender relays it to the user (OQ4). 2.9 (Part 25): do NOT append
        # the wake message manually — sendWorkbenchMessageStream appends the
        # user message itself (workbench.py:2560), so a manual append here
        # double-wrote it (mirrors automation_memory.deliver_to_bot_chat).
        if from_session:
            wake = (
                f'Message from 🤖 {_handle_for(to_agent)} '
                f'(@{_handle_for(to_agent)}) in reply to your message:\n'
                + (reply or '(the recipient Bot sent no text reply)')
            )
            await _run_turn(from_session, wake, from_agent, runner)
        return 'delivered'
    except Exception:
        logger.debug('dm deliver failed for %s', dm_id, exc_info=True)
        mark_failed(dm_id, REASON_DELIVERY_ERROR)
        return REASON_DELIVERY_ERROR


# ── registration ─────────────────────────────────────────────────────────────


def register() -> None:
    """Register the message_agent tool (offered only in canonical Bot Chats —
    see ``filter_dm_tools``, wired into both tool-definition paths)."""
    from app.services import tool_registry

    tool_registry.register(
        _MESSAGE_AGENT,
        'Send one direct message to another Bot (the ONLY way to contact a '
        'teammate). Compose your OWN short paraphrase of the intent — never '
        'forward the user\'s words verbatim. Runs one headless turn in the '
        'recipient\'s chat; its reply wakes you and you relay it to the user. '
        'Do not ping-pong; do not message a Bot that already has one of your '
        'messages in flight.',
        messageAgent,
        {
            'type': 'object',
            'properties': {
                'target': {
                    'type': 'string',
                    'description': 'The recipient Bot: @handle, name, or display title.',
                },
                'message': {
                    'type': 'string',
                    'description': 'Your own composed message to the recipient (not the user\'s verbatim text).',
                },
            },
            'required': ['target', 'message'],
        },
    )


def messaging_hint(agent_id: str) -> str:
    """The roster + protocol block for a canonical Bot Chat's system context.

    Empty for non-Bot sessions (the gate in ``filter_dm_tools`` keeps the tool
    out of their surface, so the prompt must not advertise it either).
    """
    if not agent_id:
        return ''
    roster = protocol.roster_block()
    if not roster:
        return ''
    return roster + '\n\n' + protocol.MESSAGING_PROTOCOL
