"""Selected-model review of brain memories and skills."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.json_narrowing import as_dict, as_int, as_list, as_str

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are reviewing August's long-term memory and skills for one user. "
    "Suggest only high-confidence changes. Never invent biographical facts. "
    "You can see the current skills catalogue \u2014 before creating a new skill, "
    "search it and prefer patching an existing one. Only propose a skill when "
    "a multi-step workflow was completed successfully and is genuinely reusable "
    "(not single-turn Q&A). Return JSON only, no markdown."
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


def collect_review_payload(
    limit: int = 80,
    origin: str = 'all',
    folder_id: str = '',
    session_id: str = '',
) -> dict[str, Any]:
    from app.services.memory.auto_memory import list_all_auto_memories
    if origin.strip().lower() in ('recalled', 'added') or folder_id or session_id:
        items = list_all_auto_memories(
            origin=origin if origin.strip().lower() in ('recalled', 'added') else 'all',
            folder_id=folder_id,
            session_id=session_id,
            include_telemetry=False,
        )[: max(1, min(limit, 200))]
        memories = [
            {
                'id': int(m.get('id') or 0),
                'key': as_str(m.get('key')),
                'preview': _preview(m.get('content') if m.get('content') is not None else m.get('summary') or ''),
                'source': as_str(m.get('source') or 'auto'),
                'pinned': bool(m.get('pinned')),
                'importance': float(m.get('importance') or 0),
                'category': as_str(m.get('category') or ''),
                'confidence': float(m.get('confidence') or 0.7),
                'expiresAt': as_str(m.get('expiresAt') or m.get('expires_at') or ''),
            }
            for m in items
        ]
    else:
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
    # skills catalogue so model can check before proposing
    skills: list[dict[str, Any]] = []
    try:
        from app.services import skill_service
        for s in skill_service.catalogue()[:40]:
            skills.append({'name': str(s.get('name') or ''), 'description': str(s.get('description') or '')[:80], 'trigger': str(s.get('trigger') or '')[:60]})
    except Exception:
        pass
    pending: list[dict[str, Any]] = []
    try:
        from app.services.memory_store import _conn as _conn2
        c = _conn2()
        for r in c.execute("SELECT name, description FROM pending_skills WHERE status='pending' LIMIT 20").fetchall():
            pending.append({'name': str(r['name'] or ''), 'description': str(r['description'] or '')[:80]})
    except Exception:
        pass
    # Heuristics in scope branch need conn
    try:
        from app.services.memory_store import _conn as _conn3
        cc = _conn3()
        heuristics = [{'id': int(r['id']), 'rule': _preview(r['rule'], 200)} for r in cc.execute('SELECT id, rule FROM learned_heuristics ORDER BY id DESC LIMIT 40').fetchall()]
    except Exception:
        heuristics = []
    # Cross-loop awareness (round-5 unification): recent decisions by the
    # other curators so the review does not redo or contradict them.
    recent_curation: list[dict[str, Any]] = []
    try:
        from app.services.memory.curation_ledger import recent as _ledgerRecent

        recent_curation = [
            {
                'actor': str(r.get('actor') or ''),
                'action': str(r.get('action') or ''),
                'targetKind': str(r.get('target_kind') or ''),
                'targetKey': str(r.get('target_key') or ''),
                'reason': str(r.get('reason') or '')[:120],
            }
            for r in _ledgerRecent(15)
        ]
    except Exception:
        pass
    return {
        'memories': memories,
        'heuristics': heuristics,
        'skills': skills,
        'pendingSkills': pending,
        'recentCuration': recent_curation,
    }


def parse_review_plan(raw: str) -> dict[str, list[dict[str, Any]]]:
    empty: dict[str, list[dict[str, Any]]] = {'improve': [], 'remove': [], 'enhance': [], 'skills': []}
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
            improve.append({'id': mid, 'rewritten': rewritten[:800], 'why': as_str(row.get('why'), '')[:240]})
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
            enhance.append({'content': content[:800], 'why': as_str(row.get('why'), '')[:240]})
    skills_out: list[dict[str, Any]] = []
    for item in as_list(data.get('skills'), [])[:5]:
        row = as_dict(item)
        action = as_str(row.get('action'), 'create').strip().lower()
        if action not in ('create', 'patch', 'delete'):
            action = 'create'
        name = as_str(row.get('name'), '').strip()[:64]
        if not name:
            continue
        skills_out.append({'action': action, 'name': name, 'description': as_str(row.get('description'), '')[:60], 'body': as_str(row.get('body'), '')[:4000], 'trigger': as_str(row.get('trigger'), '')[:60], 'why': as_str(row.get('why'), '')[:240]})
    merge: list[dict[str, Any]] = []
    for item in as_list(data.get('merge'), [])[:5]:
        row = as_dict(item)
        keep_id = as_int(row.get('keepId') or row.get('keep_id'), 0)
        remove_ids = [i for i in (as_int(x, 0) for x in as_list(row.get('removeIds') or row.get('remove_ids'), [])) if i > 0]
        merged_text = as_str(row.get('mergedText') or row.get('merged') or row.get('text'), '').strip()
        if keep_id > 0 and remove_ids and merged_text:
            merge.append({'keepId': keep_id, 'removeIds': remove_ids[:5], 'mergedText': merged_text[:800], 'why': as_str(row.get('why'), '')[:240]})
    return {'improve': improve, 'remove': remove, 'enhance': enhance, 'skills': skills_out, 'merge': merge}


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


async def run_memory_review(
    model_id: str = '',
    origin: str = 'all',
    folder_id: str = '',
    session_id: str = '',
) -> dict[str, Any]:
    payload = collect_review_payload(origin=origin, folder_id=folder_id, session_id=session_id)
    memories = payload['memories']
    heuristics = payload['heuristics']
    skills = payload.get('skills', [])
    pending = payload.get('pendingSkills', [])
    if not memories and not heuristics:
        return {'model': model_id, 'improve': [], 'remove': [], 'enhance': [], 'skills': [], 'message': 'Nothing in memory yet to review.'}
    prompt = (
        'Review this user memory store. Propose at most 5 of each action.\n'
        'JSON shape:\n'
        '{"improve":[{"id":int,"rewritten":str,"why":str}],'
        '"remove":[{"id":int,"why":str}],'
        '"enhance":[{"content":str,"why":str}],'
        '"merge":[{"keepId":int,"removeIds":[int,...],"mergedText":str,"why":str}],'
        '"skills":[{"action":"create|patch|delete","name":str,"description":str,"body":str,"trigger":str,"why":str}]}\n'
        'improve = rewrite a noisy/duplicate memory (use its id). Give conversation '
        'summaries a semantic title line ("About: <topic>") when the first user '
        'message is meaningless (greetings, "test", "pong").\n'
        'merge = fold 2+ near-duplicate memories into one: keepId survives with '
        'mergedText as its new content; every removeIds row is deleted.\n'
        'remove = stale, wrong, or duplicate auto memories (not pinned user facts unless clearly wrong).\n'
        'enhance = one new standing preference that should be always-included.\n'
        'skills: action create= new reusable multi-step workflow, patch= improve existing skill, delete= obsolete. \n'
        'Worthiness: search existing skills first; only create when genuinely reusable (multi-step success, specific trigger). Prefer patch over create.\n'
        f'Memories ({len(memories)}):\n{json.dumps(memories, default=str)[:6000]}\n\n'
        f'Heuristics ({len(heuristics)}):\n{json.dumps(heuristics, default=str)[:2000]}\n'
        f'Skills ({len(skills)}):\n{json.dumps(skills, default=str)[:3000]}\n'
        f'Pending skills ({len(pending)}):\n{json.dumps(pending, default=str)[:1500]}\n'
    )
    raw = await _call_selected_model(model_id, prompt)
    plan = parse_review_plan(raw)
    known = {m['id'] for m in memories}
    plan['improve'] = [x for x in plan['improve'] if x['id'] in known]
    plan['remove'] = [x for x in plan['remove'] if x['id'] in known]
    try:
        from app.services import skill_service as _ss
        existing_names = {str(s.get('name') or '').lower() for s in _ss.catalogue()}
        filtered: list[dict[str, Any]] = []
        for s in plan.get('skills', []):
            nm = str(s.get('name') or '').lower()
            act = str(s.get('action') or 'create').lower()
            if nm in existing_names and act == 'create':
                s['action'] = 'patch'
            filtered.append(s)
        plan['skills'] = filtered[:5]
    except Exception:
        pass
    used = as_str(model_id) or 'default'
    has_any = bool(plan['improve'] or plan['remove'] or plan['enhance'] or plan.get('merge') or plan.get('skills'))
    return {'model': used, 'memoryCount': len(memories), **plan, 'message': '' if has_any else 'Looks healthy — no changes suggested.'}


def apply_review_actions(actions: list[dict[str, Any]]) -> dict[str, int]:
    from app.services.memory.auto_memory import delete_auto_memory, saveAutoMemory, update_auto_memory
    from app.services.memory.curation_ledger import record as _ledger

    applied = {'improved': 0, 'removed': 0, 'enhanced': 0, 'merged': 0}
    for raw in actions:
        row = as_dict(raw)
        kind = as_str(row.get('kind') or row.get('action'), '').lower()
        # Skill actions
        if kind in ('skill_create', 'skill_patch', 'skill_delete', 'create_skill', 'patch_skill', 'delete_skill', 'skill', 'create', 'patch', 'delete') and 'name' in row:
            action = as_str(row.get('action') or row.get('kind'), 'create').lower()
            if action not in ('create', 'patch', 'delete'):
                # 'kind' style
                if kind in ('skill_create', 'create_skill', 'create'):
                    action = 'create'
                elif kind in ('skill_patch', 'patch_skill', 'patch'):
                    action = 'patch'
                elif kind in ('skill_delete', 'delete_skill', 'delete'):
                    action = 'delete'
                else:
                    action = 'create'
            name = as_str(row.get('name'), '').strip()
            if not name:
                continue
            if action == 'create':
                try:
                    from app.services import skill_service as _ss2
                    if _ss2.get(name):
                        action = 'patch'
                except Exception:
                    pass
            if action == 'create':
                try:
                    from app.services.memory.background_review import _queue_pending_skill
                    _queue_pending_skill(name, as_str(row.get('description'), ''), as_str(row.get('body'), ''), as_str(row.get('trigger'), ''), session_id=None)
                    applied['enhanced'] += 1
                    _ledger('model_review', 'propose_skill', 'skill', name, reason=as_str(row.get('description'), '')[:200])
                except Exception:
                    pass
            elif action == 'patch':
                try:
                    from app.services import skill_service as _ss3
                    _ss3.patchSkill(name, body=as_str(row.get('body'), '') or None, description=as_str(row.get('description'), '') or None, trigger=as_str(row.get('trigger'), '') or None)
                    applied['improved'] += 1
                    _ledger('model_review', 'update_skill', 'skill', name)
                except Exception:
                    pass
            elif action == 'delete':
                try:
                    from app.services.skills.curator import shared_curator
                    try:
                        shared_curator().archive(name)
                        archived = True
                    except Exception:
                        archived = False
                        from app.services import skill_service as _ss4
                        _ss4.deleteSkill(name)
                    applied['removed'] += 1
                    _ledger(
                        'model_review',
                        'archive_skill' if archived else 'delete_skill',
                        'skill',
                        name,
                    )
                except Exception:
                    pass
            continue
        if kind == 'improve':
            mid = as_int(row.get('id'), 0)
            text = as_str(row.get('rewritten') or row.get('content'), '').strip()
            if mid and text and update_auto_memory(mid, content=text):
                applied['improved'] += 1
                _ledger('model_review', 'update_memory', 'auto_memory', f'memory:{mid}', reason=text[:200])
        elif kind == 'remove':
            mid = as_int(row.get('id'), 0)
            if mid and delete_auto_memory(mid):
                applied['removed'] += 1
                _ledger('model_review', 'delete_memory', 'auto_memory', f'memory:{mid}')
        elif kind == 'enhance':
            text = as_str(row.get('content'), '').strip()
            if not text:
                continue
            saveAutoMemory(key=f'user:{text[:48]}', content=text, category='preference', importance=0.88, source='user', pinned=True)
            applied['enhanced'] += 1
            _ledger('model_review', 'pin_memory', 'auto_memory', f'user:{text[:48]}', reason=text[:200])
        elif kind in ('merge', 'merge_memories'):
            keep_id = as_int(row.get('keepId') or row.get('id'), 0)
            merged_text = as_str(row.get('mergedText') or row.get('rewritten'), '').strip()
            remove_ids = [i for i in (as_int(x, 0) for x in as_list(row.get('removeIds'), [])) if i > 0]
            if not keep_id or not merged_text:
                continue
            if update_auto_memory(keep_id, content=merged_text):
                applied['merged'] += 1
                _ledger(
                    'model_review',
                    'merge',
                    'auto_memory',
                    f'memory:{keep_id}',
                    detail=f'removed={remove_ids}',
                    reason=merged_text[:200],
                )
                for rid in remove_ids:
                    if rid != keep_id:
                        delete_auto_memory(rid)
    # Self-improvement feed: surface applied curation in the chat thread via
    # the brain SSE stream (category 'self_improvement').
    if any(applied.values()):
        try:
            from app.services.brain_event_bus import emitBrainEvent

            parts = []
            if applied.get('improved'):
                parts.append(f"{applied['improved']} improved")
            if applied.get('merged'):
                parts.append(f"{applied['merged']} merged")
            if applied.get('removed'):
                parts.append(f"{applied['removed']} removed")
            if applied.get('enhanced'):
                parts.append(f"{applied['enhanced']} added")
            emitBrainEvent(
                category='self_improvement',
                layer='memory_review.applied',
                summary=f"Memory review applied: {', '.join(parts)}",
                meta={'type': 'memoryReviewApplied', **applied},
            )
        except Exception:
            pass
    return applied
