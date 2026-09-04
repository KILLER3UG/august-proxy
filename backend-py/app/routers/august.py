"""
/api/august routes — alias management action endpoint + config audit log.

These endpoints match the shapes the existing frontend already calls
(``manageAugustAliases`` → ``POST /api/august/aliases/manage`` and the
audit viewer → ``GET /api/august/audit``), so the UI stops 404'ing against
the Python backend.

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase (``targetModel``, ``displayAlias``, etc.).
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel
from app.services import alias_service
from app.services.memory_store import list_config_audit
from app.type_aliases import JsonValue

router = APIRouter(prefix='/api/august')


class AliasManageItem(CamelModel):
    """Single alias entry. Internals are snake_case; JSON stays camelCase."""

    alias: str
    target_model: str = ''
    target_provider: str = ''
    display_alias: str = ''


class AliasManageRequest(CamelModel):
    """Alias manage body. Internals are snake_case; JSON stays camelCase."""

    action: str
    alias: str | None = None
    target_model: str | None = None
    target_provider: str | None = None
    display_alias: str | None = None
    items: list[AliasManageItem] | None = None


@router.post('/aliases/manage')
async def manageAliases(body: AliasManageRequest):
    """Unified alias action endpoint used by the frontend's AliasesTab."""
    action = (body.action or '').lower()
    if action == 'list':
        return {'aliases': alias_service.listAliasesWire()}
    if action == 'upsert':
        alias = (body.alias or '').strip()
        if not alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        try:
            entry = alias_service.createAlias(
                alias=alias,
                target_model=body.target_model or '',
                target_provider=body.target_provider or '',
                display_alias=body.display_alias or '',
                actor='ui',
            )
        except ValueError as exc:
            raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})
        return {'alias': alias_service.alias_to_wire(entry)}
    if action == 'delete':
        if not body.alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        removed = alias_service.delete_alias(body.alias, actor='ui')
        return {'deleted': removed, 'alias': body.alias}
    raise HTTPException(400, detail={'code': 'bad_request', 'message': f"Unknown action '{action}'"})


@router.get('/audit')
async def auditLog(category: str = '', limit: int = 200) -> dict[str, object]:
    """Return config-change audit entries shaped for the frontend AuditEntry view."""
    limit = max(1, min(limit, 1000))
    rows = list_config_audit(category=category, limit=limit)
    entries = []
    for r in rows:
        entries.append(
            {
                'id': r.get('id'),
                'category': r.get('category'),
                'action': r.get('action'),
                'actor': r.get('actor', ''),
                'before': r.get('before'),
                'after': r.get('after'),
                'createdAt': r.get('createdAt'),
            }
        )
    return {'entries': entries, 'count': len(entries)}


@router.get('/rollback')
async def rollbackList() -> dict[str, object]:
    from app.services.rollback_store import list_entries

    entries = list_entries()
    return {'entries': entries, 'count': len(entries)}


# ── Manage action endpoints used by the desktop API client ─────────────


class SettingsUpdateBody(CamelModel):
    key_path: str = ''
    value: object = None


class ModelSelectBody(CamelModel):
    model: str = ''
    provider: str = ''


class ActionBody(CamelModel):
    action: str = ''
    store: str | None = None
    id: str | None = None
    title: str | None = None
    updates: dict[str, object] | None = None
    provider: dict[str, object] | None = None
    agent: dict[str, object] | None = None
    key: str | None = None
    value: object = None
    category: str | None = None
    ttl_days: int | None = None
    kind: str | None = None
    name: str | None = None
    config: dict[str, object] | None = None
    app: str | None = None
    policy: str | None = None
    source: str | None = None
    # Part 17 Phase A: project-memory write door for the Memory UI. scope
    # 'project' + workspace routes set/delete to <ws>/.aug/memory md entries;
    # key doubles as the entry title there.
    scope: str | None = None
    workspace: str | None = None
    details: str | None = None


