"""T15 — Versioned harness-state refinement with rollback.

Harness-tunable state lives here as **versioned entries of a few typed
kinds** (``prompt_note`` / ``memory`` / ``skill`` / ``subagent``), each either
**session-local** or **global**. A *refine pass* — one model call — emits
JSON ``create``/``update``/``delete`` edits over this state. The immutable
base system prompt is never touched: active entries are injected as an
*additional* ``<refinements>`` context block (see ``render_refinements_block``).

Invariants (plan §9.4 T15):
  * every edit records a rationale AND an expected outcome;
  * rollback by entry id undoes the newest version (append-only history —
    the undo is itself a version, so the journal never loses anything);
  * during a LOCAL refine, global entries are read-only context: they are
    shown to the model but cannot be updated or deleted;
  * auto-refine is gated by a cheap reviewer call with a discard-default,
    and the reviewer must be a DIFFERENT model than the producer
    (Part 10 standing rule: same-model judging is inert).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.json_narrowing import as_dict, as_int, as_list, as_str

logger = logging.getLogger(__name__)

ENTRY_KINDS = frozenset({'prompt_note', 'memory', 'skill', 'subagent'})
SCOPES = ('global', 'local')
EDIT_OPS = ('create', 'update', 'delete')

# Required content keys per kind. Content beyond these keys is allowed but
# must be JSON-serializable; values are capped to keep entries prompt-sized.
_CONTENT_REQUIRED: dict[str, tuple[str, ...]] = {
    'prompt_note': ('text',),
    'memory': ('text',),
    'skill': ('name', 'description'),
    'subagent': ('name', 'description'),
}
_CONTENT_VALUE_CAP = 8000
_MAX_ENTRY_VERSIONS = 100
_MAX_EDITS_PER_PASS = 20

# A refine producer/reviewer pair must be independent models.
RefineProducer = Callable[[list[dict[str, str]]], Awaitable[str]]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _store_dir() -> Path:
    from app.config import settings

    d = Path(str(settings.dataDir)) / 'refine_store'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _entries_dir() -> Path:
    d = _store_dir() / 'entries'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _append_ledger(row: dict[str, Any]) -> None:
    try:
        with (_store_dir() / 'ledger.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    except Exception:
        logger.debug('refine_store ledger append failed', exc_info=True)


def read_ledger(limit: int = 20) -> list[dict[str, Any]]:
    try:
        p = _store_dir() / 'ledger.jsonl'
        if not p.exists():
            return []
        lines = p.read_text(encoding='utf-8').strip().splitlines()
        out: list[dict[str, Any]] = []
        for line in lines[-limit:]:
            try:
                out.append(as_dict(json.loads(line)))
            except Exception:
                continue
        return out
    except Exception:
        return []


def _entry_path(entry_id: str) -> Path:
    safe = ''.join(c for c in (entry_id or '') if c.isalnum() or c in '_-')
    return _entries_dir() / f'{safe}.json'


def _write_entry(entry: dict[str, Any]) -> None:
    _entry_path(as_str(entry.get('id'))).write_text(
        json.dumps(entry, indent=2, ensure_ascii=False), encoding='utf-8'
    )


def _now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def new_entry_id(kind: str) -> str:
    return f'ref_{kind}_{uuid.uuid4().hex[:8]}'


# ---------------------------------------------------------------------------
# Content validation
# ---------------------------------------------------------------------------


def validate_content(kind: str, content: dict[str, Any]) -> tuple[bool, str]:
    """Per-kind content gate. Returns (ok, reason)."""
    if kind not in ENTRY_KINDS:
        return False, f'unknown kind {kind!r}; use one of {sorted(ENTRY_KINDS)}'
    if not isinstance(content, dict) or not content:
        return False, 'content must be a non-empty object'
    for key in _CONTENT_REQUIRED[kind]:
        if not as_str(content.get(key), '').strip():
            return False, f'{kind} content needs a non-empty {key!r}'
    for key, value in content.items():
        if isinstance(value, str) and len(value) > _CONTENT_VALUE_CAP:
            return False, f'content[{key!r}] exceeds {_CONTENT_VALUE_CAP} chars'
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            return False, f'content[{key!r}] is not JSON-serializable'
    return True, ''


# ---------------------------------------------------------------------------
# Entry CRUD (each mutation appends a version — history is append-only)
# ---------------------------------------------------------------------------


def _make_version(
    op: str,
    content: dict[str, Any] | None,
    rationale: str,
    expected_outcome: str,
    actor: str,
) -> dict[str, Any]:
    return {
        'version': 0,  # stamped by _append_version
        'op': op,
        'content': content,
        'rationale': (rationale or '').strip()[:2000],
        'expectedOutcome': (expected_outcome or '').strip()[:2000],
        'at': _now(),
        'actor': (actor or 'user').strip()[:200],
    }


def _append_version(entry: dict[str, Any], version: dict[str, Any]) -> None:
    versions = as_list(entry.get('versions'), [])
    version['version'] = len(versions) + 1
    versions.append(version)
    # Bound the history: drop the OLDEST versions but never the newest one.
    if len(versions) > _MAX_ENTRY_VERSIONS:
        del versions[: len(versions) - _MAX_ENTRY_VERSIONS]
    entry['versions'] = versions
    entry['updatedAt'] = version['at']
    _write_entry(entry)


def get_entry(entry_id: str) -> dict[str, Any] | None:
    path = _entry_path((entry_id or '').strip())
    if not path.exists():
        return None
    try:
        entry = json.loads(path.read_text(encoding='utf-8'))
        return entry if isinstance(entry, dict) and entry.get('id') else None
    except Exception:
        return None


def latest_version(entry: dict[str, Any]) -> dict[str, Any]:
    versions = as_list(entry.get('versions'), [])
    return as_dict(versions[-1]) if versions else {}


def is_active(entry: dict[str, Any]) -> bool:
    """An entry is active when its newest version is not a delete."""
    latest = latest_version(entry)
    return bool(latest) and latest.get('op') != 'delete'


def create_entry(
    *,
    kind: str,
    scope: str,
    content: dict[str, Any],
    rationale: str,
    expected_outcome: str,
    session_id: str = '',
    actor: str = 'user',
) -> dict[str, Any]:
    kind = (kind or '').strip().lower()
    scope = (scope or '').strip().lower()
    if scope not in SCOPES:
        raise ValueError(f'scope must be one of {SCOPES}')
    if scope == 'local' and not (session_id or '').strip():
        raise ValueError('local entries need a session id')
    ok, reason = validate_content(kind, content)
    if not ok:
        raise ValueError(reason)
    if not (rationale or '').strip() or not (expected_outcome or '').strip():
        raise ValueError('every edit needs a rationale and an expected outcome')
    entry: dict[str, Any] = {
        'id': new_entry_id(kind),
        'kind': kind,
        'scope': scope,
        'sessionId': (session_id or '').strip(),
        'createdAt': _now(),
        'updatedAt': _now(),
        'versions': [],
    }
    _append_version(entry, _make_version('create', content, rationale, expected_outcome, actor))
    _append_ledger({
        'at': entry['updatedAt'],
        'actor': actor,
        'action': 'create',
        'entryId': entry['id'],
        'kind': kind,
        'scope': scope,
    })
    return entry


def _mutate_existing(
    entry_id: str,
    op: str,
    content: dict[str, Any] | None,
    rationale: str,
    expected_outcome: str,
    actor: str,
) -> dict[str, Any]:
    entry = get_entry(entry_id)
    if entry is None:
        raise ValueError(f'entry {entry_id!r} not found')
    if not (rationale or '').strip() or not (expected_outcome or '').strip():
        raise ValueError('every edit needs a rationale and an expected outcome')
    if op == 'update':
        ok, reason = validate_content(as_str(entry.get('kind')), as_dict(content))
        if not ok:
            raise ValueError(reason)
    else:
        content = None
    _append_version(entry, _make_version(op, content, rationale, expected_outcome, actor))
    _append_ledger({
        'at': entry['updatedAt'],
        'actor': actor,
        'action': op,
        'entryId': entry['id'],
        'kind': entry.get('kind', ''),
    })
    return entry


def update_entry(
    entry_id: str,
    content: dict[str, Any],
    rationale: str,
    expected_outcome: str,
    actor: str = 'user',
) -> dict[str, Any]:
    return _mutate_existing(entry_id, 'update', content, rationale, expected_outcome, actor)


def delete_entry(
    entry_id: str, rationale: str, expected_outcome: str, actor: str = 'user'
) -> dict[str, Any]:
    return _mutate_existing(entry_id, 'delete', None, rationale, expected_outcome, actor)


def rollback_entry(entry_id: str, actor: str = 'user', rationale: str = '') -> dict[str, Any]:
    """Undo the newest version of an entry (rollback by entry id).

    Append-only: the undo is recorded as a new version, so nothing is ever
    lost. Rolling back a single-version create deactivates the entry;
    otherwise the previous version's content is restored (a delete is
    re-issued when the rolled-back version had revived a deleted entry).
    """
    entry = get_entry(entry_id)
    if entry is None:
        raise ValueError(f'entry {entry_id!r} not found')
    versions = as_list(entry.get('versions'), [])
    if not versions:
        raise ValueError(f'entry {entry_id!r} has no versions to roll back')
    why = (rationale or '').strip() or 'rollback of the newest version'
    if len(versions) == 1:
        # Undoing the creating version: the entry goes back to "not existing".
        _append_version(
            entry,
            _make_version('delete', None, why, 'entry returns to the not-existing state', actor),
        )
        return entry
    previous = as_dict(versions[-2])
    prev_content = previous.get('content')
    op = 'rollback' if isinstance(prev_content, dict) else 'delete'
    _append_version(
        entry,
        _make_version(
            op,
            as_dict(prev_content) if isinstance(prev_content, dict) else None,
            why,
            f"restore the state of version {as_int(previous.get('version'), 0)}",
            actor,
        ),
    )
    return entry


def list_entries(
    *,
    scope: str = '',
    session_id: str = '',
    kind: str = '',
    include_deleted: bool = False,
) -> list[dict[str, Any]]:
    """Summaries of matching entries, local-before-global, newest first."""
    out: list[dict[str, Any]] = []
    try:
        paths = sorted(_entries_dir().glob('ref_*.json'))
    except OSError:
        return []
    for path in paths:
        try:
            entry = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(entry, dict) or not entry.get('id'):
            continue
        if scope and entry.get('scope') != scope:
            continue
        if kind and entry.get('kind') != kind:
            continue
        if session_id and entry.get('scope') == 'local' and entry.get('sessionId') != session_id:
            continue
        if not include_deleted and not is_active(entry):
            continue
        latest = latest_version(entry)
        out.append({
            'id': entry.get('id'),
            'kind': entry.get('kind'),
            'scope': entry.get('scope'),
            'sessionId': entry.get('sessionId', ''),
            'version': latest.get('version', 0),
            'active': is_active(entry),
            'content': latest.get('content'),
            'rationale': latest.get('rationale', ''),
            'expectedOutcome': latest.get('expectedOutcome', ''),
            'updatedAt': entry.get('updatedAt', ''),
        })
    # Local (this session) first, then global; newest update first inside
    # each group (two stable sorts).
    out.sort(key=lambda e: as_str(e.get('updatedAt')), reverse=True)
    out.sort(key=lambda e: 0 if e.get('scope') == 'local' else 1)
    return out


# ---------------------------------------------------------------------------
# Prompt injection (additive context — never the base system prompt)
# ---------------------------------------------------------------------------


def render_refinements_block(session_id: str = '') -> str:
    """Active prompt_note/memory entries as an extra context block.

    Local entries first (they override global guidance on conflict), then
    global ones. Returns '' when nothing applies — callers append nothing.
    Without a session id only global entries apply.
    """
    entries = (
        list_entries(session_id=session_id) if session_id else list_entries(scope='global')
    )
    lines: list[str] = []
    for entry in entries:
        if entry.get('kind') not in ('prompt_note', 'memory'):
            continue
        content = as_dict(entry.get('content'))
        text = ' '.join(as_str(content.get('text'), '').split())
        if not text:
            continue
        tag = 'local' if entry.get('scope') == 'local' else 'global'
        lines.append(f'- [{tag}] {text}')
    if not lines:
        return ''
    return (
        '<refinements>\n'
        'Learned harness notes (versioned refine store; local entries take '
        'precedence over global ones):\n' + '\n'.join(lines) + '\n</refinements>'
    )


def render_state_for_refine(session_id: str = '') -> str:
    """The current state as shown to a refine pass.

    Local entries are editable; global entries are explicitly read-only
    context during a local refine. A global refine (no session) only sees
    global entries — other sessions' local state is none of its business.
    """
    entries = list_entries(
        session_id=session_id, include_deleted=False
    ) if session_id else list_entries(scope='global', include_deleted=False)
    if not entries:
        return '(the refine store is empty — create entries if the evidence justifies them)'
    lines: list[str] = []
    for entry in entries:
        scope = entry.get('scope')
        marker = 'editable' if scope == 'local' else 'READ-ONLY (global)'
        content = json.dumps(entry.get('content'), ensure_ascii=False)
        if len(content) > 600:
            content = content[:600] + '…'
        lines.append(
            f"- id={entry.get('id')} kind={entry.get('kind')} scope={scope} [{marker}] "
            f'v{entry.get("version")} content={content}'
        )
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Edits: validation + application (the refine pass output contract)
# ---------------------------------------------------------------------------


def validate_edit(
    edit: dict[str, Any], *, refine_scope: str, session_id: str
) -> tuple[bool, str]:
    """One edit against the store contract. Fail-closed on anything odd."""
    if not isinstance(edit, dict):
        return False, 'edit must be an object'
    op = as_str(edit.get('op'), '').strip().lower()
    if op not in EDIT_OPS:
        return False, f'op must be one of {EDIT_OPS}'
    if not as_str(edit.get('rationale'), '').strip():
        return False, 'rationale is required'
    if not as_str(edit.get('expectedOutcome') or edit.get('expected_outcome'), '').strip():
        return False, 'expectedOutcome is required'
    if op == 'create':
        kind = as_str(edit.get('kind'), '').strip().lower()
        if kind not in ENTRY_KINDS:
            return False, f'create needs a kind in {sorted(ENTRY_KINDS)}'
        scope = as_str(edit.get('scope'), '').strip().lower()
        if scope not in SCOPES:
            return False, f'create needs a scope in {SCOPES}'
        if scope == 'global' and refine_scope == 'local':
            return False, 'a local refine cannot create global entries'
        if scope == 'local' and not (session_id or '').strip():
            return False, 'local create needs a session id'
        return validate_content(kind, as_dict(edit.get('content')))
    # update / delete target an existing entry by id.
    entry_id = as_str(edit.get('id'), '').strip()
    if not entry_id:
        return False, f'{op} needs the target entry id'
    entry = get_entry(entry_id)
    if entry is None:
        return False, f'entry {entry_id!r} not found'
    if not is_active(entry):
        return False, f'entry {entry_id!r} is deleted — roll it back instead'
    if entry.get('scope') == 'global' and refine_scope == 'local':
        return False, (
            f'global entry {entry_id!r} is read-only context during a local refine'
        )
    if entry.get('scope') == 'local' and refine_scope == 'global':
        return False, (
            f'local entry {entry_id!r} belongs to one session — refine it in that session'
        )
    if op == 'update':
        return validate_content(as_str(entry.get('kind')), as_dict(edit.get('content')))
    return True, ''


def apply_edits(
    edits: list[dict[str, Any]],
    *,
    refine_id: str,
    refine_scope: str,
    session_id: str = '',
    actor: str = '',
) -> dict[str, Any]:
    """Apply a batch of validated edits. Per-edit fail-closed: a bad edit is
    rejected with a reason; good ones still apply."""
    applied: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    who = actor or f'refine:{refine_id}'
    for edit in as_list(edits, [])[:_MAX_EDITS_PER_PASS]:
        edit = as_dict(edit)
        ok, reason = validate_edit(edit, refine_scope=refine_scope, session_id=session_id)
        if not ok:
            rejected.append({'edit': edit, 'reason': reason})
            continue
        op = as_str(edit.get('op'), '').strip().lower()
        rationale = as_str(edit.get('rationale'))
        expected = as_str(edit.get('expectedOutcome') or edit.get('expected_outcome'))
        try:
            if op == 'create':
                scope = as_str(edit.get('scope'), '').strip().lower()
                entry = create_entry(
                    kind=as_str(edit.get('kind'), '').strip().lower(),
                    scope=scope,
                    content=as_dict(edit.get('content')),
                    rationale=rationale,
                    expected_outcome=expected,
                    session_id=session_id if scope == 'local' else '',
                    actor=who,
                )
            elif op == 'update':
                entry = update_entry(
                    as_str(edit.get('id')), as_dict(edit.get('content')), rationale, expected, who
                )
            else:
                entry = delete_entry(as_str(edit.get('id')), rationale, expected, who)
            applied.append({
                'op': op,
                'id': entry.get('id'),
                'kind': entry.get('kind'),
                'scope': entry.get('scope'),
                'version': latest_version(entry).get('version', 0),
                'rationale': rationale,
                'expectedOutcome': expected,
            })
        except ValueError as exc:
            rejected.append({'edit': edit, 'reason': str(exc)})
    return {'refineId': refine_id, 'applied': applied, 'rejected': rejected}


# ---------------------------------------------------------------------------
# The refine pass (one model call → JSON edits)
# ---------------------------------------------------------------------------


def parse_refine_response(text: str) -> list[dict[str, Any]]:
    """Extract the edits list from a model response.

    Tolerates code fences and prose around the JSON. Accepts either
    ``{"edits": [...]}`` or a bare ``[...]``. Anything unparseable yields an
    empty list (a refine pass that cannot be parsed applies nothing).
    """
    raw = (text or '').strip()
    if not raw:
        return []
    candidates: list[str] = [raw]
    # Strip common fences.
    if '```' in raw:
        for chunk in raw.split('```'):
            chunk = chunk.strip()
            if chunk.startswith(('json', 'JSON')):
                chunk = chunk[4:].strip()
            if chunk.startswith(('{', '[')):
                candidates.append(chunk)
    # First {...} or [...] span as a last resort.
    for opener, closer in (('{', '}'), ('[', ']')):
        start = raw.find(opener)
        end = raw.rfind(closer)
        if 0 <= start < end:
            candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            data = data.get('edits')
        if isinstance(data, list):
            return [as_dict(e) for e in data if isinstance(e, dict)]
    return []


def build_refine_messages(
    *, refine_scope: str, session_id: str, evidence: str
) -> list[dict[str, str]]:
    """The producer prompt: current state + evidence + the edit contract."""
    state = render_state_for_refine(session_id)
    scope_note = (
        'This is a LOCAL refine: you may only create local entries and edit '
        'local entries. Global entries are shown as READ-ONLY context — do '
        'not propose updates or deletes for them.'
        if refine_scope == 'local'
        else 'This is a GLOBAL refine: edits apply to global entries shared '
        'by all sessions.'
    )
    system = (
        'You refine the August harness state. You are given a versioned store '
        'of typed entries (prompt_note, memory, skill, subagent). Propose a '
        'small batch of JSON edits that durably improve future turns in light '
        'of the evidence. Rules: never touch the base system prompt — entries '
        'are ADDITIONAL context only; every edit needs a rationale and an '
        'expectedOutcome; prefer updating an existing entry over creating a '
        'near-duplicate; delete entries that proved wrong or transient; when '
        'the evidence does not justify any change, return {"edits": []}.'
    )
    user = (
        f'{scope_note}\n\n'
        f'Current refine-store state:\n{state}\n\n'
        f'Evidence from the harness:\n{(evidence or "").strip()[:6000]}\n\n'
        'Reply with ONLY a JSON object: {"edits": [{"op": "create"|"update"|'
        '"delete", "kind": <required for create>, "scope": "local"|"global" '
        '(create only), "id": <required for update/delete>, "content": '
        '{...}, "rationale": "...", "expectedOutcome": "..."}]}.'
    )
    return [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]


def new_refine_id() -> str:
    return f'refine_{time.strftime("%Y%m%d")}_{uuid.uuid4().hex[:8]}'


async def run_refine_pass(
    *,
    session_id: str = '',
    evidence: str = '',
    producer: RefineProducer | None = None,
) -> dict[str, Any]:
    """One refine pass: build the prompt, call the model once, apply edits.

    ``producer`` is injectable for tests; when absent it is resolved from the
    configured refine/producer model. A missing producer or an unparseable
    response applies nothing (fail-closed).
    """
    refine_id = new_refine_id()
    refine_scope = 'local' if (session_id or '').strip() else 'global'
    messages = build_refine_messages(
        refine_scope=refine_scope, session_id=session_id, evidence=evidence
    )
    llm = producer
    if llm is None:
        llm = _resolve_producer()
    if llm is None:
        return {
            'refineId': refine_id,
            'applied': [],
            'rejected': [],
            'error': 'no producer model available for the refine pass',
        }
    try:
        raw = await llm(messages)
    except Exception as exc:
        logger.debug('refine pass producer call failed', exc_info=True)
        return {
            'refineId': refine_id,
            'applied': [],
            'rejected': [],
            'error': f'producer call failed: {exc}',
        }
    edits = parse_refine_response(raw)
    result = apply_edits(
        edits, refine_id=refine_id, refine_scope=refine_scope, session_id=session_id
    )
    result['raw'] = (raw or '')[:4000]
    return result


def _resolve_producer() -> RefineProducer | None:
    """Producer client from config ('refineProducerModel'), else default."""
    try:
        from app.services.config_service import getConfig

        cfg = getConfig() or {}
        refine_cfg = as_dict(cfg.get('refineConfig'))
        hint = as_str(refine_cfg.get('producerModel'), '')
    except Exception:
        hint = ''
    try:
        from app.services.workbench.providers import make_review_llm_client

        client = make_review_llm_client(None, hint)
        return client
    except Exception:
        logger.debug('refine producer resolution failed', exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Auto-refine: gated by an independent cheap reviewer, discard-default
# ---------------------------------------------------------------------------


def get_refine_config() -> dict[str, Any]:
    """{autoRefine: bool, producerModel: str, reviewModel: str} — default off."""
    try:
        from app.services.config_service import getConfig

        raw = as_dict((getConfig() or {}).get('refineConfig'))
    except Exception:
        raw = {}
    return {
        'autoRefine': bool(raw.get('autoRefine', False)),
        'producerModel': as_str(raw.get('producerModel'), ''),
        'reviewModel': as_str(raw.get('reviewModel'), ''),
    }


def set_refine_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Validate + persist the refine config. Returns the normalized form."""
    raw = as_dict(raw)
    normalized = {
        'autoRefine': bool(raw.get('autoRefine', False)),
        'producerModel': as_str(raw.get('producerModel'), '').strip()[:200],
        'reviewModel': as_str(raw.get('reviewModel'), '').strip()[:200],
    }
    try:
        from app.services.config_service import getConfig, saveConfig

        cfg = getConfig() or {}
        cfg['refineConfig'] = normalized
        saveConfig(cfg)
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}
    return {'ok': True, 'refineConfig': normalized}


