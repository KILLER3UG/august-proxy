"""Named workstreams with ordered episodes (Nac thread-and-episode).

A workstream is a persistent named work item. Each worker run appends one
episode (structured handoff) and discards its execution transcript. Later
workers on the same stream receive prior episodes, not tool traces.

Also validates spawn batches as DAGs (dependsOn / same-batch source streams).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.json_narrowing import as_list, as_str

logger = logging.getLogger(__name__)

DEFAULT_EPISODE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'summary': {'type': 'string', 'description': 'Concise handoff of what was done.'},
        'status': {
            'type': 'string',
            'enum': ['completed', 'blocked', 'partial'],
            'description': 'Outcome of this work item.',
        },
        'artifacts': {
            'type': 'array',
            'items': {'type': 'string'},
            'description': 'Useful file paths or identifiers produced.',
        },
        'next': {'type': 'string', 'description': 'Suggested next action, or empty if done.'},
        'criteriaMet': {
            'type': 'boolean',
            'description': 'True only if acceptance criteria were verified this episode.',
        },
        'unmet': {'type': 'string', 'description': 'Which acceptance item is still open.'},
    },
    'required': ['summary', 'status'],
}

_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')


class WorkstreamError(ValueError):
    """Invalid workstream name or cyclic dispatch batch."""


def normalize_name(name: str) -> str:
    raw = (name or '').strip()
    if not raw or not _NAME_RE.match(raw):
        raise WorkstreamError(
            f'Invalid workstream name {name!r}. Use 1-80 chars: letter/digit then [A-Za-z0-9._-].'
        )
    return raw


def item_name(item: dict[str, Any], index: int) -> str:
    raw = as_str(item.get('name') or item.get('workstream'), '')
    if raw:
        return normalize_name(raw)
    return f'item_{index + 1}'


def plan_waves(work_items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Partition work items into DAG waves.

    ``dependsOn`` and ``sourceWorkstreams`` that refer to names in this batch
    become edges. Duplicate names and cycles raise ``WorkstreamError``.
    """
    if not work_items:
        raise WorkstreamError('workItems must be non-empty')
    names: list[str] = []
    seen: set[str] = set()
    for i, item in enumerate(work_items):
        n = item_name(item, i)
        if n in seen:
            raise WorkstreamError(f'Duplicate target workstream/name {n!r} in this batch')
        seen.add(n)
        names.append(n)

    batch_set = set(names)
    edges: dict[str, set[str]] = {n: set() for n in names}
    for i, item in enumerate(work_items):
        target = names[i]
        deps = [as_str(d, '') for d in as_list(item.get('dependsOn'), [])]
        sources = [as_str(s, '') for s in as_list(item.get('sourceWorkstreams'), [])]
        for dep in deps + sources:
            if not dep:
                continue
            try:
                dep_n = normalize_name(dep)
            except WorkstreamError:
                continue
            if dep_n == target:
                raise WorkstreamError(f'{target!r} cannot depend on itself')
            if dep_n in batch_set:
                edges[target].add(dep_n)

    remaining = set(names)
    waves: list[list[dict[str, Any]]] = []
    name_to_item = {names[i]: work_items[i] for i in range(len(work_items))}
    while remaining:
        ready = [n for n in remaining if not (edges[n] & remaining)]
        if not ready:
            raise WorkstreamError(
                'Cyclic workstream dependencies in this batch: ' + ', '.join(sorted(remaining))
            )
        ready.sort()
        waves.append([name_to_item[n] for n in ready])
        remaining -= set(ready)
    return waves


def _conn():
    from app.services.memory_store import _conn as mem_conn

    return mem_conn()


def ensure_workstream(session_id: str, name: str) -> int:
    name = normalize_name(name)
    conn = _conn()
    row = conn.execute(
        'SELECT id FROM workstreams WHERE session_id = ? AND name = ?',
        (session_id, name),
    ).fetchone()
    if row:
        return int(row['id'])
    cur = conn.execute(
        'INSERT INTO workstreams (session_id, name) VALUES (?, ?)',
        (session_id, name),
    )
    conn.commit()
    return int(cur.lastrowid)