@router.post('/settings/update')
async def update_settings(body: SettingsUpdateBody):
    from app.services.config_service import getConfig, saveConfig
    from app.services.rollback_store import capture_setting_before, record_rollback

    if not body.key_path:
        raise HTTPException(400, detail='keyPath is required')
    before = capture_setting_before(body.key_path)
    cfg = getConfig()
    keys = body.key_path.split('.')
    cur: dict = cfg
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = body.value
    saveConfig(cfg)
    try:
        record_rollback(
            type='restore_setting',
            target=body.key_path,
            before=before,
            after=body.value,
        )
    except Exception:
        pass
    return {'ok': True, 'keyPath': body.key_path, 'value': body.value}


@router.post('/models/select')
async def select_model(body: ModelSelectBody):
    from app.services.config_service import getConfig, saveConfig
    from app.services.rollback_store import record_rollback

    cfg = getConfig()
    before = {
        'activeModel': cfg.get('activeModel'),
        'activeProvider': cfg.get('activeProvider'),
    }
    cfg['activeModel'] = body.model
    if body.provider:
        cfg['activeProvider'] = body.provider
    saveConfig(cfg)
    try:
        record_rollback(
            type='restore_model_selection',
            target='activeModel',
            before=before,
            after={'activeModel': body.model, 'activeProvider': body.provider or before.get('activeProvider')},
        )
    except Exception:
        pass
    return {'ok': True, 'model': body.model, 'provider': body.provider}


@router.post('/sessions/manage')
async def manage_sessions(body: ActionBody):
    from app.services.workbench import workbench as wb

    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'sessions': wb.listWorkbenchSessions()}
    if action == 'create':
        s = wb.createWorkbenchSession()
        return {'ok': True, 'session': s.toDict()}
    if action == 'delete' and body.id:
        ok = wb.deleteWorkbenchSession(body.id)
        return {'ok': ok, 'id': body.id}
    if action == 'rename' and body.id and body.title:
        from app.services.workbench.sessions import rename_workbench_session

        renamed = rename_workbench_session(str(body.id), str(body.title))
        if not renamed:
            raise HTTPException(404, detail='Session not found')
        return {'ok': True, 'session': renamed.toDict()}
    # Archive/restore/update are NOT implemented — 'archive' previously
    # silently DELETED the session (data loss). Fail loudly instead.
    if action in ('archive', 'restore', 'update'):
        raise HTTPException(400, detail=f'action "{action}" is not implemented')
    return {'ok': True, 'sessions': wb.listWorkbenchSessions()}


@router.post('/providers/manage')
async def manage_providers(body: ActionBody):
    import copy

    from app.json_narrowing import as_list
    from app.services.config_service import getProvidersStore, saveProvidersStore
    from app.services.rollback_store import record_rollback

    store = getProvidersStore()
    providers = list(as_list(store.get('providers')))
    action = (body.action or '').lower()
    if action == 'upsert' and body.provider:
        pid = str(body.provider.get('id') or body.provider.get('name') or '')
        before = None
        replaced = False
        for i, p in enumerate(providers):
            if isinstance(p, dict) and str(p.get('id') or p.get('name')) == pid:
                before = copy.deepcopy(p)
                providers[i] = {**p, **body.provider}
                replaced = True
                break
        if not replaced:
            providers.append(body.provider)
        store['providers'] = providers
        saveProvidersStore(store)
        try:
            record_rollback(
                type='restore_provider',
                target=pid or str(body.provider.get('name') or ''),
                before=before,
                after=copy.deepcopy(body.provider),
            )
        except Exception:
            pass
        return {'ok': True, 'provider': body.provider}
    if action == 'delete' and body.id:
        before = None
        kept = []
        for p in providers:
            if isinstance(p, dict) and str(p.get('id') or p.get('name')) == body.id:
                before = copy.deepcopy(p)
            else:
                kept.append(p)
        store['providers'] = kept
        saveProvidersStore(store)
        try:
            if before is not None:
                record_rollback(
                    type='restore_provider',
                    target=body.id,
                    before=before,
                    after=None,
                )
        except Exception:
            pass
        return {'ok': True, 'deleted': True, 'id': body.id}
    return {'ok': True, 'providers': providers}


