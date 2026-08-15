"""Selected-model review of brain memories.

The user's chat model (not a hidden hippocampus role) reads recent
auto_memories and proposes improve / remove / enhance. Nothing is applied
until the user accepts an item.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.json_narrowing import as_dict, as_int, as_list, as_str

logger = logging.getLogger(__name__)

_SYSTEM = (
    'You are reviewing August\'s long-term memory for one user. '
    'Suggest only high-confidence changes. Never invent biographical facts. '
    'Return JSON only, no markdown.'
)

_JSON_RE = re.compile(r'\{[\s\S]*\}')


def _preview(content: object, n: int = 280) -> str:
    if isinstance(content, str):
        text = content.strip()
    else:
        try:
            text = json.dumps(content, default=str)
        except TypeError:
            text = str(content)
    text = re.sub(r'\s+', ' ', text)
    return text if len(text) <= n else text[: n - 1] + '…'


def collect_review_payload(limit: int = 80) -> dict[str, Any]:
    from app.services.memory_store import _conn

    conn = _conn()
    memories = [
        {
            'id': int(r['id']),
            'key': as_str(r['key']),
            'preview': _preview(r['content']),
            'source': as_str(r['source'] or 'auto'),
            'pinned': bool(r['pinned']),
            'importance': float(r['importance'] or 0),
            'category': as_str(r['category'] or ''),
        }
        for r in conn.execute(
            'SELECT id, key, content, source, pinned, importance, category '
            'FROM auto_memories ORDER BY pinned DESC, importance DESC, id DESC LIMIT ?',
            (limit,),
        ).fetchall()
    ]
    heuristics = [
        {'id': int(r['id']), 'rule': _preview(r['rule'], 200)}
        for r in conn.execute(
            'SELECT id, rule FROM learned_heuristics ORDER BY id DESC LIMIT 40'
        ).fetchall()
    ]
    return {'memories': memories, 'heuristics': heuristics}


def parse_review_plan(raw: str) -> dict[str, list[dict[str, Any]]]:
    """Parse model JSON into capped improve/remove/enhance lists."""
    empty: dict[str, list[dict[str, Any]]] = {'improve': [], 'remove': [], 'enhance': []}
    text = (raw or '').strip()
    if not text:
        return empty
    match = _JSON_RE.search(text)
    if not match:
        return empty
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return empty
    if not isinstance(data, dict):
        return empty

    improve: list[dict[str, Any]] = []
    for item in as_list(data.get('improve'), [])[:5]:
        row = as_dict(item)
        mid = as_int(row.get('id'), 0)
        rewritten = as_str(row.get('rewritten') or row.get('text'), '').strip()
        if mid > 0 and rewritten:
            improve.append(
                {
                    'id': mid,
                    'rewritten': rewritten[:800],
                    'why': as_str(row.get('why'), '')[:240],
                }
            )

    remove: list[dict[str, Any]] = []
    for item in as_list(data.get('remove'), [])[:5]:
        row = as_dict(item)
        mid = as_int(row.get('id'), 0)
        if mid > 0:
            remove.append({'id': mid, 'why': as_str(row.get('why'), '')[:240]})

    enhance: list[dict[str, Any]] = []
    for item in as_list(data.get('enhance'), [])[:5]:
        row = as_dict(item)
        content = as_str(row.get('content') or row.get('text'), '').strip()
        if content:
            enhance.append(
                {
                    'content': content[:800],
                    'why': as_str(row.get('why'), '')[:240],
                }
            )

    return {'improve': improve, 'remove': remove, 'enhance': enhance}


async def _call_selected_model(model_id: str, prompt: str) -> str:
    from app.providers import resolver as provider_resolver
    from app.providers.clients import getClient
    from app.providers.model_resolver import resolve as resolve_model
    from app.services.workbench import model_fleet

    chosen = (model_id or '').strip()
    if not chosen:
        chosen = as_str(model_fleet.getModelForRole('hippocampus'), '')
    if not chosen:
        return ''
    try:
        resolved = resolve_model(chosen)
    except Exception:
        resolved = {}
    model_name = as_str(resolved.get('model'), chosen)
    provider_name = as_str(resolved.get('provider'), '')
    provider = provider_resolver.resolve(provider_name or model_name)
    if not provider:
        available = [p for p in provider_resolver.list_available() if p.get('api_key')]
        provider = available[0] if available else None
    if not provider:
        return ''
    cfg = dict(provider)
    cfg['model'] = model_name
    cfg['defaultModel'] = model_name
    client = getClient(cfg)
    if not client or not hasattr(client, 'generate'):
        return ''
    try:
        client.config['model'] = model_name
    except Exception:
        pass
    try:
        return (await client.generate(prompt, system=_SYSTEM)) or ''
    except Exception:
        logger.debug('memory review model call failed', exc_info=True)
        return ''


async def run_memory_review(model_id: str = '') -> dict[str, Any]:
    payload = collect_review_payload()
    memories = payload['memories']
    heuristics = payload['heuristics']
    if not memories and not heuristics:
        return {
            'model': model_id,
            'improve': [],
            'remove': [],
            'enhance': [],
            'message': 'Nothing in memory yet to review.',
        }
    prompt = (
        'Review this user memory store. Propose at most 5 of each action.\n'
        'JSON shape:\n'
        '{"improve":[{"id":int,"rewritten":str,"why":str}],'
        '"remove":[{"id":int,"why":str}],'
        '"enhance":[{"content":str,"why":str}]}\n'
        'improve = rewrite a noisy/duplicate memory (use its id).\n'
        'remove = stale, wrong, or duplicate auto memories (not pinned user facts unless clearly wrong).\n'
        'enhance = one new standing preference that should be always-included.\n'
        f'Memories ({len(memories)}):\n{json.dumps(memories, default=str)[:6000]}\n\n'
        f'Heuristics ({len(heuristics)}):\n{json.dumps(heuristics, default=str)[:2000]}\n'
    )
    raw = await _call_selected_model(model_id, prompt)
    plan = parse_review_plan(raw)
    known = {m['id'] for m in memories}
    plan['improve'] = [x for x in plan['improve'] if x['id'] in known]
    plan['remove'] = [x for x in plan['remove'] if x['id'] in known]
    used = as_str(model_id) or 'default'
    return {
        'model': used,
        'memoryCount': len(memories),
        **plan,
        'message': '' if (plan['improve'] or plan['remove'] or plan['enhance']) else 'Looks healthy — no changes suggested.',
    }


def apply_review_actions(actions: list[dict[str, Any]]) -> dict[str, int]:
    from app.services.memory.auto_memory import (
        delete_auto_memory,
        saveAutoMemory,
        update_auto_memory,
    )

    applied = {'improved': 0, 'removed': 0, 'enhanced': 0}
    for raw in actions:
        row = as_dict(raw)
        kind = as_str(row.get('kind') or row.get('action'), '').lower()
        if kind == 'improve':
            mid = as_int(row.get('id'), 0)
            text = as_str(row.get('rewritten') or row.get('content'), '').strip()
            if mid and text and update_auto_memory(mid, content=text):
                applied['improved'] += 1
        elif kind == 'remove':
            mid = as_int(row.get('id'), 0)
            if mid and delete_auto_memory(mid):
                applied['removed'] += 1
        elif kind == 'enhance':
            text = as_str(row.get('content'), '').strip()
            if not text:
                continue
            saveAutoMemory(
                key=f'user:{text[:48]}',
                content=text,
                category='preference',
                importance=0.88,
                source='user',
                pinned=True,
            )
            applied['enhanced'] += 1
    return applied