def _resolve_review_model(cfg: dict[str, Any]) -> str:
    """The reviewer model: explicit config, else the provider default."""
    hint = as_str(cfg.get('reviewModel'), '')
    if hint:
        return hint
    try:
        from app.providers import resolver as providerResolver
        from app.services.workbench.providers import resolve_model

        provider = providerResolver.resolve('')
        if provider:
            return as_str(resolve_model(provider), '')
    except Exception:
        pass
    return ''


async def _review_refine_batch(
    applied: list[dict[str, Any]],
    evidence: str,
    review_model: str,
    producer_model: str,
) -> tuple[bool, str]:
    """Independent cheap reviewer over the applied edits. Discard-default.

    Returns (keep, reason). Any failure — no reviewer, same model as the
    producer (Part 10 standing rule), unreachable, unparseable answer —
    discards the batch.
    """
    if not applied:
        return True, 'nothing applied'
    if producer_model and review_model and producer_model == review_model:
        return False, (
            f'reviewer model {review_model!r} is the same as the producer — '
            'same-model judging is inert (Part 10 rule); batch discarded'
        )
    try:
        from app.services.workbench.providers import make_review_llm_client

        reviewer = make_review_llm_client(None, review_model)
    except Exception:
        reviewer = None
    if reviewer is None:
        return False, 'no reviewer model available — discard-default'
    summary = '\n'.join(
        f"- {a.get('op')} {a.get('kind')} {a.get('id')}: "
        f"rationale={as_str(a.get('rationale'))[:200]!r} expected={as_str(a.get('expectedOutcome'))[:200]!r}"
        for a in applied
    )
    prompt = [
        {
            'role': 'system',
            'content': (
                'You gate harness self-refinements before they persist. A batch '
                'is kept only if every edit is: justified by the evidence, '
                'durable (not a one-off), non-redundant, and likely to improve '
                'future turns. Reply with exactly KEEP or DISCARD. When unsure, '
                'answer DISCARD.'
            ),
        },
        {
            'role': 'user',
            'content': (
                f'Evidence that triggered the refine:\n{(evidence or "").strip()[:2000]}\n\n'
                f'Applied edits:\n{summary}\n\nKeep this batch?'
            ),
        },
    ]
    try:
        answer = (await reviewer(prompt)).strip().upper()
    except Exception:
        logger.debug('refine reviewer call failed (discard-default)', exc_info=True)
        return False, 'reviewer call failed — discard-default'
    if answer.startswith('KEEP'):
        return True, 'reviewer kept the batch'
    return False, f'reviewer answered {answer[:40]!r} — discard-default'