@router.post('/agents/manage')
async def manage_agents(body: ActionBody):
    import copy

    from app.json_narrowing import as_dict, as_list
    from app.services.config_service import getConfig, saveConfig
    from app.services.rollback_store import record_rollback
    from app.services.tools import agent_registry

    action = (body.action or '').lower()
    cfg = getConfig()
    custom = [as_dict(a) for a in as_list(cfg.get('customAgents'))]
    if action == 'upsert' and body.agent:
        aid = str(body.agent.get('id') or body.agent.get('name') or '')
        before = None
        replaced = False
        for i, a in enumerate(custom):
            if str(a.get('id') or a.get('name')) == aid:
                before = copy.deepcopy(a)
                custom[i] = {**a, **body.agent}
                replaced = True
                break
        if not replaced:
            custom.append(dict(body.agent))
        cfg['customAgents'] = custom
        saveConfig(cfg)
        try:
            record_rollback(
                type='restore_agent_config',
                target=aid,
                before=before,
                after=copy.deepcopy(body.agent),
            )
        except Exception:
            pass
        return {'ok': True, 'agent': body.agent}
    if action == 'delete' and body.id:
        before = None
        for a in custom:
            if str(a.get('id') or a.get('name')) == body.id:
                before = copy.deepcopy(a)
                break
        try:
            agent_registry.deleteAgent(body.id)
        except Exception:
            pass
        cfg['customAgents'] = [
            a for a in custom if str(a.get('id') or a.get('name')) != body.id
        ]
        saveConfig(cfg)
        try:
            if before is not None:
                record_rollback(
                    type='restore_agent_config',
                    target=body.id,
                    before=before,
                    after=None,
                )
        except Exception:
            pass
        return {'ok': True, 'deleted': True, 'id': body.id}
    agents = list(agent_registry.listAgents()) + custom
    return {'ok': True, 'agents': agents}


@router.get('/memory/workspaces')
async def list_memory_workspaces():
    """Known project workspaces for the Memory/Skills scope selector (C-1/C-9).

    Part 17 Phase E enumeration rule: never invent paths — a workspace is
    "known" when a workbench session was ever bound to it (distinct
    non-empty, non-home ``workspacePath`` across all sessions). Entries get
    ``hasMemory``/``hasSkills`` flags (does ``.aug/memory`` / ``.aug/skills``
    exist) so the UI can badge project roots that actually hold content.
    """
    from pathlib import Path

    from app.services.workbench.sessions import list_workbench_sessions

    home = Path.home().resolve()
    seen: dict[str, dict[str, object]] = {}
    try:
        sessions = list_workbench_sessions()
    except Exception:
        sessions = []
    for s in sessions:
        ws = str(s.get('workspacePath') or '').strip()
        if not ws or ws in seen:
            continue
        try:
            p = Path(ws).resolve()
        except Exception:
            continue
        if p == home or not p.is_dir():
            continue
        seen[ws] = {
            'path': ws,
            'name': p.name,
            'hasMemory': (p / '.aug' / 'memory').is_dir(),
            'hasSkills': (p / '.aug' / 'skills').is_dir(),
            'sessions': 0,
        }
    for s in sessions:
        ws = str(s.get('workspacePath') or '').strip()
        if ws in seen:
            seen[ws]['sessions'] = int(seen[ws]['sessions']) + 1  # type: ignore[assignment]
    return {'ok': True, 'workspaces': sorted(seen.values(), key=lambda w: str(w.get('name', '')))}


