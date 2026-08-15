"""Named specialists, episode routines, and ping-vs-continue policy."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from app.json_narrowing import as_list, as_str

logger = logging.getLogger(__name__)

AUTONOMY_ASK = 'ask'
AUTONOMY_ON_FAIL = 'on_fail'
AUTONOMY_SILENT = 'silent'
AUTONOMY_MODES = (AUTONOMY_ASK, AUTONOMY_ON_FAIL, AUTONOMY_SILENT)
MAX_AUTO_HOPS = 3


def _conn():
    from app.services.memory_store import _conn as mem_conn

    conn = mem_conn()
    _ensure_workspace_col(conn)
    return conn


def _ensure_workspace_col(conn) -> None:
    for table in ('harness_specialists', 'harness_routines'):
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN workspace_path TEXT DEFAULT ''")
            conn.commit()
        except Exception:
            pass


def _now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _json_list(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str) and raw.strip():
        try:
            loaded = json.loads(raw)
            if isinstance(loaded, list):
                return [str(x).strip() for x in loaded if str(x).strip()]
        except Exception:
            return [p.strip() for p in raw.split(',') if p.strip()]
    return []


def should_ping(
    autonomy: str,
    *,
    status: str,
    next_action: str = '',
    unmet: str = '',
) -> bool:
    """Whether the user should be interrupted (dirty / inbox ping)."""
    mode = (autonomy or AUTONOMY_ASK).strip().lower()
    if mode not in AUTONOMY_MODES:
        mode = AUTONOMY_ASK
    st = (status or '').strip().lower()
    failed = st in ('blocked', 'partial', 'failed', 'error', 'cancelled')
    if mode == AUTONOMY_SILENT:
        return failed
    if mode == AUTONOMY_ON_FAIL:
        return failed or bool(unmet)
    return failed or bool(next_action) or bool(unmet) or st != 'completed'


def should_auto_continue(
    autonomy: str,
    *,
    status: str,
    next_action: str = '',
    hops: int = 0,
) -> bool:
    """Silent lanes with a next step keep going, up to MAX_AUTO_HOPS."""
    mode = (autonomy or AUTONOMY_ASK).strip().lower()
    st = (status or '').strip().lower()
    nxt = (next_action or '').strip()
    return mode == AUTONOMY_SILENT and st == 'completed' and bool(nxt) and hops < MAX_AUTO_HOPS


def count_auto_hops(session_id: str, workstream: str) -> int:
    from app.services.workstreams import list_episodes

    n = 0
    for ep in reversed(list_episodes(session_id, workstream, limit=20)):
        if ep.get('autoHop'):
            n += 1
        else:
            break
    return n


def _row_specialist(r: Any) -> dict[str, Any]:
    ws_path = ''
    try:
        ws_path = r['workspace_path'] or ''
    except Exception:
        pass
    return {
        'id': r['id'],
        'sessionId': r['session_id'] or '',
        'name': r['name'],
        'workstream': r['workstream'] or '',
        'agentId': r['agent_id'] or 'general',
        'skills': _json_list(r['skills_json']),
        'model': r['model'] or '',
        'acceptance': r['acceptance'] or '',
        'restrictedTools': _json_list(r['restricted_tools_json']),
        'autonomy': r['autonomy'] or AUTONOMY_ASK,
        'workspacePath': ws_path,
        'createdAt': r['created_at'] or '',
    }


def _row_routine(r: Any) -> dict[str, Any]:
    ws_path = ''
    try:
        ws_path = r['workspace_path'] or ''
    except Exception:
        pass
    out = {
        'id': r['id'],
        'sessionId': r['session_id'] or '',
        'name': r['name'],
        'workstream': r['workstream'] or '',
        'goal': r['goal'] or '',
        'skills': _json_list(r['skills_json']),
        'agentId': r['agent_id'] or 'general',
        'specialistId': r['specialist_id'] or '',
        'sourceSeq': r['source_seq'] or 0,
        'workspacePath': ws_path,
        'schedule': '',
        'paused': False,
        'lastRun': '',
        'createdAt': r['created_at'] or '',
    }
    try:
        out['schedule'] = r['schedule'] or ''
        out['paused'] = bool(r['paused'])
        out['lastRun'] = r['last_run'] or ''
    except Exception:
        pass
    return out


def _workspace_clause(workspace: str) -> tuple[str, tuple]:
    path = (workspace or '').strip()
    if not path:
        return '', ()
    return ' OR workspace_path = ?', (path,)


def list_specialists(session_id: str, workspace: str = '') -> list[dict[str, Any]]:
    conn = _conn()
    extra, args = _workspace_clause(workspace)
    rows = conn.execute(
        'SELECT * FROM harness_specialists WHERE session_id = ? OR session_id = ""'
        + extra
        + ' ORDER BY created_at DESC',
        (session_id, *args),
    ).fetchall()
    return [_row_specialist(r) for r in rows]


def specialist_for_workstream(
    session_id: str, workstream: str, workspace: str = ''
) -> dict[str, Any] | None:
    name = as_str(workstream, '').strip()
    if not name:
        return None
    conn = _conn()
    extra, args = _workspace_clause(workspace)
    row = conn.execute(
        'SELECT * FROM harness_specialists WHERE workstream = ? AND (session_id = ? OR session_id = ""'
        + extra
        + ') ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END, created_at DESC LIMIT 1',
        (name, session_id, *args, session_id),
    ).fetchone()
    return _row_specialist(row) if row else None


def upsert_specialist(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    sid = as_str(body.get('id'), '')
    name = as_str(body.get('name') or body.get('workstream'), '').strip()
    workstream = as_str(body.get('workstream') or name, '').strip()
    workspace = as_str(body.get('workspacePath') or body.get('workspace_path'), '').strip()
    if not name:
        raise ValueError('Specialist needs a name')
    autonomy = as_str(body.get('autonomy'), AUTONOMY_ASK).strip().lower()
    if autonomy not in AUTONOMY_MODES:
        autonomy = AUTONOMY_ASK
    skills = json.dumps(_json_list(body.get('skills')), ensure_ascii=False)
    tools = json.dumps(_json_list(body.get('restrictedTools') or body.get('restricted_tools')), ensure_ascii=False)
    conn = _conn()
    if not sid:
        sid = f'spec_{uuid.uuid4().hex[:12]}'
        conn.execute(
            'INSERT INTO harness_specialists '
            '(id, session_id, name, workstream, agent_id, skills_json, model, acceptance, '
            'restricted_tools_json, autonomy, created_at, workspace_path) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (
                sid,
                session_id,
                name[:80],
                workstream[:80],
                as_str(body.get('agentId') or body.get('agent_id'), 'general') or 'general',
                skills,
                as_str(body.get('model'), ''),
                as_str(body.get('acceptance'), ''),
                tools,
                autonomy,
                _now(),
                workspace[:500],
            ),
        )
    else:
        conn.execute(
            'UPDATE harness_specialists SET name=?, workstream=?, agent_id=?, skills_json=?, '
            'model=?, acceptance=?, restricted_tools_json=?, autonomy=?, workspace_path=? WHERE id=?',
            (
                name[:80],
                workstream[:80],
                as_str(body.get('agentId') or body.get('agent_id'), 'general') or 'general',
                skills,
                as_str(body.get('model'), ''),
                as_str(body.get('acceptance'), ''),
                tools,
                autonomy,
                workspace[:500],
                sid,
            ),
        )
    conn.commit()
    row = conn.execute('SELECT * FROM harness_specialists WHERE id = ?', (sid,)).fetchone()
    if not row:
        raise ValueError('Specialist not found')
    return _row_specialist(row)


def set_autonomy(specialist_id: str, autonomy: str) -> dict[str, Any]:
    mode = (autonomy or AUTONOMY_ASK).strip().lower()
    if mode not in AUTONOMY_MODES:
        raise ValueError(f'autonomy must be one of {AUTONOMY_MODES}')
    conn = _conn()
    conn.execute('UPDATE harness_specialists SET autonomy = ? WHERE id = ?', (mode, specialist_id))
    conn.commit()
    row = conn.execute('SELECT * FROM harness_specialists WHERE id = ?', (specialist_id,)).fetchone()
    if not row:
        raise ValueError('Specialist not found')
    return _row_specialist(row)


def delete_specialist(specialist_id: str) -> None:
    conn = _conn()
    conn.execute('DELETE FROM harness_specialists WHERE id = ?', (specialist_id,))
    conn.commit()


def list_routines(session_id: str, workspace: str = '') -> list[dict[str, Any]]:
    conn = _conn()
    extra, args = _workspace_clause(workspace)
    rows = conn.execute(
        'SELECT * FROM harness_routines WHERE session_id = ? OR session_id = ""'
        + extra
        + ' ORDER BY created_at DESC',
        (session_id, *args),
    ).fetchall()
    return [_row_routine(r) for r in rows]


def save_routine(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    name = as_str(body.get('name'), '').strip()
    workstream = as_str(body.get('workstream'), '').strip()
    goal = as_str(body.get('goal'), '').strip()
    workspace = as_str(body.get('workspacePath') or body.get('workspace_path'), '').strip()
    if not name or not workstream:
        raise ValueError('Routine needs name and workstream')
    rid = f'rtn_{uuid.uuid4().hex[:12]}'
    conn = _conn()
    conn.execute(
        'INSERT INTO harness_routines '
        '(id, session_id, name, workstream, goal, skills_json, agent_id, specialist_id, '
        'source_seq, created_at, workspace_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        (
            rid,
            session_id,
            name[:120],
            workstream[:80],
            goal[:4000],
            json.dumps(_json_list(body.get('skills')), ensure_ascii=False),
            as_str(body.get('agentId') or body.get('agent_id'), 'general') or 'general',
            as_str(body.get('specialistId') or body.get('specialist_id'), ''),
            int(body.get('sourceSeq') or body.get('source_seq') or 0),
            _now(),
            workspace[:500],
        ),
    )
    conn.commit()
    row = conn.execute('SELECT * FROM harness_routines WHERE id = ?', (rid,)).fetchone()
    return _row_routine(row)


def save_routine_from_episode(
    session_id: str, workstream: str, seq: int | None = None, workspace: str = ''
) -> dict[str, Any]:
    from app.services.workstreams import list_episodes

    eps = list_episodes(session_id, workstream, limit=80)
    if not eps:
        raise ValueError('No episodes on this workstream')
    ep = eps[-1]
    if seq is not None:
        hit = next((e for e in eps if int(e.get('seq') or 0) == int(seq)), None)
        if hit:
            ep = hit
    next_or_summary = as_str(ep.get('next') or ep.get('summary'), '').strip()
    spec = specialist_for_workstream(session_id, workstream, workspace)
    return save_routine(
        session_id,
        {
            'name': f'{workstream} #{ep.get("seq")}',
            'workstream': workstream,
            'goal': next_or_summary or f'Continue {workstream}',
            'skills': ep.get('skills') or (spec or {}).get('skills') or [],
            'agentId': (spec or {}).get('agentId') or 'general',
            'specialistId': (spec or {}).get('id') or '',
            'sourceSeq': ep.get('seq') or 0,
            'workspacePath': workspace,
        },
    )


def get_routine(routine_id: str) -> dict[str, Any] | None:
    conn = _conn()
    row = conn.execute('SELECT * FROM harness_routines WHERE id = ?', (routine_id,)).fetchone()
    return _row_routine(row) if row else None


def delete_routine(routine_id: str) -> None:
    conn = _conn()
    conn.execute('DELETE FROM harness_routines WHERE id = ?', (routine_id,))
    conn.commit()


def continue_work_item(
    session_id: str, name: str, user_message: str = '', workspace: str = ''
) -> dict[str, Any]:
    """One spawn item that inherits specialist + last episode card."""
    from app.services.workstreams import continue_goal, continue_handoff

    card = continue_handoff(session_id, name) or {}
    spec = specialist_for_workstream(session_id, name, workspace) or {}
    skills = list(as_list(spec.get('skills'), []) or card.get('skills') or [])
    default = as_str(card.get('next'), '').strip() or 'Continue from the last episode.'
    user = as_str(user_message, '').strip() or default
    item: dict[str, Any] = {
        'goal': continue_goal(session_id, name, user),
        'agentId': spec.get('agentId') or 'general',
        'workstream': name,
        'name': name,
        'skills': [str(s) for s in skills if s],
    }
    if spec.get('acceptance'):
        item['acceptanceCriteria'] = spec['acceptance']
    if spec.get('model'):
        item['model'] = spec['model']
    if spec.get('restrictedTools'):
        item['restrictedTools'] = spec['restrictedTools']
    return item


def routine_work_item(session_id: str, routine: dict[str, Any]) -> dict[str, Any]:
    name = as_str(routine.get('workstream'), '')
    item = continue_work_item(
        session_id, name, as_str(routine.get('goal'), ''), as_str(routine.get('workspacePath'), '')
    )
    extra = _json_list(routine.get('skills'))
    if extra:
        merged = list(dict.fromkeys([*(item.get('skills') or []), *extra]))
        item['skills'] = merged
    if routine.get('agentId'):
        item['agentId'] = routine['agentId']
    return item


def session_digest(session_id: str, workspace: str = '') -> dict[str, Any]:
    from app.services.harness_jobs import list_jobs
    from app.services.workstreams import list_workstreams

    jobs = list_jobs(session_id)
    streams = list_workstreams(session_id)
    dirty_jobs = [j for j in jobs if j.get('dirty')]
    running = [j for j in jobs if j.get('status') == 'running']
    needs = []
    for ws in streams:
        latest = ws.get('latest') or {}
        if ws.get('dirty') or latest.get('status') in ('partial', 'blocked'):
            needs.append(
                {
                    'workstream': ws['name'],
                    'status': latest.get('status') or '',
                    'next': latest.get('next') or '',
                    'summary': (latest.get('summary') or '')[:160],
                }
            )
    out = {
        'running': len(running),
        'dirtyJobs': len(dirty_jobs),
        'needsHandoff': needs,
        'unread': len(needs) + len(running),
        'needsCount': len(needs),
        'workingCount': len(running),
        'specialists': list_specialists(session_id, workspace),
        'routines': list_routines(session_id, workspace),
        'unattended': False,
    }
    try:
        from app.services.harness_ops import is_unattended

        out['unattended'] = is_unattended()
    except Exception:
        pass
    return out


def schedule_auto_continue(session: object, emit: Any, workstream: str, next_action: str, hops: int) -> None:
    """Fire-and-forget Continue for a silent specialist lane."""
    import asyncio

    try:
        from app.services.harness_ops import is_unattended

        if is_unattended():
            if emit:
                emit(
                    {
                        'type': 'info',
                        'kind': 'harnessLaneDone',
                        'message': f'{workstream} paused — August has been idle over 24h',
                        'workstream': workstream,
                    }
                )
            return
    except Exception:
        pass

    sid = str(getattr(session, 'id', '') or '')
    workspace = str(getattr(session, 'workspacePath', '') or getattr(session, 'workspace_path', '') or '')
    if not sid or not workstream:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def _run() -> None:
        from app.services.runtime_services import get_orchestrator
        from app.services.tools.spawn_subagents_tool import executeSpawnSubagents

        item = continue_work_item(sid, workstream, next_action, workspace)
        item['autoHop'] = True
        if emit:
            emit(
                {
                    'type': 'info',
                    'kind': 'harnessAutoContinue',
                    'message': f'{workstream} continuing ({hops + 1}/{MAX_AUTO_HOPS}) → {next_action[:80]}',
                    'workstream': workstream,
                    'hop': hops + 1,
                }
            )
        try:
            from app.services.harness_jobs import record_lane

            record_lane('', workstream, 'continuing')
        except Exception:
            pass
        orch = get_orchestrator()
        await executeSpawnSubagents(orch, session, [item], mode='auto', emit=emit, background=True)

    loop.create_task(_run())