def append_episode(
    session_id: str,
    name: str,
    *,
    task_id: str = '',
    status: str = 'completed',
    summary: str = '',
    artifacts: list[str] | None = None,
    next_action: str = '',
    raw_json: str = '',
) -> dict[str, Any]:
    ws_id = ensure_workstream(session_id, name)
    conn = _conn()
    seq_row = conn.execute(
        'SELECT COALESCE(MAX(seq), 0) AS m FROM workstream_episodes WHERE workstream_id = ?',
        (ws_id,),
    ).fetchone()
    seq = int(seq_row['m'] if seq_row else 0) + 1
    arts = json.dumps(artifacts or [], ensure_ascii=False)
    conn.execute(
        'INSERT INTO workstream_episodes '
        '(workstream_id, seq, task_id, status, summary, artifacts, next_action, raw_json) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (ws_id, seq, task_id, status, summary[:8000], arts, next_action[:2000], raw_json[:16000]),
    )
    conn.execute(
        "UPDATE workstreams SET updated_at = datetime('now') WHERE id = ?",
        (ws_id,),
    )
    conn.commit()
    return {
        'workstream': name,
        'seq': seq,
        'status': status,
        'summary': summary,
        'artifacts': artifacts or [],
        'next': next_action,
    }


def list_episodes(session_id: str, name: str, *, limit: int = 20) -> list[dict[str, Any]]:
    try:
        name = normalize_name(name)
    except WorkstreamError:
        return []
    conn = _conn()
    row = conn.execute(
        'SELECT id FROM workstreams WHERE session_id = ? AND name = ?',
        (session_id, name),
    ).fetchone()
    if not row:
        return []
    rows = conn.execute(
        'SELECT seq, task_id, status, summary, artifacts, next_action, created_at, raw_json '
        'FROM workstream_episodes WHERE workstream_id = ? ORDER BY seq ASC',
        (int(row['id']),),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows[-limit:]:
        try:
            arts = json.loads(r['artifacts'] or '[]')
        except Exception:
            arts = []
        skills: list[str] = []
        unmet = ''
        criteria_met = False
        auto_hop = False
        try:
            raw = json.loads(r['raw_json'] or '{}')
            if isinstance(raw, dict):
                skills = [str(s) for s in (raw.get('skills') or []) if s][:12]
                unmet = as_str(raw.get('unmet'), '')
                criteria_met = bool(raw.get('criteriaMet'))
                auto_hop = bool(raw.get('autoHop'))
        except Exception:
            pass
        out.append(
            {
                'seq': int(r['seq']),
                'taskId': r['task_id'] or '',
                'status': r['status'] or '',
                'summary': r['summary'] or '',
                'artifacts': arts if isinstance(arts, list) else [],
                'next': r['next_action'] or '',
                'createdAt': r['created_at'] or '',
                'skills': skills,
                'unmet': unmet,
                'criteriaMet': criteria_met,
                'autoHop': auto_hop,
            }
        )
    return out


def latest_episode(session_id: str, name: str) -> dict[str, Any] | None:
    eps = list_episodes(session_id, name, limit=50)
    return eps[-1] if eps else None


def continue_handoff(session_id: str, name: str) -> dict[str, Any] | None:
    """Latest episode as a structured Continue card (not a transcript dump)."""
    ep = latest_episode(session_id, name)
    if not ep:
        return None
    return {
        'workstream': name,
        'seq': ep.get('seq'),
        'status': ep.get('status') or '',
        'summary': ep.get('summary') or '',
        'next': ep.get('next') or '',
        'artifacts': ep.get('artifacts') or [],
        'skills': ep.get('skills') or [],
        'unmet': ep.get('unmet') or '',
        'criteriaMet': bool(ep.get('criteriaMet')),
        'dirty': (ep.get('status') or '') != 'completed' or bool(ep.get('next')),
    }


def continue_goal(session_id: str, name: str, user_message: str = '') -> str:
    """User Continue text plus one episode card (not the full thread dump)."""
    user = as_str(user_message, '').strip() or 'Continue from the last episode.'
    card = continue_handoff(session_id, name)
    if not card:
        recap = format_episode_context(session_id, name)
        return f'{recap}\n\nUser: {user}' if recap else user
    lines = [
        f'EPISODE CARD `{name}` #{card["seq"]} status={card["status"]}',
        str(card['summary'] or '').strip(),
    ]
    if card.get('unmet'):
        lines.append(f'unmet: {card["unmet"]}')
    if card.get('next'):
        lines.append(f'next: {card["next"]}')
    arts = card.get('artifacts') or []
    if arts:
        lines.append('artifacts: ' + ', '.join(str(a) for a in arts[:12]))
    skills = card.get('skills') or []
    if skills:
        lines.append('skills: ' + ', '.join(str(s) for s in skills[:8]))
    lines.append(f'User: {user}')
    return '\n'.join(lines)


def format_episode_context(session_id: str, name: str) -> str:
    eps = list_episodes(session_id, name, limit=12)
    if not eps:
        return ''
    lines = [f'Thread `{name}` retained episodes:']
    for e in eps:
        arts = e.get('artifacts') or []
        art_s = f' artifacts={arts}' if arts else ''
        lines.append(
            f'- [{e["seq"]}] status={e["status"]}{art_s}\n  {e["summary"]}'
        )
        nxt = as_str(e.get('next'), '')
        if nxt:
            lines.append(f'  next: {nxt}')
    return '\n'.join(lines)


def weave_sources(session_id: str, source_names: list[str]) -> str:
    blocks: list[str] = []
    for n in source_names:
        raw = as_str(n, '')
        if not raw:
            continue
        try:
            normalize_name(raw)
        except WorkstreamError:
            continue
        ep = latest_episode(session_id, raw)
        if not ep:
            continue
        blocks.append(
            f'Source thread `{raw}` latest episode [{ep["seq"]}] '
            f'status={ep["status"]}:\n{ep["summary"]}'
        )
    return '\n\n'.join(blocks)


def list_workstreams(session_id: str) -> list[dict[str, Any]]:
    conn = _conn()
    rows = conn.execute(
        'SELECT name, updated_at FROM workstreams WHERE session_id = ? ORDER BY updated_at DESC',
        (session_id,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        name = r['name']
        ep = latest_episode(session_id, name)
        dirty = False
        if ep:
            dirty = (ep.get('status') or '') != 'completed' or bool(ep.get('next'))
        spec = None
        try:
            from app.services.harness_playbook import should_ping, specialist_for_workstream

            spec = specialist_for_workstream(session_id, name)
            if spec:
                dirty = should_ping(
                    spec.get('autonomy') or 'ask',
                    status=as_str((ep or {}).get('status'), ''),
                    next_action=as_str((ep or {}).get('next'), ''),
                    unmet=as_str((ep or {}).get('unmet'), ''),
                )
        except Exception:
            spec = None
        out.append(
            {
                'name': name,
                'updatedAt': r['updated_at'],
                'latest': ep,
                'dirty': dirty,
                'specialist': spec,
            }
        )
    try:
        from app.services.harness_jobs import list_jobs
        from app.services.harness_ops import annotate_attention

        live: set[str] = set()
        for job in list_jobs(session_id):
            if job.get('status') != 'running':
                continue
            for wave in job.get('waves') or []:
                live.update(n for n in wave if n)
        return annotate_attention(session_id, out, live)
    except Exception:
        return out


def parse_episode_payload(text: str, status_fallback: str = 'completed') -> dict[str, Any]:
    """Best-effort episode fields from worker final text."""
    summary = (text or '').strip()
    status = status_fallback
    artifacts: list[str] = []
    next_action = ''
    raw = ''
    try:
        from app.services.workbench.json_salvage import salvage_json_object

        parsed = salvage_json_object(text or '')
        if isinstance(parsed, dict):
            raw = json.dumps(parsed, ensure_ascii=False)
            summary = as_str(parsed.get('summary'), summary) or summary
            st = as_str(parsed.get('status'), '')
            if st in ('completed', 'blocked', 'partial'):
                status = st
            arts = parsed.get('artifacts')
            if isinstance(arts, list):
                artifacts = [str(a) for a in arts if a][:30]
            next_action = as_str(parsed.get('next'), '')
    except Exception:
        pass
    if not summary:
        summary = '(empty episode)'
    criteria_met = False
    unmet = ''
    try:
        blob = json.loads(raw) if raw else {}
        if isinstance(blob, dict):
            criteria_met = bool(blob.get('criteriaMet'))
            unmet = as_str(blob.get('unmet'), '')
            ver = blob.get('verification')
            if str(ver).lower() in ('pass', 'passed', 'ok', 'true'):
                criteria_met = True
    except Exception:
        blob = {}
    return {
        'status': status,
        'summary': summary[:8000],
        'artifacts': artifacts,
        'next': next_action,
        'raw_json': raw,
        'criteriaMet': criteria_met,
        'unmet': unmet,
    }


def judge_episode_status(
    parsed: dict[str, Any],
    *,
    acceptance_criteria: str = '',
    worker_status: str = '',
) -> dict[str, Any]:
    """Downgrade completed → partial when acceptance was not verified."""
    status = as_str(parsed.get('status'), 'completed')
    next_action = as_str(parsed.get('next'), '')
    unmet = as_str(parsed.get('unmet'), '')
    ws = (worker_status or '').strip().lower()
    if ws in ('failed', 'error'):
        status = 'blocked'
        unmet = unmet or as_str(parsed.get('summary'), '')[:300]
    elif ws in ('partial', 'cancelled'):
        status = 'partial'
    acceptance = (acceptance_criteria or '').strip()
    if acceptance and status == 'completed' and not parsed.get('criteriaMet'):
        blob = f'{parsed.get("summary") or ""} {parsed.get("raw_json") or ""}'.lower()
        if 'criteria met' not in blob and 'acceptance met' not in blob:
            status = 'partial'
            unmet = unmet or acceptance[:500]
            if not next_action:
                next_action = f'Unmet acceptance: {acceptance[:240]}'
            parsed['criteriaMet'] = False
    parsed['status'] = status
    parsed['next'] = next_action
    parsed['unmet'] = unmet
    return parsed


def merge_episode_raw(
    parsed: dict[str, Any], *, skills: list[str] | None = None, auto_hop: bool = False
) -> str:
    raw: dict[str, Any] = {}
    try:
        loaded = json.loads(as_str(parsed.get('raw_json'), '') or '{}')
        if isinstance(loaded, dict):
            raw = loaded
    except Exception:
        pass
    raw['status'] = parsed.get('status')
    raw['summary'] = parsed.get('summary')
    raw['next'] = parsed.get('next')
    raw['artifacts'] = parsed.get('artifacts') or []
    if parsed.get('unmet'):
        raw['unmet'] = parsed['unmet']
    raw['criteriaMet'] = bool(parsed.get('criteriaMet'))
    if skills:
        raw['skills'] = skills
    if auto_hop:
        raw['autoHop'] = True
    return json.dumps(raw, ensure_ascii=False)[:16000]


def goal_contract_prompt(
    acceptance_criteria: str = '',
    stop_condition: str = '',
    max_iterations: int = 0,
) -> str:
    if not (acceptance_criteria or stop_condition or max_iterations):
        return ''
    lines = ['GOAL CONTRACT:']
    if acceptance_criteria:
        lines.append(f'- Acceptance: {acceptance_criteria}')
        lines.append('- You MUST run verification (test/lint/build) before declaring success.')
        lines.append('- Stop when: criteria met AND verification passed.')
    if stop_condition:
        lines.append(f'- Stop / give up when: {stop_condition}')
    if max_iterations > 0:
        lines.append(
            f'- If you cannot meet criteria in {max_iterations} rounds, report status=blocked with reason.'
        )
    return '\n'.join(lines)


def episode_prompt(require_json: bool) -> str:
    schema = json.dumps(DEFAULT_EPISODE_SCHEMA, indent=2)
    if require_json:
        return (
            'Your FINAL message (no tool calls) is the episode handoff for future work. '
            'Return a SINGLE JSON object matching this schema, no prose, no markdown fences:\n'
            f'{schema}\n'
            'Do not include tool traces. The parent keeps only this episode.'
        )
    return (
        'When finished, end with a concise episode handoff: what you did, status '
        '(completed/blocked/partial), useful files, and next step. Prefer a JSON object '
        f'matching:\n{schema}'
    )