@router.post('/memory/manage')
async def manage_memory(body: ActionBody):
    import copy

    from app.services import memory_store
    from app.services.rollback_store import record_rollback

    action = (body.action or '').lower()
    key = body.key or ''
    # Part 17 Phase A: project scope — the UI's add/edit/delete writes
    # through the same md-file door as remember(scope='project'). key IS
    # the entry title; details rides below the one-line fact.
    if (body.scope or '').strip().lower() == 'project':
        from app.services import project_memory as pm

        ws = (body.workspace or '').strip()
        if not ws:
            return {'ok': False, 'error': 'scope=project requires a workspace path'}
        if action in ('set', 'upsert') and key:
            value_text = body.value if isinstance(body.value, str) else ''
            if not value_text.strip():
                return {'ok': False, 'error': 'value is required for project entries'}
            existing = pm.read_entries(ws, title=key)
            beforeProject = (
                {
                    'workspace': ws,
                    'file': existing[0].file,
                    'title': existing[0].title,
                    'body': existing[0].body,
                    'updated': existing[0].updated,
                }
                if existing
                else None
            )
            body_text = f'{value_text}\n\n{body.details}' if (body.details or '').strip() else value_text
            pm.upsert_entry(ws, key, body_text)
            try:
                record_rollback(
                    type='restore_memory_item',
                    target=f'project:{key}',
                    before=beforeProject,
                    after={'workspace': ws, 'title': key, 'body': body_text},
                )
            except Exception:
                pass
            return {'ok': True, 'scope': 'project', 'key': key, 'file': 'memory.md'}
        if action in ('delete', 'forget') and key:
            existing = pm.read_entries(ws, title=key)
            if not existing:
                return {'ok': False, 'error': f'no project-memory entry titled "{key}"'}
            entry = existing[0]
            pm.delete_entry(ws, key)
            try:
                record_rollback(
                    type='restore_memory_item',
                    target=f'project:{entry.title}',
                    before={
                        'workspace': ws,
                        'file': entry.file,
                        'title': entry.title,
                        'body': entry.body,
                        'updated': entry.updated,
                    },
                    after=None,
                )
            except Exception:
                pass
            return {'ok': True, 'scope': 'project', 'deleted': True, 'key': key}
        if action == 'list':
            files = pm.list_files(ws)
            entries = [
                {
                    'key': f'project:{e.title}',
                    'title': e.title,
                    'body': e.body,
                    'updated': e.updated,
                    'file': e.file,
                    'category': 'project',
                    'source': 'project-file',
                }
                for e in pm.read_entries(ws)
            ]
            return {'ok': True, 'scope': 'project', 'files': files, 'entries': entries}
        return {'ok': False, 'error': f'unsupported action "{action}" for project scope'}
    # Provenance for the facts store: the Memory UI add-box sends source='user';
    # default to 'user' since this endpoint is the human-facing write door.
    source = (body.source or 'user').strip() or 'user'
    # Part 26 7.3: the Memories tab lists the KV `memory` store, but its
    # add-box posted to the facts door — entries "saved" from that tab landed
    # in Facts & Rules and never appeared. Route by the requested store.
    if (body.store or '').strip() == 'memory' and key:
        if action in ('set', 'upsert'):
            from app.services.memory_store.kv import save_internal

            save_internal(key, cast(JsonValue, body.value))
            return {'ok': True, 'store': 'memory', 'key': key}
        if action in ('delete', 'forget'):
            conn_kv = memory_store._conn()  # noqa: SLF001
            cur = conn_kv.execute('DELETE FROM memory_store WHERE key = ?', (key,))
            conn_kv.commit()
            return {'ok': cur.rowcount > 0, 'store': 'memory', 'key': key}
    if action in ('set', 'upsert') and key:
        before_fact = memory_store.get_fact(key)
        before = copy.deepcopy(before_fact) if before_fact else None
        value_text = body.value if isinstance(body.value, str) else ''
        fact_title = (body.title or '').strip() or memory_store.derive_fact_title(value_text)
        # M-10 (Part 21): the UI's ttl_days was accepted but silently ignored —
        # a TTL selection now reaches the facts store as expires_at.
        expires_param: str | None = None
        ttl = body.ttl_days
        if isinstance(ttl, int) and not isinstance(ttl, bool) and ttl > 0:
            from datetime import datetime, timedelta, timezone

            expires_param = (datetime.now(timezone.utc) + timedelta(days=ttl)).isoformat(
                timespec='seconds'
            )
        try:
            memory_store.save_fact(
                key, cast(JsonValue, body.value), category=body.category or 'general',
                source=source, title=fact_title, kind=(body.kind or '').strip().lower(),
                expires_at=expires_param,
            )
        except ValueError as exc:
            # Part 26 6.5: the row belongs to a non-global scope this write
            # does not carry — refuse loudly instead of silently rewriting
            # another scope's private value under its original scope.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        try:
            record_rollback(
                type='restore_memory_item',
                target=key,
                before=before,
                after={'key': key, 'value': body.value, 'category': body.category or 'general', 'source': source},
            )
        except Exception:
            pass
        return {'ok': True, 'key': key, 'value': body.value}
    if action in ('delete', 'forget') and key:
        before_fact = memory_store.get_fact(key)
        before = copy.deepcopy(before_fact) if before_fact else None
        memory_store.delete_fact(key)
        try:
            if before is not None:
                record_rollback(
                    type='restore_memory_item',
                    target=key,
                    before=before,
                    after=None,
                )
        except Exception:
            pass
        return {'ok': True, 'key': key}
    return {'ok': False}


