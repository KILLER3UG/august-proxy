"""`board` tool — the durable multi-agent task board, reachable from a turn.

The board already tracked work items with ``agentId``/``sessionId``/``taskId``
fields, but only the desktop UI could touch it and it lived in that browser's
localStorage: an agent could not read the queue, claim a card, or hand work to
another agent, which is what those fields were for. One tool with an ``action``
argument rather than six, because the tool surface is a per-model budget and
listing is almost always what the model wants first.

Writes land in ``app/services/kanban_store.py`` — the same store the UI reads,
so a card an agent claims is on screen in the other window immediately.
"""

from __future__ import annotations

from app.json_narrowing import as_int, as_str
from app.services import kanban_store as store
from app.services import tool_registry

ACTIONS = ('list', 'add', 'move', 'claim', 'done', 'drop')
_MAX_LIST = 40


def _current_session_id() -> str:
    """Best-effort: a card stamped with the wrong session is worse than one
    with no session, so any failure here just omits the field."""
    try:
        from app.services.workbench.context import currentSessionId

        return as_str(currentSessionId.get(), '')
    except Exception:
        return ''


def _line(card: dict[str, object]) -> str:
    cid = as_str(card.get('id'))
    short = cid[:12] if len(cid) > 12 else cid
    bits = [f'{short} [{as_str(card.get("column"), "?")}]', as_str(card.get('title'))]
    agent = as_str(card.get('agentId'))
    if agent:
        bits.append(f'@{agent}')
    return ' - ' + ' '.join(b for b in bits if b)


def _summary(cards: list[dict[str, object]]) -> str:
    if not cards:
        return 'Board is empty.'
    by_col: dict[str, int] = {}
    for card in cards:
        col = as_str(card.get('column'), '?')
        by_col[col] = by_col.get(col, 0) + 1
    shown = cards[:_MAX_LIST]
    lines = [
        ' · '.join(f'{col} {n}' for col, n in sorted(by_col.items())),
        *[
            _line(c)
            for c in sorted(shown, key=lambda c: (as_str(c.get('column')), -as_int(c.get('createdAt'), 0)))
        ],
    ]
    if len(cards) > len(shown):
        lines.append(f'… {len(cards) - len(shown)} more (use column= to narrow)')
    return '\n'.join(lines)


async def _board(
    action: str = 'list',
    title: str = '',
    column: str = '',
    cardId: str = '',
    body: str = '',
    agentId: str = '',
) -> str:
    act = as_str(action, 'list').strip().lower()
    if act not in ACTIONS:
        return f'Error: unknown action "{act}". Use one of: {", ".join(ACTIONS)}.'

    if act == 'list':
        wanted = as_str(column).strip().lower()
        if wanted and wanted not in store.COLUMNS:
            return f'Error: unknown column "{wanted}". Use one of: {", ".join(sorted(store.COLUMNS))}.'
        return _summary(await store.list_cards_async(wanted or None))

    cid = as_str(cardId).strip()
    if act == 'add':
        clean = as_str(title).strip()
        if not clean:
            return 'Error: add needs a title.'
        wanted = as_str(column).strip().lower() or store.DEFAULT_COLUMN
        if wanted not in store.COLUMNS:
            return f'Error: unknown column "{wanted}". Use one of: {", ".join(sorted(store.COLUMNS))}.'
        try:
            card = await store.add_card_async(
                clean,
                column=wanted,
                body=as_str(body),
                agentId=as_str(agentId).strip(),
                sessionId=_current_session_id(),
            )
        except ValueError as exc:
            return f'Error: {exc}'
        return f'Added {_line(card).strip()} — id {as_str(card.get("id"))}'

    if not cid:
        return f'Error: {act} needs cardId (the id shown by list).'
    try:
        if act == 'drop':
            removed = await store.remove_card_async(cid)
            return f'Dropped {cid}.' if removed else f'Error: no card with id {cid}.'
        if act == 'done':
            moved = await store.patch_card_async(cid, {'column': 'done'})
        elif act == 'claim':
            patch: dict[str, object] = {'column': 'doing'}
            who = as_str(agentId).strip()
            if who:
                patch['agentId'] = who
            moved = await store.patch_card_async(cid, patch)
        else:
            wanted = as_str(column).strip().lower()
            if not wanted:
                return 'Error: move needs column (backlog|doing|review|done).'
            if wanted not in store.COLUMNS:
                return f'Error: unknown column "{wanted}". Use one of: {", ".join(sorted(store.COLUMNS))}.'
            moved = await store.patch_card_async(cid, {'column': wanted})
    except ValueError as exc:
        return f'Error: {exc}'
    if moved is None:
        return f'Error: no card with id {cid}.'
    return f'Moved {_line(moved).strip()}'


def register() -> None:
    """Register the shared task board tool."""
    tool_registry.register(
        'board',
        (
            'Read and update the durable task board shared by every agent, job and window. '
            'Actions: list [column], add (title, optional column/body/agentId), move '
            '(cardId, column), claim (cardId [, agentId]) → doing, done (cardId), drop '
            '(cardId). Use it to pick up the next backlog item, to record work another '
            'agent should do, or to mark a card finished when you complete it. Card ids come '
            'from list; do not invent them.'
        ),
        _board,
        {
            'type': 'object',
            'properties': {
                'action': {'type': 'string', 'enum': list(ACTIONS)},
                'title': {'type': 'string', 'description': 'Card title (add).'},
                'column': {
                    'type': 'string',
                    'enum': sorted(store.COLUMNS),
                    'description': 'Filter for list, target for add/move.',
                },
                'cardId': {'type': 'string', 'description': 'Card id, as returned by list.'},
                'body': {'type': 'string', 'description': 'Optional longer detail (add).'},
                'agentId': {
                    'type': 'string',
                    'description': 'Who owns the card (add/claim). Omit to leave the owner as is.',
                },
            },
            'required': ['action'],
        },
        keywords=['board', 'kanban', 'task', 'queue', 'claim', 'handoff', 'backlog'],
    )
