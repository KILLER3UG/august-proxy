"""Preview sessions — backed by terminal_service (real PTY/command path).

  GET    /api/preview/sessions
  POST   /api/preview/sessions
  GET    /api/preview/session/{id}
  DELETE /api/preview/session/{id}
  POST   /api/preview/approve
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services.workbench import terminal_service as term

router = APIRouter(prefix='/api/preview')

# Map preview ids → terminal session ids
_preview_to_term: dict[str, str] = {}
_pending: dict[str, dict[str, object]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StartBody(CamelModel):
    command: str
    cwd: str = ''
    title: str = ''
    approved: bool = False


class ApproveBody(CamelModel):
    request_id: str
    approve: bool = True


def _as_preview(term_session: dict[str, object], preview_id: str) -> dict[str, object]:
    return {
        'id': preview_id,
        'title': term_session.get('title') or 'Preview',
        'cwd': term_session.get('cwd'),
        'command': term_session.get('command'),
        'status': term_session.get('status') or 'running',
        'url': None,
        'createdAt': term_session.get('createdAt'),
        'updatedAt': term_session.get('updatedAt'),
        'logLength': term_session.get('bufferLength') or 0,
        'terminalSessionId': term_session.get('id'),
    }


@router.get('/sessions')
async def list_sessions():
    sessions = []
    for pid, tid in list(_preview_to_term.items()):
        for s in term.listTerminalSessions():
            if s.get('id') == tid:
                sessions.append(_as_preview(s, pid))
                break
    return {
        'sessions': sessions,
        'approvals': list(_pending.values()),
    }


@router.post('/sessions')
async def start_session(body: StartBody):
    if not body.command.strip():
        raise HTTPException(status_code=400, detail='command is required')
    if not body.approved:
        req_id = f'prev_appr_{uuid.uuid4().hex[:8]}'
        _pending[req_id] = {
            'requestId': req_id,
            'type': 'preview_start',
            'command': body.command,
            'cwd': body.cwd,
            'title': body.title or body.command[:40],
            'createdAt': _now(),
        }
        return {
            'status': 'approval_required',
            'requestId': req_id,
            'reason': 'Preview commands require approval',
        }

    created = await term.createTerminalSession(
        {
            'title': body.title or body.command[:40] or 'Preview',
            'cwd': body.cwd,
            'command': '',
            'approvedInteractive': True,
        }
    )
    tid = str(created.get('id') or '')
    try:
        await term.submitTerminalCommand(
            {
                'sessionId': tid,
                'command': body.command,
                'approved': True,
            }
        )
    except Exception:
        pass
    pid = f'prev_{uuid.uuid4().hex[:10]}'
    _preview_to_term[pid] = tid
    for s in term.listTerminalSessions():
        if s.get('id') == tid:
            return _as_preview(s, pid)
    return _as_preview(created, pid)


@router.get('/session/{sessionId}')
async def get_session(sessionId: str):
    tid = _preview_to_term.get(sessionId)
    if not tid:
        raise HTTPException(status_code=404, detail='Preview session not found')
    try:
        detail = term.readTerminalBuffer(tid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    preview = _as_preview(detail, sessionId)
    preview['log'] = detail.get('buffer') or ''
    return preview


@router.delete('/session/{sessionId}')
async def stop_session(sessionId: str):
    tid = _preview_to_term.pop(sessionId, None)
    if not tid:
        raise HTTPException(status_code=404, detail='Preview session not found')
    await term.closeTerminalSession(tid)
    return {'deleted': True}


@router.post('/approve')
async def approve(body: ApproveBody):
    appr = _pending.pop(body.request_id, None)
    if not appr:
        raise HTTPException(status_code=404, detail='Approval request not found')
    if not body.approve:
        return {'status': 'rejected', 'requestId': body.request_id}
    start = StartBody(
        command=str(appr.get('command') or ''),
        cwd=str(appr.get('cwd') or ''),
        title=str(appr.get('title') or ''),
        approved=True,
    )
    return await start_session(start)