class MemoryImportBody(CamelModel):
    """Bulk import payload — used by the Memory UI's "Import from another AI"
    button. Each item is persisted through the same write door as the
    single-entry ``/memory/manage`` endpoint, with a per-item ``source``
    string (e.g. ``"imported:claude"``) preserved as provenance.
    """

    items: list[object] = []
    defaultCategory: str | None = None
    defaultSource: str | None = None
    # Part 17 Phase A: project imports land as `## <title>` entries in the
    # workspace's memory.md instead of the global facts store.
    scope: str | None = None
    workspace: str | None = None


@router.post('/memory/import')
async def import_memory(body: MemoryImportBody):
    """Bulk-import facts (from a parsed export of another AI's memory).

    Each item is recorded through ``save_fact`` with a per-item source so
    the Memory UI can highlight imported rows. Items that already exist
    are overwritten (matching the single-entry manage_memory behavior);
    the rollback store captures a snapshot before each overwrite.

    Part 17 Phase A: ``scope='project'`` + ``workspace`` writes each item
    as a project-memory md entry (title = item title/first line) instead
    of a facts row — the same store remember(scope='project') uses.
    """
    import copy as _copy

    from app.services import memory_store
    from app.services.rollback_store import record_rollback

    raw_items = body.items or []
    default_category = (body.defaultCategory or 'general').strip() or 'general'
    default_source = (body.defaultSource or 'imported').strip() or 'imported'
    accepted = {'user', 'feedback', 'project', 'reference', 'general'}

    # Project-scope branch: one md entry per item, via the same writer as
    # remember(scope='project').
    if (body.scope or '').strip().lower() == 'project':
        from app.services import project_memory as pm

        ws = (body.workspace or '').strip()
        if not ws:
            return {'ok': False, 'error': 'scope=project requires a workspace path'}
        projResults: list[dict[str, object]] = []
        projFailed: list[dict[str, object]] = []
        projWritten = 0
        for index, item in enumerate(raw_items):
            if not isinstance(item, dict):
                projFailed.append({'index': index, 'error': 'item is not an object'})
                continue
            value_raw = item.get('value') or ''
            details_raw = item.get('details')
            if (not isinstance(value_raw, str) or not value_raw.strip()) and isinstance(
                item.get('fact'), str
            ) and item.get('fact', '').strip():
                # Claude's {fact, details} convenience shape → fact + blank
                # line + details (the project entry body format).
                fact = str(item.get('fact')).strip()
                det = details_raw if isinstance(details_raw, str) else ''
                value_raw = f'{fact}\n\n{det.strip()}' if det.strip() else fact
            if not isinstance(value_raw, str) or not value_raw.strip():
                projFailed.append({'index': index, 'error': 'missing "value"'})
                continue
            title_raw = item.get('title') or item.get('key')
            if isinstance(title_raw, str) and title_raw.strip():
                entry_title = title_raw.strip()
            else:
                entry_title = value_raw.split('\n', 1)[0][:80]
            try:
                pm.upsert_entry(ws, entry_title, value_raw.strip())
            except Exception as exc:  # noqa: BLE001 — surface to the caller
                projFailed.append({'index': index, 'error': f'upsert_entry failed: {exc}'})
                continue
            projResults.append({'index': index, 'key': f'project:{entry_title}', 'scope': 'project'})
            projWritten += 1
        return {
            'ok': True, 'count': projWritten, 'total': len(raw_items),
            'results': projResults, 'failed': projFailed, 'scope': 'project', 'file': 'memory.md',
        }

    results: list[dict[str, object]] = []
    failed: list[dict[str, object]] = []
    written = 0

    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            failed.append({'index': index, 'error': 'item is not an object'})
            continue
        key_raw = item.get('key') or item.get('factKey') or ''
        if not isinstance(key_raw, str) or not key_raw.strip():
            failed.append({'index': index, 'error': 'missing or empty "key"'})
            continue
        key = key_raw.strip()
        valueIn: object = item.get('value')
        if valueIn is None:
            # Convenience: accept Claude's `{fact, details}` shape.
            factIn = item.get('fact')
            detailsIn = item.get('details')
            if isinstance(factIn, str) and factIn.strip():
                valueIn = {'fact': factIn.strip(), 'details': detailsIn if detailsIn is not None else ''}
            else:
                failed.append({'index': index, 'error': 'missing "value"'})
                continue
        cat_raw = item.get('category') or default_category
        category = str(cat_raw).strip().lower() or default_category
        if category not in accepted:
            category = default_category if default_category in accepted else 'general'
        src_raw = item.get('source') or default_source
        source = str(src_raw).strip() or default_source
        confidence_raw = item.get('confidence')
        try:
            confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float, str)) else 0.7
        except (TypeError, ValueError):
            confidence = 0.7
        confidence = max(0.0, min(1.0, confidence))

        before_fact = memory_store.get_fact(key)
        before = _copy.deepcopy(before_fact) if before_fact else None
        title_raw = item.get('title')
        if isinstance(title_raw, str) and title_raw.strip():
            fact_title = title_raw.strip()
        elif isinstance(valueIn, str):
            fact_title = memory_store.derive_fact_title(valueIn)
        elif isinstance(valueIn, dict) and isinstance(valueIn.get('fact'), str):
            fact_title = memory_store.derive_fact_title(str(valueIn.get('fact')))
        else:
            fact_title = ''
        kind_raw = item.get('kind')
        fact_kind = str(kind_raw).strip().lower() if isinstance(kind_raw, str) else ''
        try:
            memory_store.save_fact(
                key, cast(JsonValue, valueIn), category=category, source=source,
                confidence=confidence, title=fact_title, kind=fact_kind,
            )
        except Exception as exc:  # noqa: BLE001 — surface to the caller
            failed.append({'index': index, 'error': f'save_fact failed: {exc}'})
            continue
        try:
            record_rollback(
                type='restore_memory_item',
                target=key,
                before=before,
                after={'key': key, 'value': valueIn, 'category': category, 'source': source},
            )
        except Exception:
            pass
        results.append({'index': index, 'key': key, 'category': category, 'source': source})
        written += 1

    return {'ok': True, 'count': written, 'total': len(raw_items), 'results': results, 'failed': failed}


