"""Part 19 Phase D — group rooms: deterministic serial rounds (no LLM router).

A room is 2-6 Bots deliberating over a shared, client-owned log. The driver
here is pure control flow: a user send runs ≤ ``MAX_ROUNDS`` serial rounds;
each round's speakers are chosen by a DETERMINISTIC mention parse (names,
display titles, collapsed forms, ``@everyone`` — never a model deciding who
talks); each speaker runs ONE turn in its persistent ``Group: <room>``
session fed only the new room messages; ``(pass)``/empty/failure is silence;
an all-pass round settles the room. Caps (3 rounds / 10 messages per send)
are enforced server-side (ruling OQ3), with a single ``max_rounds`` /
``max_messages`` seam so a later build can make them configurable without
touching the driver.

G-1 (review rounds): a member may end its turn with
``request_review(@reviewer, summary)``; the driver runs one extra round where
only the named reviewer speaks, appends the verdict, and (on ``changes:``)
gives the original member one more turn. Review rounds count against the
round cap. G-2 (escalation parity): a member that blocks twice for the same
cause in one send flips the room's ``needs_you`` badge automatically —
deterministic, no model.

The member runner is injectable (``runner=``) so the caps / pass / settle /
escalation semantics are unit-testable without a live model.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import cast

from app.json_narrowing import as_dict, as_str
from app.services.memory_conn import conn as _conn

logger = logging.getLogger('august.bot_mode.rooms')

_MENTION_RE = re.compile(r'@([\w.-]+)')

# OQ3 ruling: fixed caps, one seam each. A later build may read these from
# brain-config; the driver only ever consults the resolved value.
MAX_ROUNDS = 3
MAX_MESSAGES = 10  # per user send
MIN_MEMBERS = 2
MAX_MEMBERS = 6

_REVIEW_MARK = 'request_review('
_PASS_TOKENS = frozenset({'', '(pass)', 'pass', '[pass]'})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── room store ───────────────────────────────────────────────────────────────


def create_room(name: str, members: list[str]) -> int:
    clean = [m for m in dict.fromkeys(members) if m]
    if len(clean) < MIN_MEMBERS or len(clean) > MAX_MEMBERS:
        raise ValueError(f'a room needs {MIN_MEMBERS}-{MAX_MEMBERS} distinct members')
    try:
        c = _conn()
        cur = c.execute(
            'INSERT INTO bot_room (name, members, created_at) VALUES (?, ?, ?)',
            ((name or 'Room').strip()[:120], json.dumps(clean), _now()),
        )
        c.commit()
        return int(cur.lastrowid or 0)
    except Exception:
        logger.debug('create_room failed', exc_info=True)
        return 0


def _needs_you(row: dict[str, object]) -> bool:
    """The SQLite INTEGER 0/1 badge → bool (as_bool only accepts real bools)."""
    try:
        return bool(int(str(row.get('needs_you') or 0)))
    except (TypeError, ValueError):
        return False


def get_room(room_id: int) -> dict[str, object] | None:
    try:
        row = _conn().execute('SELECT * FROM bot_room WHERE id = ?', (room_id,)).fetchone()
        if row is None:
            return None
        out = dict(row)
        try:
            out['members'] = json.loads(str(out.get('members') or '[]'))
        except (json.JSONDecodeError, TypeError):
            out['members'] = []
        out['needs_you'] = _needs_you(out)
        return out
    except Exception:
        return None


def list_rooms() -> list[dict[str, object]]:
    try:
        rows = _conn().execute('SELECT * FROM bot_room ORDER BY id DESC').fetchall()
        out: list[dict[str, object]] = []
        for r in rows:
            d = dict(r)
            try:
                d['members'] = json.loads(str(d.get('members') or '[]'))
            except (json.JSONDecodeError, TypeError):
                d['members'] = []
            d['needs_you'] = _needs_you(d)
            out.append(d)
        return out
    except Exception:
        return []


def delete_room(room_id: int) -> bool:
    try:
        c = _conn()
        c.execute('DELETE FROM bot_room_message WHERE room_id = ?', (room_id,))
        cur = c.execute('DELETE FROM bot_room WHERE id = ?', (room_id,))
        c.commit()
        return bool(cur.rowcount)
    except Exception:
        return False


def set_needs_you(room_id: int, value: bool) -> None:
    try:
        c = _conn()
        c.execute('UPDATE bot_room SET needs_you = ? WHERE id = ?', (1 if value else 0, room_id))
        c.commit()
    except Exception:
        logger.debug('set_needs_you failed', exc_info=True)


def add_message(room_id: int, sender_agent: str, body: str, kind: str = 'message') -> int:
    try:
        c = _conn()
        cur = c.execute(
            'INSERT INTO bot_room_message (room_id, sender_agent, body, kind, created_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (room_id, sender_agent, body, kind, _now()),
        )
        c.commit()
        return int(cur.lastrowid or 0)
    except Exception:
        logger.debug('add_message failed', exc_info=True)
        return 0


def room_log(room_id: int, limit: int = 200) -> list[dict[str, object]]:
    try:
        rows = _conn().execute(
            'SELECT * FROM bot_room_message WHERE room_id = ? ORDER BY id ASC LIMIT ?',
            (room_id, max(1, int(limit))),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _last_message_id(room_id: int) -> int:
    try:
        row = _conn().execute(
            'SELECT MAX(id) AS m FROM bot_room_message WHERE room_id = ?', (room_id,)
        ).fetchone()
        return int(row['m'] or 0) if row and row['m'] is not None else 0
    except Exception:
        return 0


def _new_messages_since(room_id: int, since_id: int) -> list[dict[str, object]]:
    try:
        rows = _conn().execute(
            'SELECT * FROM bot_room_message WHERE room_id = ? AND id > ? ORDER BY id ASC',
            (room_id, since_id),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


# ── deterministic mention parse ──────────────────────────────────────────────


def parse_mentions(text: str, members: list[str]) -> list[str]:
    """Which members does ``text`` address? Deterministic, no model.

    Matches @handle, display title (collapsed, no spaces), and ``@everyone``.
    Returns member ids in roster order, de-duplicated. ``@everyone`` → all.
    Unknown handles are ignored (they pass through as plain text elsewhere).
    """
    from app.services.bot_mode import roster

    if not text:
        return []
    low = text.lower()
    if '@everyone' in low:
        return list(members)
    # Build handle/title → id for the member set only.
    key_to_id: dict[str, str] = {}
    for mid in members:
        bot = roster.get_bot(mid)
        if not bot:
            continue
        name = as_str(bot.get('name'))
        title = as_str(as_dict(bot.get('uiMeta'), {}).get('title'))
        if name:
            key_to_id[name.lower()] = mid
            key_to_id[name.lower().replace(' ', '')] = mid
        if title:
            key_to_id[title.lower().replace(' ', '')] = mid
    found: set[str] = set()
    for m in _MENTION_RE.finditer(text):
        tok = (m.group(1) or '').lower().replace(' ', '')
        matched = key_to_id.get(tok) or key_to_id.get((m.group(1) or '').lower())
        if matched and matched in members:
            found.add(matched)
    return [mid for mid in members if mid in found]


def parse_request_review(text: str) -> tuple[str, str] | None:
    """Detect ``request_review(@reviewer, summary)`` in a member's turn.

    Returns ``(reviewer_token, summary)`` or None. Deterministic string parse.
    """
    idx = (text or '').find(_REVIEW_MARK)
    if idx == -1:
        return None
    rest = text[idx + len(_REVIEW_MARK) :]
    close = rest.find(')')
    if close == -1:
        return None
    inner = rest[:close]
    reviewer, _, summary = inner.partition(',')
    return reviewer.strip().lstrip('@').strip(), summary.strip()


# ── member sessions (persistent Group: <room> per member) ────────────────────


def member_session(room_id: int, agent_id: str):
    """Find-or-create the member's persistent ``Group: <room>`` session.

    Stamped ``botAgentId`` (so M-2 scope + the DM/room run context resolve)
    and ``botRoom`` (the room id) so the log is attributable + isolated.
    """
    from app.services.bot_mode import roster
    from app.services.workbench import sessions as sessions_mod

    room = get_room(room_id)
    room_name = as_str((room or {}).get('name'), f'room {room_id}')
    for s in list(sessions_mod._sessions.values()):
        meta = getattr(s, 'metadata', None)
        if isinstance(meta, dict) and as_str(meta.get('botRoom')) == str(room_id) and as_str(meta.get('botAgentId')) == agent_id:
            return s
    chat = roster.ensure_canonical_bot_chat(agent_id)  # ensures the agent exists
    _ = chat
    sess = sessions_mod.create_workbench_session(agentId=agent_id, guardMode='full')
    sess.title = f'Group: {room_name}'
    meta = dict(sess.metadata or {})
    meta['botRoom'] = str(room_id)
    meta['botAgentId'] = agent_id
    sess.metadata = meta
    sessions_mod.save_sessions(immediate=True)
    return sess


def _default_runner() -> Callable[..., Awaitable[None]]:
    from app.services.workbench import workbench as wb

    return cast(Callable[..., Awaitable[None]], wb.sendWorkbenchMessageStream)


async def _member_turn(
    room_id: int, agent_id: str, feed: list[dict[str, object]], runner: object
) -> str:
    """Run one member turn over the new room messages; return its text."""
    sess = member_session(room_id, agent_id)
    lines = []
    for m in feed:
        who = 'the user' if as_str(m.get('sender_agent')) == 'user' else f'@{_handle(agent_id, m)}'
        lines.append(f'{who}: {as_str(m.get("body"))}')
    prompt = (
        f'You are in the group room "{_room_name(room_id)}" with your teammates. '
        'Respond to the new messages below with your own short contribution, or reply '
        '(pass) to stay silent. You may ask a teammate to review your work by ending '
        'with request_review(@teammate, what to check).\n\n' + '\n'.join(lines)
    )
    from app.services.workbench.emit_types import ASSISTANT_TEXT_EMIT_TYPES

    parts: list[str] = []

    def emit(ev: dict[str, object]) -> None:
        if isinstance(ev, dict) and ev.get('type') in ASSISTANT_TEXT_EMIT_TYPES and ev.get('content'):
            parts.append(as_str(ev['content']))

    run = cast(Callable[..., Awaitable[None]], runner or _default_runner())
    await run(sessionId=sess.id, message=prompt, agentId=agent_id, emit=emit)
    return ''.join(parts).strip()


def _handle(_agent_id: str, msg: dict[str, object]) -> str:
    from app.services.bot_mode import roster

    sender = as_str(msg.get('sender_agent'))
    bot = roster.get_bot(sender)
    return as_str(bot.get('name')) if bot else sender


def _room_name(room_id: int) -> str:
    room = get_room(room_id)
    return as_str((room or {}).get('name'), '')


# ── the round driver ─────────────────────────────────────────────────────────


async def run_room(
    room_id: int,
    user_text: str,
    *,
    runner: object = None,
    max_rounds: int = 0,
    max_messages: int = 0,
) -> dict[str, object]:
    """Drive one user send through the room. Deterministic + capped.

    Round 1 speakers = the members the user @-mentioned (or all, if none).
    Each speaker runs one turn over only the new room messages. A ``(pass)``/
    empty/failed turn is silence (a ``pass`` row, not a message). A member may
    request a review → the next round is ONLY the named reviewer (a ``verdict``
    row); a ``changes:`` verdict gives the requesting member one revision turn.
    Members can @-pull each other mid-room. An all-pass round settles the room.
    Caps: ``max_rounds`` rounds, ``max_messages`` member messages per send
    (review rounds count against the round cap — G-1). Two consecutive blocks
    by one member flips ``needs_you`` (G-2). Returns a summary; the room log
    is the source of truth the UI reads afterward.
    """
    room = get_room(room_id)
    if not room:
        return {'error': 'no such room', 'rounds': 0, 'messages': 0}
    members = [str(m) for m in cast(list, room.get('members') or [])]
    if not members:
        return {'error': 'empty room', 'rounds': 0, 'messages': 0}
    rounds_cap = max_rounds or MAX_ROUNDS
    msgs_cap = max_messages or MAX_MESSAGES

    add_message(room_id, 'user', (user_text or '').strip(), 'message')
    messages_used = 0
    last_seen = {m: 0 for m in members}
    consecutive_blocks = {m: 0 for m in members}
    escalated = False

    # Explicit round plan: `speakers` is who talks this round; `review` /
    # `revision` carry the G-1 one-shot follow-ups.
    speakers: list[str] = parse_mentions(user_text, members) or list(members)
    review: tuple[str, str] | None = None  # (reviewer_id, summary)
    review_requester = ''                  # member who asked for the review
    revision: str = ''                     # member owed a revision turn
    # 2.10 (Part 25): the reviewer speaks in the NEXT round, so the verdict
    # marker must survive the round boundary — `review` is cleared when we
    # schedule the round, so track the pending reviewer separately.
    pending_verdict_for = ''
    rounds_run = 0

    for _round in range(rounds_cap):
        if not speakers:
            break
        rounds_run += 1
        round_productive = False
        pulled: list[str] = []

        for agent in list(speakers):
            if messages_used >= msgs_cap:
                break
            feed = _new_messages_since(room_id, last_seen.get(agent, 0))
            last_seen[agent] = _last_message_id(room_id)
            try:
                out = await _member_turn(room_id, agent, feed, runner)
            except Exception:
                logger.debug('room member turn failed', exc_info=True)
                out = ''
            review_req = parse_request_review(out)
            if out.strip().lower() in _PASS_TOKENS:
                consecutive_blocks[agent] += 1
                add_message(room_id, agent, '(pass)', 'pass')
                if consecutive_blocks[agent] >= 2 and not escalated:
                    set_needs_you(room_id, True)
                    add_message(room_id, agent, 'needs the user (blocked twice)', 'escalation')
                    escalated = True
                continue
            consecutive_blocks[agent] = 0
            round_productive = True
            messages_used += 1
            is_verdict = bool(pending_verdict_for) and agent == pending_verdict_for
            add_message(room_id, agent, out, 'verdict' if is_verdict else 'message')
            if is_verdict:
                pending_verdict_for = ''
            verdict_wants_changes = is_verdict and 'changes' in out.lower()
            pulled += [m for m in parse_mentions(out, members) if m != agent]
            if review_req and review is None:
                rid = next((m for m in members if _matches_handle(m, review_req[0])), '')
                if rid and rid != agent:
                    review = (rid, review_req[1])
                    review_requester = agent
            if verdict_wants_changes:
                revision = review_requester

        # Decide next round's speakers (priority: review > revision > pulls).
        if review is not None:
            reviewer = review[0]
            review = None
            pending_verdict_for = reviewer  # 2.10: mark the review round's turn
            speakers = [reviewer]
        elif revision:
            who = revision
            revision = ''
            speakers = [who]
        elif not round_productive:
            break  # all-pass round → settle
        else:
            speakers = [m for m in dict.fromkeys(pulled) if m in members]

    return {
        'rounds': rounds_run,
        'messages': messages_used,
        'settled': True,
        'escalated': escalated,
        'needsYou': escalated,
    }


def _matches_handle(agent_id: str, token: str) -> bool:
    from app.services.bot_mode import roster

    tok = (token or '').lower().replace(' ', '')
    bot = roster.get_bot(agent_id)
    if not bot:
        return False
    name = as_str(bot.get('name')).lower()
    title = as_str(as_dict(bot.get('uiMeta'), {}).get('title')).lower().replace(' ', '')
    return tok in (name, title)
