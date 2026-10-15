"""Teammate DMs: the single ``message_agent`` send path.

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

A third cap exists because those two do not cover a three-Bot cycle: an
opt-in ceiling on how long a chat may keep taking turns with no human in it
(see ``_unattendedRun``).

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

from app.json_narrowing import as_dict, as_int, as_str
from app.services.bot_mode import protocol
from app.services.memory_conn import commit as brain_commit
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
# The unattended ceiling (see ``_unattendedRun``): the chat has kept working on
# Bot-authored turns with no human in it.
REASON_UNATTENDED = 'unattended_budget'

# The shape a delivered Bot turn takes in a chat transcript: the DM body and the
# sender wake are BOTH built from this prefix, in this module. It is the marker
# `_unattendedRun` reads, so the two writers and the reader cannot drift apart —
# a new inbound author kind that does not join this prefix silently never counts
# toward the unattended ceiling.
# (``messages.source`` is the sanctioned provenance column, but a delivered DM
# is appended by the turn loop, which tags the human's own text — so until that
# path learns a source, the prefix is what identifies a Bot-authored row.)
BOT_TURN_PREFIX = 'Message from 🤖 '

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
        brain_commit(c)
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
        brain_commit(c)
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


# ── unattended ceiling ───────────────────────────────────────────────────────
# The loop's own runaway backstop cannot see this failure class. It counts world
# delta inside ONE turn, and every DM hop is a FRESH turn in a DIFFERENT session
# — so two or three Bots handing one ask back and forth never look like a spin:
# each individual turn ends `finished`. `has_inflight` caps one (from→to) pair
# and `rooms.MAX_ROUNDS` caps one user send, but an A→B→C→A cycle is neither.
# The one thing that bounds it is a ceiling on how long a Bot chat may keep
# working with no human in it — DeepSeek-Bot's `MAX_UNATTENDED_MESSAGES`, whose
# comment is the whole design: "reset only by a human".
#
# Opt-in, like every rule here that can stop work: an absent or 0 key leaves the
# ceiling off (`maxUnattendedTurns`), the same convention as the runaway backstop
# and the budget ladder.


def _unattendedCeiling() -> int:
    """brain-config `maxUnattendedTurns`; 0 (or unreadable) means OFF."""
    try:
        from app.services.brain_config_service import getRuntimeConfig

        return max(0, as_int(getRuntimeConfig().get('maxUnattendedTurns'), 0))
    except Exception:
        logger.debug('unattended ceiling read failed; stays off', exc_info=True)
        return 0


# The provenance values (migration 049) that mean "this user-role row was not a
# human speaking now". `queued_user` is DELIBERATELY absent: a queued message is
# the human typing mid-turn (`workbench.py` wraps it in `<queued_message>`), and
# that is exactly the reset this ceiling is defined against — counting it would
# make a human reply *extend* the run it is supposed to end. Enumerated instead
# of derived from `message_sources.MACHINE_SOURCES` so a new plumbing source has
# to be chosen here; defaulting an unknown value to "human" keeps the ceiling
# lenient rather than locking a chat out.
_NON_HUMAN_SOURCES: frozenset[str] = frozenset(
    {'harness_nudge', 'subagent_results', 'memory_delivery', 'live_transcript'}
)


def _isBotAuthoredTurn(content: object, source: object) -> bool:
    """True when a user-role transcript row was written by a Bot, not a human.

    ``content`` is stored JSON-encoded, so it is decoded before the prefix test:
    comparing the raw column against ``BOT_TURN_PREFIX`` would be comparing it
    against a leading quote and would find NO human row ever — the trap
    AGENTS.md records for the fact/KV read doors, and turning a runaway ceiling
    into a lockout is the worse direction for a mistake. A row whose provenance
    says it was not a human speaking now also cannot reset the run.

    A structured payload (a dict/list the session writer persisted for an
    attachment turn) is not a Bot's message text, so it reads as a reset.
    """
    if as_str(source, '') in _NON_HUMAN_SOURCES:
        return True
    if not isinstance(content, str) or not content:
        return False
    try:
        decoded = json.loads(content) if content.startswith('"') else content
    except Exception:
        decoded = content
    return isinstance(decoded, str) and decoded.startswith(BOT_TURN_PREFIX)


def _unattendedRun(sessionId: str, ceiling: int) -> int:
    """Bot-authored turns at the tail of this chat, capped at `ceiling`.

    The scan stops at the first human user row — that is the reset — and reads
    at most `ceiling` rows, so the cost is bounded by the ceiling rather than by
    the length of the chat and the answer cannot exceed the number the caller is
    comparing against. Reads the persisted transcript, not the in-memory
    session: the turn loop flushes the arriving Bot message at the
    model-dispatch barrier (`flush_session_barrier(..., currentMessages)`), so
    the row this very turn is reacting to is already in the table, and a restart
    cannot launder a runaway.
    """
    if not sessionId or ceiling <= 0:
        return 0
    try:
        rows = _conn().execute(
            "SELECT content, source FROM messages WHERE session_id = ? AND role = 'user' "
            'ORDER BY id DESC LIMIT ?',
            (sessionId, ceiling),
        ).fetchall()
    except Exception:
        logger.debug('unattended run read failed', exc_info=True)
        return 0
    run = 0
    for row in rows:
        if not _isBotAuthoredTurn(row['content'], row['source']):
            break
        run += 1
    return run


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
    sender_session = as_str(getattr(session, 'id', ''))
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
    # Unattended ceiling (opt-in; see the section above). This is the model's
    # door, NOT the store's: `POST /api/agents/dm` delivers a message the human
    # asked for, and a human send is the reset that makes the next Bot turn
    # legal, so gating it would turn the guard into a lockout.
    ceiling = _unattendedCeiling()
    if ceiling > 0:
        run = _unattendedRun(sender_session, ceiling)
        if run >= ceiling:
            return _err(
                f'This chat has taken {run} Bot-authored turns since a human last '
                f'spoke in it, which is the ceiling for unattended Bot work '
                f'(maxUnattendedTurns={ceiling}). Do not message another Bot — '
                'summarise where things stand and ask the user, who can reset the '
                'run by replying.',
                reason_code=REASON_UNATTENDED,
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
    attributed = (
        f'{BOT_TURN_PREFIX}{_handle_for(sender_agent)} (@{_handle_for(sender_agent)}):\n{body}'
    )
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
        # the sender relays it to the user. 2.9: do NOT append
        # the wake message manually — sendWorkbenchMessageStream appends the
        # user message itself (workbench.py:2560), so a manual append here
        # double-wrote it (mirrors automation_memory.deliver_to_bot_chat).
        if from_session:
            wake = (
                f'{BOT_TURN_PREFIX}{_handle_for(to_agent)} '
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