class ProposalDecideBody(CamelModel):
    decision: str = ''  # approve | reject


@router.get('/memory/proposals')
async def list_memory_proposals(status: str = 'pending'):
    """Pending memory proposals (OQ5 preference-retire, and any future
    propose-only consolidation pass). Returns the raw proposal rows with the
    JSON ``content`` parsed for the UI."""
    import json as _json

    from app.services import memory_store

    rows = memory_store.list_proposals('consolidation', status=status)
    out: list[dict[str, object]] = []
    for r in rows:
        content: object = r.get('content')
        if isinstance(content, str):
            try:
                content = _json.loads(content)
            except (ValueError, TypeError):
                content = {}
        out.append({**r, 'content': content})
    return {'ok': True, 'proposals': out}


@router.post('/memory/proposals/{proposal_id}/decide')
async def decide_memory_proposal(proposal_id: int, body: ProposalDecideBody):
    """Approve/reject a memory proposal. For a retire-preference proposal,
    approving flips the fact's status to 'retired' (reversible — the row
    survives); rejecting keeps it. See consolidation.apply_retire_decision."""
    from app.services.memory_store import consolidation

    decision = (body.decision or '').strip().lower()
    if decision not in ('approve', 'reject'):
        return {'ok': False, 'error': "decision must be 'approve' or 'reject'"}
    return consolidation.apply_retire_decision(proposal_id, approve=decision == 'approve')