async def auto_refine(
    *,
    session_id: str = '',
    evidence: str = '',
    producer: RefineProducer | None = None,
) -> dict[str, Any]:
    """Gated automatic refine: config gate → pass → independent review.

    A discarded batch is rolled back entry-by-entry (the rollback is itself a
    versioned edit, so the journal shows the whole story). Never raises into
    the caller — returns a status dict.
    """
    cfg = get_refine_config()
    if not cfg['autoRefine']:
        return {'status': 'disabled', 'reason': 'autoRefine is off in the refine config'}
    if not (evidence or '').strip():
        return {'status': 'skipped', 'reason': 'no evidence supplied'}
    result = await run_refine_pass(
        session_id=session_id, evidence=evidence, producer=producer
    )
    applied = [as_dict(a) for a in as_list(result.get('applied'), [])]
    if not applied:
        return {'status': 'no-edits', 'refineId': result.get('refineId'), 'result': result}
    producer_model = as_str(cfg.get('producerModel'), '')
    review_model = _resolve_review_model(cfg)
    keep, reason = await _review_refine_batch(applied, evidence, review_model, producer_model)
    if keep:
        _append_ledger({
            'at': _now(),
            'actor': 'auto-refine',
            'action': 'kept',
            'target_key': result.get('refineId', ''),
            'detail': reason,
        })
        return {'status': 'kept', 'refineId': result.get('refineId'), 'review': reason, 'result': result}
    # Discard: roll back every applied edit (newest-version undo per entry).
    rolled_back: list[str] = []
    for item in applied:
        entry_id = as_str(item.get('id'))
        if not entry_id:
            continue
        try:
            rollback_entry(
                entry_id,
                actor='auto-refine-discard',
                rationale=f'auto-refine batch discarded by reviewer: {reason[:300]}',
            )
            rolled_back.append(entry_id)
        except ValueError:
            continue
    _append_ledger({
        'at': _now(),
        'actor': 'auto-refine',
        'action': 'discarded',
        'target_key': result.get('refineId', ''),
        'detail': f'{reason}; rolled back {len(rolled_back)} entr(y/ies)',
    })
    return {
        'status': 'discarded',
        'refineId': result.get('refineId'),
        'review': reason,
        'rolledBack': rolled_back,
        'result': result,
    }