@router.post('/tools/manage')
async def manage_tools(body: ActionBody):
    from app.json_narrowing import as_dict, as_list, as_str
    from app.services.tools import mcp_client

    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'tools': mcp_client.listRegisteredServers()}
    if action == 'upsert' and body.name:
        cfg = body.config or {}
        source = str(cfg.get('source') or '')
        args: list[str] | None = None
        if source:
            # GitHub plugin source: git clone when git exists, else the HTTP
            # tarball — installs without a git binary (audit feature).
            from app.services import plugin_installer

            installed = await plugin_installer.install_from_github(body.name, source)
            if not installed.get('ok'):
                return {'ok': False, 'error': as_str(installed.get('error'), 'Plugin install failed.')}
            command = as_str(installed.get('command'), 'node')
            args = [as_str(a, '') for a in as_list(installed.get('args'), []) if as_str(a, '')]
        else:
            command = str(cfg.get('command') or 'true')
            args = [str(a) for a in as_list(cfg.get('args'), [])] if isinstance(cfg.get('args'), list) else None
        server = mcp_client.registerServer(
            body.name,
            command,
            args=args,
            env={str(k): str(v) for k, v in as_dict(cfg.get('env'), {}).items()} if isinstance(cfg.get('env'), dict) else None,
        )
        return {'ok': True, 'tool': server}
    if action == 'delete' and body.name:
        # match by name
        for s in mcp_client.listRegisteredServers():
            if s.get('name') == body.name or s.get('id') == body.name:
                mcp_client.unregisterServer(str(s.get('id')))
                return {'ok': True, 'deleted': True, 'name': body.name}
        return {'ok': False, 'name': body.name}
    return {'ok': True}


@router.post('/computer/app-policy')
async def computer_app_policy(body: ActionBody):
    from app.json_narrowing import as_dict
    from app.services.config_service import getConfig, saveConfig

    cfg = getConfig()
    policies = as_dict(cfg.get('appPolicies')) if cfg.get('appPolicies') is not None else {}
    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'policies': policies}
    if action == 'set' and body.app and body.policy:
        policies[body.app] = body.policy
        cfg['appPolicies'] = policies
        saveConfig(cfg)
        return {'ok': True, 'app': body.app, 'policy': body.policy}
    if action == 'delete' and body.app:
        policies.pop(body.app, None)
        cfg['appPolicies'] = policies
        saveConfig(cfg)
        return {'ok': True, 'app': body.app}
    return {'ok': True, 'policies': policies}


@router.post('/ui-action')
async def ui_action(body: dict[str, object]):
    """Accept UI action events (frontend also dispatches locally)."""
    return {'ok': True, 'received': body}


@router.get('/ui-events')
async def ui_events(since: str = ''):
    """No server-side UI event bus yet — empty stream for pollers."""
    return {'ok': True, 'events': [], 'since': since}


@router.post('/rollback/{entry_id}/undo')
async def undo_rollback(entry_id: str):
    from app.services.rollback_store import undo_entry

    return undo_entry(entry_id)
