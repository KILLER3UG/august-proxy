"""
Workbench chat routes — POST to start, GET SSE stream.

Port of the Express routes from the JS backend. Uses the workbench
service for session management and chat loop.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Callable

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.json_narrowing import as_dict, as_float, as_int, as_list, as_str
from app.services import event_log
from app.services.workbench import workbench as wb

router = APIRouter(prefix='/api/workbench')
_chatTasks: set[asyncio.Task] = set()
_cancelled: dict[str, asyncio.Event] = {}
# One in-flight stream per session (gateway parity). Extra POSTs enqueue.
_activeStreams: dict[str, asyncio.Task] = {}


def _session_turn_in_flight(session_id: str) -> bool:
    """Probe for the session store's snapshot prune: is a chat turn live?"""
    task = _activeStreams.get(session_id)
    return task is not None and not task.done()


# Register the probe so the debounced snapshot prune never evicts a session
# whose chat turn is still writing to the in-memory object (sessions.py).
try:
    from app.services.workbench.sessions import set_active_turn_check

    set_active_turn_check(_session_turn_in_flight)
except Exception:
    pass


def _log_emit(sessionId: str) -> Callable[[dict[str, object]], None]:
    """Return an SSE emitter that appends events to the session event log."""

    def _emit(event: dict[str, object]) -> None:
        event_log.event_log.append(sessionId, str(event.get('type') or 'message'), event)

    return _emit


def _startTurnTask(
    sessionId: str,
    *,
    message: str,
    provider: str = '',
    agentId: str = '',
    effort: str = '',
    thinking_enabled: bool = True,
    model: str = '',
    modelProvider: str = '',
    guardMode: str = '',
    handoff_summary: str = '',
) -> int:
    """Start one workbench turn in the background.

    Registers the cancel event + active-stream task and runs the streaming
    loop. Shared by the POST /chat handler and the subagent auto-turn so
    both participate in the same concurrency gate (``/chat/active`` and
    the queue check see either). Returns the ``started`` event sequence
    number for resumable SSE clients.
    """
    seq = event_log.event_log.append(sessionId, 'started', {'sinceSeq': 0})
    cancelEvent = asyncio.Event()
    _cancelled[sessionId] = cancelEvent

    def _notify_chat_idle() -> None:
        try:
            from app.services.realtime_bus import emit_realtime

            emit_realtime('chat.idle', sessionId=sessionId)
        except Exception:
            pass

    async def safeStream():
        try:
            await wb.sendWorkbenchMessageStream(
                sessionId=sessionId,
                message=message,
                provider=provider,
                agentId=agentId,
                effort=effort,
                thinking_enabled=thinking_enabled,
                model=model,
                modelProvider=modelProvider,
                guardMode=guardMode,
                handoff_summary=handoff_summary,
                emit=_log_emit(sessionId),
                signal=cancelEvent,
            )
        except asyncio.CancelledError:
            try:
                session = wb.getWorkbenchSession(sessionId)
                if session:
                    session.status = 'idle'
                    session.updatedAt = wb._now()
                    wb.saveSessions()
                    wb._emitSessionStatus(sessionId)
            except Exception:
                pass
            try:
                event_log.event_log.append(sessionId, 'aborted', {})
                event_log.event_log.append(sessionId, 'done', {'type': 'done', 'sessionId': sessionId})
            except Exception:
                pass
        except Exception as exc:
            import traceback

            traceback.print_exc()
            try:
                session = wb.getWorkbenchSession(sessionId)
                if session:
                    session.status = 'idle'
                    session.updatedAt = wb._now()
                    wb.saveSessions()
                    wb._emitSessionStatus(sessionId)
            except Exception:
                pass
            try:
                event_log.event_log.append(
                    sessionId, 'error', {'type': 'error', 'message': f'Fatal background error: {exc}'}
                )
                event_log.event_log.append(sessionId, 'done', {'type': 'done', 'sessionId': sessionId})
            except Exception:
                pass
        finally:
            # Identity-checked pops: a stale task finishing after Stop+restart
            # must not remove the replacement turn's cancel event / task slot.
            if _cancelled.get(sessionId) is cancelEvent:
                _cancelled.pop(sessionId, None)
            if _activeStreams.get(sessionId) is task:
                _activeStreams.pop(sessionId, None)
            _notify_chat_idle()

    task = asyncio.create_task(safeStream())
    _activeStreams[sessionId] = task
    _chatTasks.add(task)
    task.add_done_callback(_chatTasks.discard)
    try:
        from app.services.realtime_bus import emit_realtime

        emit_realtime('chat.active', sessionId=sessionId, status='streaming')
    except Exception:
        pass
    return seq


# ── Auto-turn for late subagent completions ─────────────────────────────
# Background sub-agents settle after the parent turn may already have
# ended. The spawn tool enqueues each completion (kind='subagent'); when
# the session is idle we start a fresh turn so the parent model actually
# receives the result instead of waiting for the user's next message.
# Coalesced (1.5 s), deduped per session, and capped so a model that keeps
# spawning cannot drive the session forever.
_AUTO_TURN_COALESCE_S = 1.5
_AUTO_TURN_MAX_CONSECUTIVE = 4
_autoTurnWakes: dict[str, asyncio.Task] = {}


async def _startSubagentAutoTurn(sessionId: str) -> None:
    """Run one turn from the session's queued subagent completions."""
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        return
    existing = _activeStreams.get(sessionId)
    if existing is not None and not existing.done():
        return  # a turn is live — its next loop boundary drains the queue
    consecutive = int(getattr(session, '_autoTurnsSinceUser', 0) or 0)
    if consecutive >= _AUTO_TURN_MAX_CONSECUTIVE:
        return
    session._autoTurnsSinceUser = consecutive + 1  # type: ignore[attr-defined]
    entries = wb.drainQueuedMessages(
        sessionId,
        emit=_log_emit(sessionId),
        kinds={'subagent'},
    )
    if not entries:
        return
    # Queue is FIFO for every kind — join in arrival order.
    message = '\n\n'.join(str(e.get('text') or '') for e in entries)
    if not message.strip():
        return
    _startTurnTask(
        sessionId,
        message=message,
        provider=as_str(getattr(session, 'provider', '') or ''),
        agentId=as_str(getattr(session, 'agentId', '') or ''),
        guardMode=as_str(getattr(session, 'guardMode', '') or ''),
    )


def scheduleSubagentAutoTurn(sessionId: str) -> None:
    """Schedule a coalesced auto-turn once queued subagent completions settle.

    Safe to call from any async context; dedupes per session and never
    raises. The parent session's own loop drains mid-turn completions at
    its next round boundary — this only covers completions that arrive
    after the turn already ended.
    """
    wake = _autoTurnWakes.get(sessionId)
    if wake is not None and not wake.done():
        return

    async def _wake() -> None:
        try:
            await asyncio.sleep(_AUTO_TURN_COALESCE_S)
            await _startSubagentAutoTurn(sessionId)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            _autoTurnWakes.pop(sessionId, None)

    try:
        _autoTurnWakes[sessionId] = asyncio.create_task(_wake())
    except RuntimeError:
        pass  # no running event loop (import-time/thread call) — skip


@router.post('/sessions')
async def createSession(request: Request):
    """Create a new workbench session."""
    body = await request.json() if request.headers.get('content-type') else {}
    session = wb.createWorkbenchSession(
        provider=body.get('provider', ''),
        agentId=body.get('agentId', ''),
        guardMode=body.get('guardMode', ''),
        task=body.get('task', ''),
        goal=body.get('goal', ''),
        workspacePath=body.get('workspacePath', '') or body.get('workspace_path', ''),
        sandboxMode=body.get('sandboxMode', '') or body.get('sandbox_mode', ''),
        sandboxNetwork=body.get('sandboxNetwork') if 'sandboxNetwork' in body else body.get('sandbox_network'),
    )
    return session.toDict()


@router.get('/sessions')
async def list_sessions():
    """List all workbench sessions."""
    return wb.listWorkbenchSessions()


@router.get('/sessions/{sessionId}')
async def get_session(sessionId: str):
    """Get a session by ID."""
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.get('/session')
async def getSessionByQuery(sessionId: str = ''):
    """Get a session by ID from query parameter."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId required')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.post('/session')
async def createSessionDirect(request: Request):
    """Create a new workbench session."""
    body = await request.json() if request.headers.get('content-type') else {}
    session = wb.createWorkbenchSession(
        provider=body.get('provider', ''),
        agentId=body.get('agentId', ''),
        guardMode=body.get('guardMode', ''),
        workspacePath=body.get('workspacePath', '') or body.get('workspace_path', ''),
        sandboxMode=body.get('sandboxMode', '') or body.get('sandbox_mode', ''),
        sandboxNetwork=body.get('sandboxNetwork') if 'sandboxNetwork' in body else body.get('sandbox_network'),
    )
    return session.toDict()


@router.delete('/sessions/{sessionId}')
async def deleteSession(sessionId: str):
    """Delete a session and cancel all in-flight work bound to it.

    Cancels the live chat-turn task / cancel event / coalesced auto-turn wake
    first (the identity-checked cleanup in ``safeStream`` makes the pops
    safe), then delegates to ``deleteWorkbenchSession`` which cancels the
    service-layer work (orchestrator workers, spawn watchers, recurring-task
    sub-agents, pending proposals, environment watcher) before the cascade.
    """
    cancelEvent = _cancelled.pop(sessionId, None)
    if cancelEvent is not None:
        cancelEvent.set()
    task = _activeStreams.pop(sessionId, None)
    if task is not None and not task.done():
        task.cancel()
    wake = _autoTurnWakes.pop(sessionId, None)
    if wake is not None and not wake.done():
        wake.cancel()
    if not wb.deleteWorkbenchSession(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    return {'status': 'ok'}


@router.patch('/sessions/{sessionId}/title')
async def renameSessionTitle(sessionId: str, request: Request):
    """Rename a workbench session (sidebar title)."""
    body = await request.json() if request.headers.get('content-type') else {}
    title = str(body.get('title') or '').strip()
    if not title:
        raise HTTPException(status_code=400, detail='title required')
    from app.services.workbench.sessions import rename_workbench_session

    session = rename_workbench_session(sessionId, title)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.post('/session/rename')
async def renameSessionTitlePost(request: Request):
    """Rename via body { sessionId, title } (tool-friendly)."""
    body = await request.json() if request.headers.get('content-type') else {}
    sessionId = str(body.get('sessionId') or '').strip()
    title = str(body.get('title') or '').strip()
    if not sessionId or not title:
        raise HTTPException(status_code=400, detail='sessionId and title required')
    from app.services.workbench.sessions import rename_workbench_session

    session = rename_workbench_session(sessionId, title)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.post('/sessions/{sessionId}/reset')
async def resetSession(sessionId: str, request: Request):
    """Reset a session (delete and recreate)."""
    body = await request.json() if request.headers.get('content-type') else {}
    session = wb.resetWorkbenchSession(sessionId, provider=body.get('provider', ''), agentId=body.get('agentId', ''))
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.get('/sessions/{sessionId}/status')
async def sessionStatus(sessionId: str):
    """Get session status (for approval banner)."""
    status = wb.getWorkbenchSessionStatus(sessionId)
    if not status:
        raise HTTPException(status_code=404, detail='Session not found')
    return status


@router.get('/session/{sessionId}/status')
async def sessionStatusSingular(sessionId: str):
    """Get session status — singular path (used by ApprovalBanner)."""
    return await sessionStatus(sessionId)


@router.post('/chat')
async def startChat(request: Request):
    """Start a chat generation.

    Returns sessionId immediately; actual events stream through the
    SSE endpoint using the event log.

    If a turn is already streaming for this session, the message is
    **queued** (not run concurrently) so transcripts cannot race.
    """
    body = await request.json()
    sessionId = body.get('sessionId', str(uuid.uuid4()))
    message = body.get('message', '')
    provider = body.get('provider', '')
    agentId = body.get('agentId', '')
    effort = body.get('effort', '')
    thinking_raw = body.get('thinkingEnabled', True)
    thinking_enabled = thinking_raw if isinstance(thinking_raw, bool) else True
    model = body.get('model', '')
    modelProvider = body.get('modelProvider', '')
    guardMode = body.get('guardMode', '')

    # One in-flight agent turn per session (same invariant as gateway).
    # Only key off the live task map — a stale status=='streaming' without a
    # task must not permanently block the session.
    existing = _activeStreams.get(sessionId)
    if existing and not existing.done():
        # If a stop is already in flight, free the slot instead of queueing.
        cancel_ev = _cancelled.get(sessionId)
        if cancel_ev is not None and cancel_ev.is_set():
            _activeStreams.pop(sessionId, None)
            if not existing.done():
                existing.cancel()
        else:
            entry = wb.enqueueUserMessage(sessionId, message) if message else None
            return {
                'status': 'queued',
                'sessionId': sessionId,
                'queuedMessageId': (entry or {}).get('id') if entry else None,
                'message': 'A turn is already in progress; message queued for the next iteration boundary.',
            }
    if existing and existing.done():
        _activeStreams.pop(sessionId, None)

    # A real user turn breaks any chain of backend-started continuation
    # turns (subagent auto-turns are capped per user turn).
    try:
        user_session = wb.getWorkbenchSession(sessionId)
        if user_session is not None and message:
            user_session._autoTurnsSinceUser = 0  # type: ignore[attr-defined]
    except Exception:
        pass

    handoff_summary = as_str(body.get('handoffSummary') or body.get('handoff_summary') or '')
    if not handoff_summary:
        # No client-computed handoff this turn — fall back to the latest
        # persisted server-side handoff (from POST .../handoff), consumed once.
        try:
            from app.services.workbench.sessions import format_session_handoff, take_session_handoff

            persisted_handoff = take_session_handoff(sessionId)
            if persisted_handoff:
                handoff_summary = format_session_handoff(persisted_handoff)
        except Exception:
            pass

    seq = _startTurnTask(
        sessionId,
        message=message,
        provider=provider,
        agentId=agentId,
        effort=effort,
        thinking_enabled=thinking_enabled,
        model=model,
        modelProvider=modelProvider,
        guardMode=guardMode,
        handoff_summary=handoff_summary,
    )
    return {'status': 'started', 'sessionId': sessionId, 'sinceSeq': seq}


@router.get('/chat/stream')
async def streamChat(
    sessionId: str = Query(default='', alias='sessionId'), sinceSeqRaw: str = Query(default='0', alias='sinceSeq')
):
    """SSE stream for chat events."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    sessionId = sessionId
    sinceSeq = int(sinceSeqRaw) if sinceSeqRaw and sinceSeqRaw.isdigit() else 0

    async def generate():
        async for event in event_log.event_log.subscribe(sessionId, sinceSeq):
            if event['type'] == 'keepalive':
                yield ': keepalive\n\n'
                continue
            yield f'event: {event["type"]}\ndata: {json.dumps(event["payload"])}\nid: {event["seq"]}\n\n'
            if event['type'] in ('done', 'error', 'aborted'):
                break

    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


@router.post('/chat/stop')
async def stopChat(request: Request):
    """Abort a running generation and free the session for a new turn.

    Immediately clears the in-flight task slot and — unless the caller
    asks to keep them (``preserveQueue: true``) — queued follow-ups so the
    next POST /chat is not stuck behind "already in progress". Stopping to
    switch models must not destroy the user's queued follow-ups, so the
    frontend always preserves them and the queue drains into the next turn.
    """
    body = await request.json()
    sessionId = body.get('sessionId', '')
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')

    cancelEvent = _cancelled.get(sessionId)
    if cancelEvent and (not cancelEvent.is_set()):
        cancelEvent.set()

    # Free the slot now — do not wait for the LLM stream to notice cancel.
    task = _activeStreams.pop(sessionId, None)
    if task is not None and not task.done():
        task.cancel()

    cleared = 0
    preserveQueue = bool(body.get('preserveQueue', False))
    if not preserveQueue:
        try:
            cleared = wb.clearQueuedMessages(sessionId)
        except Exception:
            cleared = 0

    try:
        session = wb.getWorkbenchSession(sessionId)
        if session:
            session.status = 'idle'
            session.updatedAt = wb._now()
            wb.saveSessions()
            wb._emitSessionStatus(sessionId)
    except Exception:
        pass

    try:
        event_log.event_log.append(sessionId, 'aborted', {})
        event_log.event_log.append(sessionId, 'done', {'type': 'done', 'sessionId': sessionId})
    except Exception:
        pass

    try:
        from app.services.realtime_bus import emit_realtime

        emit_realtime('chat.idle', sessionId=sessionId)
    except Exception:
        pass

    return {'status': 'ok', 'clearedQueue': cleared}


@router.get('/chat/active')
async def activeChats():
    """Map of workbench session ids currently generating → ``streaming``.

    Sidebar / ChatThread poll this to keep the AUG pulse and ``streaming``
    flag in sync. Must be a flat ``{ sessionId: 'streaming' }`` map — not
    activity counters (those wipe the client store every poll).
    """
    active: dict[str, str] = {}
    for sid, task in list(_activeStreams.items()):
        if task is None:
            continue
        if task.done():
            _activeStreams.pop(sid, None)
            continue
        active[sid] = 'streaming'
    return active


@router.get('/workspace/files')
async def workspaceFiles(sessionId: str = '', path: str = '', q: str = '', limit: int = 60):
    """Bounded workspace file listing for the composer @-mention file search.

    Lists files under the active session's workspace (or ``path`` when given),
    filtered by the ``q`` prefix. Never recurses deeper than 3 levels and caps
    the result so the mention picker stays fast.
    """
    import os
    from pathlib import Path

    try:
        if path:
            root: Path | None = Path(path).expanduser()
        else:
            session = wb.getWorkbenchSession(sessionId) if sessionId else None
            ws = as_str(getattr(session, 'workspacePath', '') or '') if session else ''
            root = Path(ws).expanduser() if ws else None
        if root is None or not root.is_dir():
            return {'results': []}
        query = (q or '').strip().lower()
        results: list[str] = []
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root)
            depth = 0 if rel_dir == '.' else rel_dir.count(os.sep) + 1
            if depth > 3:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__')]
            for name in filenames:
                if name.startswith('.'):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, name), root).replace('\\', '/')
                if query and query not in rel.lower():
                    continue
                results.append(rel)
                if len(results) >= max(1, min(limit, 200)):
                    return {'results': results}
        return {'results': results}
    except Exception:
        return {'results': []}


@router.get('/files/read')
async def readFile(path: str = '', sessionId: str = ''):
    """Read a file as base64 for the right-drawer viewer.

    Dev / backend-only runs have no Tauri FS API, so the frontend falls back
    to this route (payload mirrors the ``read_file_base64`` invoke). The path
    must resolve inside the requesting session's workspace, any live
    workbench session's workspace, or the system temp area; hardline
    protected paths are refused in every case.
    """
    import base64
    import mimetypes
    import tempfile
    from pathlib import Path

    from app.services.sandbox.hardline import check_hardline_path
    from app.services.sandbox.paths import is_within_root, resolve_workspace_root

    raw = (path or '').strip()
    if not raw:
        raise HTTPException(status_code=400, detail='path is required')
    try:
        resolved = Path(raw).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f'Invalid path: {exc}')
    denial = check_hardline_path(str(resolved), for_write=False)
    if denial:
        raise HTTPException(status_code=403, detail=f'Sandbox hardline blocked: {denial}')
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail='File not found')

    roots: list[Path] = []
    if sessionId:
        session = wb.getWorkbenchSession(sessionId)
        ws = as_str(getattr(session, 'workspacePath', '') or '') if session else ''
        root = resolve_workspace_root(ws)
        if root is not None:
            roots.append(root)
    for entry in wb.listWorkbenchSessions():
        root = resolve_workspace_root(as_str(entry.get('workspacePath') or ''))
        if root is not None and root not in roots:
            roots.append(root)
    try:
        roots.append(Path(tempfile.gettempdir()).resolve())
    except OSError:
        pass
    if not any(is_within_root(resolved, root) for root in roots):
        raise HTTPException(
            status_code=403,
            detail='Path is outside every workbench workspace and the temp area',
        )

    MAX_BYTES = 25 * 1024 * 1024
    try:
        size = resolved.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f'Cannot stat file: {exc}')
    if size > MAX_BYTES:
        raise HTTPException(
            status_code=413, detail=f'File too large ({size} bytes; limit {MAX_BYTES})'
        )
    data = base64.b64encode(resolved.read_bytes()).decode('ascii')
    mime, _ = mimetypes.guess_type(resolved.name)
    return {
        'ok': True,
        'data': data,
        'name': resolved.name,
        'path': str(resolved),
        'mimeType': mime or 'application/octet-stream',
    }


@router.post('/chat/queue')
async def queueMessage(request: Request):
    """Enqueue a user message for delivery to the model mid-response.

    Body: { sessionId, text, attachments?, kind?: 'queue'|'steer' }

    - ``queue`` (default): follow-up at the next loop boundary
    - ``steer``: mid-run course correction (priority, stronger prompt)

    The message is stored on the session and surfaced to the model's
    chat loop at the next tool/LLM boundary without cancelling the turn.
    """
    body = await request.json()
    sessionId = body.get('sessionId', '')
    text = body.get('text', '')
    attachments = body.get('attachments') or []
    kind = str(body.get('kind') or 'queue')
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if not text and (not attachments):
        raise HTTPException(status_code=400, detail='text or attachments required')
    entry = wb.enqueueUserMessage(
        sessionId=sessionId, text=text, attachments=attachments, kind=kind
    )
    if entry is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return entry


@router.post('/chat/steer')
async def steerMessage(request: Request):
    """Mid-run steer — same as queue with kind=steer (course correction)."""
    body = await request.json()
    body = dict(body) if isinstance(body, dict) else {}
    body['kind'] = 'steer'
    # Reuse queue handler logic
    sessionId = body.get('sessionId', '')
    text = body.get('text', '')
    attachments = body.get('attachments') or []
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if not text and (not attachments):
        raise HTTPException(status_code=400, detail='text or attachments required')
    entry = wb.enqueueUserMessage(
        sessionId=sessionId, text=text, attachments=attachments, kind='steer'
    )
    if entry is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return entry


@router.delete('/chat/queue/{message_id}')
async def dequeueMessage(message_id: str, sessionId: str = Query(default='', alias='sessionId')):
    """Remove a queued message by id before it's delivered to the model."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    removed = wb.dequeueUserMessage(sessionId=sessionId, messageId=message_id)
    if not removed:
        raise HTTPException(status_code=404, detail='Queued message not found')
    return {'status': 'ok', 'messageId': message_id}


@router.delete('/chat/queue')
async def clearQueue(sessionId: str = Query(default='', alias='sessionId')):
    """Clear all queued messages for a session."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if not wb.getWorkbenchSession(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    count = wb.clearQueuedMessages(sessionId)
    return {'status': 'ok', 'sessionId': sessionId, 'cleared': count}


@router.patch('/chat/queue')
async def reorderQueue(request: Request):
    """Reorder queued messages.

    Body: { sessionId, order: string[] }  — message ids in the desired order.
    """
    body = await request.json()
    sessionId = body.get('sessionId', '')
    order = body.get('order') or body.get('orderedIds') or []
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if not isinstance(order, list):
        raise HTTPException(status_code=400, detail='order must be a list of message ids')
    messages = wb.reorderQueuedMessages(sessionId, [str(x) for x in order])
    if messages is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return {'sessionId': sessionId, 'messages': messages}


@router.patch('/chat/queue/{message_id}')
async def updateQueueMessage(message_id: str, request: Request):
    """Edit the text of a queued message before delivery.

    Body: { sessionId, text }
    """
    body = await request.json()
    sessionId = body.get('sessionId', '')
    text = body.get('text')
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if text is None:
        raise HTTPException(status_code=400, detail='text is required')
    entry = wb.updateQueuedMessage(sessionId, message_id, text=str(text))
    if entry is None:
        raise HTTPException(status_code=404, detail='Queued message not found')
    return entry


@router.get('/chat/queue')
async def listQueue(sessionId: str = Query(default='', alias='sessionId')):
    """List current queued messages for a session (for initial sync)."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    return {'sessionId': sessionId, 'messages': wb.listQueuedMessages(sessionId)}


@router.post('/plan')
async def submitPlanRoute(request: Request):
    """Submit a plan for a session."""
    body = await request.json()
    sessionId = body.get('sessionId', '')
    planData = body.get('plan', {})
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    wb.submitPlan(session, planData)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, plan=True)
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return {'status': 'ok'}


async def _readSessionId(request: Request) -> str:
    """Read ``sessionId`` from the JSON body, falling back to the query string.

    The plan approve/reject endpoints historically declared ``sessionId`` as a
    query param while the desktop client sends it in the JSON body (matching the
    ``/plan`` submit route). Accept both so neither client style 404s.
    """
    sessionId = ''
    try:
        body = await request.json()
        if isinstance(body, dict):
            sessionId = str(body.get('sessionId') or '')
    except Exception:
        sessionId = ''
    if not sessionId:
        sessionId = request.query_params.get('sessionId') or ''
    return sessionId


@router.post('/plan/approve')
async def approvePlan(request: Request):
    """Approve a pending plan."""
    sessionId = await _readSessionId(request)
    if not wb.approveWorkbenchPlan(sessionId):
        raise HTTPException(status_code=404, detail='Session not found or no plan pending')
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, planApproved=True)
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return {'status': 'approved'}


@router.post('/plan/reject')
async def rejectPlan(request: Request):
    """Reject a pending plan."""
    sessionId = await _readSessionId(request)
    if not wb.rejectWorkbenchPlan(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, plan=False)
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return {'status': 'rejected'}


@router.post('/todos')
async def submitTodosRoute(request: Request):
    """Submit a todo list for a session."""
    body = await request.json()
    sessionId = body.get('sessionId', '')
    todosData = body.get('todos', [])
    title = body.get('title', '')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    wb.submitTodos(session, todosData, title=title)
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('workbench-session', session_id=sessionId)
    except Exception:
        pass
    return {'status': 'ok', 'todos': session.todos}


@router.patch('/todos')
async def updateTodosRoute(request: Request):
    """Update (replace) a session's todo list."""
    body = await request.json()
    sessionId = body.get('sessionId', '')
    todosData = body.get('todos', [])
    title = body.get('title', '')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    wb.updateTodos(session, todosData, title=title)
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('workbench-session', session_id=sessionId)
    except Exception:
        pass
    return {'status': 'ok', 'todos': session.todos}


@router.post('/mutations/respond')
async def respondMutation(request: Request):
    """Respond to a pending mutation (accept/reject — pre-apply).

    Body: { token, reject?, scope?: 'once'|'session'|'always', continue?: bool,
            instructions?: str }

    On **accept**: records a grant, **executes the tool with the stored args**,
    then optionally starts a continuation turn that feeds the real tool result
    to the model (no blind retry).

    On **reject**: discards the pending change without running the tool.
    When `instructions` accompanies a reject, the continuation turn carries
    the user's free-form instructions instead of the generic rejection notice.
    """
    body = await request.json()
    token = str(body.get('token') or '')
    reject = bool(body.get('reject', False))
    scope = str(body.get('scope') or 'once')
    do_continue = body.get('continue', True) is not False
    instructions = str(body.get('instructions') or '').strip()
    result = wb.consumePendingMutation(token, reject=reject, scope=scope)
    if result is None:
        raise HTTPException(status_code=404, detail='Mutation token not found')
    session_id = str(result.get('sessionId') or '')
    tool_name = str(result.get('toolName') or '')
    args = as_dict(result.get('args'), {})

    # Pre-apply: run the approved tool immediately with stored arguments.
    exec_result: str | None = None
    if not reject and session_id and tool_name:
        session = wb.getWorkbenchSession(session_id)
        if session is not None:
            try:
                exec_result = await wb.execute_approved_mutation(session, tool_name, args)
                result['executed'] = True
                result['toolResult'] = (exec_result or '')[:8000]
            except Exception as exc:
                exec_result = f'Tool {tool_name} failed after approval: {exc}'
                result['executed'] = False
                result['toolResult'] = exec_result
                result['executeError'] = str(exc)
            try:
                wb.saveSessions()
            except Exception:
                pass

    remaining = as_int(result.get('remainingPending'), 0)
    next_status = 'awaiting_approval' if remaining > 0 else 'idle'
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime(
            'session.updated',
            sessionId=session_id,
            status=next_status,
            mutation=result.get('status'),
            executed=bool(result.get('executed')),
            remainingPending=remaining,
        )
        emit_invalidate('session-status', 'workbench-session', session_id=session_id)
    except Exception:
        pass

    # After accept (+ execute), continue so the model sees the real result —
    # but only once the whole approval stack is cleared. Continuing mid-stack
    # hides remaining MutationDiffCards.
    # On reject, optionally notify so the model does not assume the change landed.
    #
    # Ask-mode already returned a [Blocked] tool result to the model, so a still-
    # running original stream will never "pick up" the grant. Cancel any stale
    # active stream and always start the continuation turn.
    if do_continue and session_id and remaining <= 0:
        existing = _activeStreams.get(session_id)
        if existing and not existing.done():
            try:
                stale_cancel = _cancelled.get(session_id)
                if stale_cancel and not stale_cancel.is_set():
                    stale_cancel.set()
                existing.cancel()
            except Exception:
                pass
            _activeStreams.pop(session_id, None)
        elif existing and existing.done():
            _activeStreams.pop(session_id, None)

        session = wb.getWorkbenchSession(session_id)
        if reject:
            if instructions:
                msg = (
                    f'The user **declined** the pending tool `{tool_name}` and gave '
                    'these instructions instead:\n\n'
                    f'{instructions[:4000]}\n\n'
                    'Do **not** run the declined change. Follow the instructions above.'
                )
            else:
                msg = (
                    f'The user **rejected** the pending tool `{tool_name}`. '
                    'Do not run that change. Acknowledge briefly and ask how they want to proceed.'
                )
        else:
            result_snip = (exec_result or as_str(result.get('toolResult'), ''))[:6000]
            # A failed execution must not arrive wrapped in "executed, do not
            # re-run" wording — the model would treat the error text as a
            # success receipt and never retry (session-experience finding).
            # Failure is judged by the authoritative `executed` flag (plus the
            # sandbox's explicit 'failed after approval' marker), never by the
            # result text merely starting with "Error" — legitimate results
            # (log excerpts, grep hits) would false-positive.
            failed = (
                result.get('executed') is False
                or 'failed after approval' in result_snip
            )
            if failed:
                msg = (
                    f'The user **accepted** the pending tool `{tool_name}` '
                    f'(scope={result.get("scope")}), but the execution **failed** '
                    '— the change did **not** land. It was attempted once with '
                    'the approved arguments.\n\n'
                    f'Tool result:\n```\n{result_snip}\n```\n\n'
                    'Diagnose the failure; you may retry with corrected '
                    'arguments or take a different approach.'
                )
            else:
                msg = (
                    f'The user **accepted** the pending tool `{tool_name}` '
                    f'(scope={result.get("scope")}). '
                    'It was executed with the approved arguments — do **not** re-run it '
                    'unless further changes are needed.\n\n'
                    f'Tool result:\n```\n{result_snip}\n```\n\n'
                    'Continue the task with this result.'
                )
        cancel_event = asyncio.Event()
        _cancelled[session_id] = cancel_event
        seq = event_log.event_log.append(
            session_id,
            'started',
            {
                'sinceSeq': 0,
                'reason': 'mutation_rejected' if reject else 'mutation_accepted_executed',
            },
        )
        provider = str(getattr(session, 'provider', '') or '') if session else ''
        agent_id = str(getattr(session, 'agentId', '') or '') if session else ''
        model = str(getattr(session, 'model', '') or '') if session else ''
        guard = str(getattr(session, 'guardMode', '') or '') if session else ''

        def _emit_continue_event(event: dict[str, object]) -> None:
            event_log.event_log.append(session_id, as_str(event.get('type'), 'message'), event)

        async def _continue_after_decision() -> None:
            try:
                await wb.sendWorkbenchMessageStream(
                    sessionId=session_id,
                    message=msg,
                    provider=provider,
                    agentId=agent_id,
                    model=model,
                    guardMode=guard,
                    emit=_emit_continue_event,
                    signal=cancel_event,
                )
            except Exception:
                try:
                    event_log.event_log.append(
                        session_id,
                        'error',
                        {
                            'type': 'error',
                            'message': 'Failed to continue after mutation decision',
                        },
                    )
                    event_log.event_log.append(
                        session_id, 'done', {'type': 'done', 'sessionId': session_id}
                    )
                except Exception:
                    pass
            finally:
                _cancelled.pop(session_id, None)
                if _activeStreams.get(session_id) is cont_task:
                    _activeStreams.pop(session_id, None)

        cont_task = asyncio.create_task(_continue_after_decision())
        _activeStreams[session_id] = cont_task
        _chatTasks.add(cont_task)
        cont_task.add_done_callback(_chatTasks.discard)
        result['continued'] = True
        result['sinceSeq'] = seq

    return result


@router.post('/confirm-mutation')
async def confirmMutationAlias(request: Request):
    """Alias for POST /mutations/respond (legacy frontend path)."""
    return await respondMutation(request)


@router.get('/sessions/{sessionId}/checkpoints')
async def listCheckpoints(sessionId: str):
    """List filesystem save points for a session."""
    from app.services.workbench.checkpoint_service import list_checkpoints

    return {'checkpoints': list_checkpoints(sessionId)}


@router.post('/sessions/{sessionId}/checkpoints/{checkpointId}/restore')
async def restoreCheckpointRoute(sessionId: str, checkpointId: str):
    """Restore files from a save point."""
    from app.services.workbench.checkpoint_service import restore_checkpoint

    result = restore_checkpoint(sessionId, checkpointId)
    if not result.get('ok'):
        raise HTTPException(status_code=404, detail=str(result.get('error') or 'Restore failed'))
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, action='checkpoint_restored')
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return result


@router.get('/sessions/{sessionId}/agents')
async def listSessionAgents(sessionId: str):
    """Active/recent sub-agents for the team strip."""
    try:
        from app.services.runtime_services import get_orchestrator

        orch = get_orchestrator()
        agents = orch.listActive(sessionId) if orch else []
    except Exception:
        agents = []
    session = wb.getWorkbenchSession(sessionId)
    meta = {}
    if session and isinstance(session.metadata, dict):
        meta = {
            'isolateSubagents': bool(session.metadata.get('isolateSubagents')),
            'lastCheckpointId': session.metadata.get('lastCheckpointId'),
            'lastCheckpointLabel': session.metadata.get('lastCheckpointLabel'),
        }
    return {'agents': agents, 'meta': meta}


@router.post('/sessions/{sessionId}/agents/cancel-all')
async def cancelAllSessionAgents(sessionId: str):
    """Cancel every active/pending sub-agent for this session."""
    from app.services.runtime_services import get_orchestrator

    orch = get_orchestrator()
    agents = orch.listActive(sessionId) if orch else []
    cancelled: list[str] = []
    if not orch:
        return {'ok': True, 'cancelled': cancelled, 'count': 0}
    for a in agents:
        if not isinstance(a, dict):
            continue
        task_id = str(a.get('taskId') or a.get('id') or '')
        if not task_id:
            continue
        try:
            ok = await orch.terminate(task_id)
            if ok:
                cancelled.append(task_id)
        except Exception:
            pass
    return {'ok': True, 'cancelled': cancelled, 'count': len(cancelled)}


@router.post('/sessions/{sessionId}/isolate-subagents')
async def setIsolateSubagents(sessionId: str, request: Request):
    """Toggle git worktree isolation for sub-agents on this session."""
    body: dict = {}
    try:
        raw = await request.json()
        if isinstance(raw, dict):
            body = raw
    except Exception:
        body = {}
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    enabled = bool(body.get('enabled', True))
    meta = dict(session.metadata) if isinstance(session.metadata, dict) else {}
    meta['isolateSubagents'] = enabled
    # Explicit user preference so spawn logic can distinguish opt-out vs unset
    meta['isolateSubagentsExplicit'] = True
    session.metadata = meta
    from app.services.workbench.sessions import save_sessions

    save_sessions()
    return {'ok': True, 'isolateSubagents': enabled}


@router.get('/tool-grants')
async def list_tool_grants():
    """Path-scoped always-grants for Settings (list / explain)."""
    return wb.list_always_grants()


@router.delete('/tool-grants')
async def revoke_tool_grant(request: Request):
    """Revoke one always-grant. Body: { workspacePath, key }."""
    body = await request.json()
    workspace_path = str(body.get('workspacePath') or body.get('workspace_path') or '')
    key = str(body.get('key') or '')
    result = wb.revoke_always_grant(workspace_path, key)
    if not result.get('ok'):
        raise HTTPException(status_code=404, detail=str(result.get('error') or 'Not found'))
    return result


@router.get('/approval-policy')
async def get_approval_policy():
    """T5 approval axis (axis 2) config — durable allow/deny prefix rules,
    per-category auto-approve, and the never-ask stance. Inert until enabled;
    the real sandbox (axis 1) stays ground truth either way."""
    return wb.get_approval_policy_config()


@router.put('/approval-policy')
async def set_approval_policy(request: Request):
    """Validate + persist the T5 approval policy. Body: the policy dict."""
    body = await request.json()
    result = wb.set_approval_policy_config(body if isinstance(body, dict) else {})
    if not result.get('ok'):
        raise HTTPException(status_code=500, detail=str(result.get('error') or 'Save failed'))
    return result


@router.post('/code-bridge')
async def code_bridge_call(request: Request):
    """T13 tool bridge: a code-mode child process calls back with a one-shot
    token to run a managed tool. The token maps to exactly one session; the
    call goes through the same guard/approval gates as the typed loop, so
    code mode cannot bypass the permission axes. Body: {token, tool, args}."""
    from app.services.workbench import kernel as kernel_mod

    body = await request.json()
    token = str(body.get('token') or '')
    tool_name = str(body.get('tool') or '')
    args = body.get('args')
    if not isinstance(args, dict):
        args = {}
    session_id = kernel_mod.resolve_bridge_token(token)
    if not session_id:
        raise HTTPException(status_code=401, detail='invalid or expired code-bridge token')
    session = wb.getWorkbenchSession(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail='session not found for code-bridge token')
    result = await kernel_mod.bridge_call(session, tool_name, dict(args))
    return {'result': result}


# ── Restricted Python cell sandbox ──────────────────────────────────────
# Code-level policy shared by the caller-side fast check and the subprocess
# runner (single source of truth; the runner embeds these via placeholder
# substitution so the two cannot drift).

_SANDBOX_BANNED_MODULES = frozenset({
    'socket', 'http', 'urllib', 'requests', 'httpx', 'subprocess',
    'multiprocessing', 'ctypes', 'importlib', 'pty', 'fcntl',
})

_SANDBOX_BUILTIN_NAMES = frozenset({
    'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'float', 'int', 'len',
    'list', 'max', 'min', 'print', 'range', 'repr', 'reversed', 'round', 'set',
    'sorted', 'str', 'sum', 'tuple', 'zip', 'True', 'False', 'None',
})

# The runner executes in a fresh interpreter process; it reads the cell from
# stdin, applies the same AST policy, runs with restricted builtins, and
# prints a single JSON result to stdout. A runaway loop is hard-killed by
# subprocess.run's timeout — it can never block the server's event loop.
_SANDBOX_RUNNER_TEMPLATE = r'''
import ast, io, json, sys, traceback
from contextlib import redirect_stderr, redirect_stdout

banned = __BANNED__
code = sys.stdin.read()
try:
    tree = ast.parse(code, mode='exec')
except SyntaxError as exc:
    print(json.dumps({'ok': False, 'error': f'SyntaxError: {exc}', 'stdout': '', 'stderr': ''}))
    sys.exit(0)
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            root = (alias.name or '').split('.')[0]
            if root in banned:
                print(json.dumps({'ok': False, 'error': f'Import blocked by sandbox policy: {root}', 'stdout': '', 'stderr': ''}))
                sys.exit(0)
    if isinstance(node, ast.ImportFrom):
        root = (node.module or '').split('.')[0]
        if root in banned:
            print(json.dumps({'ok': False, 'error': f'Import blocked by sandbox policy: {root}', 'stdout': '', 'stderr': ''}))
            sys.exit(0)

names = __BUILTINS__
safe_builtins = {}
for n in names:
    try:
        safe_builtins[n] = getattr(__builtins__, n)
    except (AttributeError, TypeError):
        safe_builtins[n] = __builtins__[n]
import json as _json, math, re as _re
globals_dict = {'__builtins__': safe_builtins, 'math': math, 'json': _json, 're': _re}
stdout_buf = io.StringIO()
stderr_buf = io.StringIO()
ok, err = True, None
try:
    with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
        exec(compile(tree, '<sandbox>', 'exec'), globals_dict, {})
except Exception as exc:
    ok, err = False, f'{type(exc).__name__}: {exc}'
    stderr_buf.write(traceback.format_exc()[-2000:])
print(json.dumps({'ok': ok, 'stdout': stdout_buf.getvalue()[:50000], 'stderr': stderr_buf.getvalue()[:10000], 'error': err}))
'''


def _sandbox_ast_check(code: str) -> str:
    """Static AST policy check. Returns an error message or '' when clean."""
    import ast

    try:
        tree = ast.parse(code, mode='exec')
    except SyntaxError as exc:
        return f'SyntaxError: {exc}'
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = (alias.name or '').split('.')[0]
                if root in _SANDBOX_BANNED_MODULES:
                    return f'Import blocked by sandbox policy: {root}'
        if isinstance(node, ast.ImportFrom):
            root = (node.module or '').split('.')[0]
            if root in _SANDBOX_BANNED_MODULES:
                return f'Import blocked by sandbox policy: {root}'
    return ''


def _run_sandbox_subprocess(code: str, cwd_path, timeout_ms: int) -> dict:
    """Run one cell in a fresh interpreter with a HARD timeout.

    subprocess.run kills the child when the timeout expires (infinite loops
    included), so a runaway cell can never stall the server. The server's own
    cwd is never mutated — the cell just inherits `cwd` in the child.
    """
    import os
    import subprocess
    import sys
    import tempfile

    runner_src = (
        _SANDBOX_RUNNER_TEMPLATE.replace('__BANNED__', repr(sorted(_SANDBOX_BANNED_MODULES)))
        .replace('__BUILTINS__', repr(sorted(_SANDBOX_BUILTIN_NAMES)))
    )
    fd, runner_path = tempfile.mkstemp(suffix='.py', prefix='august_sandbox_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(runner_src)
        proc = subprocess.run(
            [sys.executable, runner_path],
            input=code,
            capture_output=True,
            text=True,
            cwd=str(cwd_path) if cwd_path else None,
            timeout=(timeout_ms / 1000.0) + 0.5,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except subprocess.TimeoutExpired as exc:
        return {
            'ok': False,
            'error': f'Exceeded timeout ({timeout_ms}ms)',
            'stdout': (exc.stdout or '')[:50000],
            'stderr': (exc.stderr or '')[:10000],
        }
    except OSError as exc:
        return {
            'ok': False,
            'error': f'Could not start sandbox interpreter: {exc}',
            'stdout': '',
            'stderr': '',
        }
    finally:
        try:
            os.unlink(runner_path)
        except OSError:
            pass
    if proc.returncode != 0:
        return {
            'ok': False,
            'error': f'Sandbox interpreter exited with code {proc.returncode}',
            'stdout': (proc.stdout or '')[:50000],
            'stderr': (proc.stderr or '')[:10000],
        }
    try:
        import json as _json

        return _json.loads(proc.stdout or '{}')
    except Exception:
        return {
            'ok': False,
            'error': 'Sandbox returned an unparseable result',
            'stdout': (proc.stdout or '')[:50000],
            'stderr': (proc.stderr or '')[:10000],
        }


@router.post('/sandbox/python')
async def sandbox_python(request: Request):
    """Restricted Python cell: no network, limited builtins, HARD timeout, cwd bound.

    The cell runs in a separate interpreter process (never the event loop),
    so infinite loops are hard-killed at ``timeoutMs`` and the server's own
    working directory is never mutated. Body: { code, cwd?, timeoutMs? }
    """
    from pathlib import Path

    body = await request.json()
    code = str(body.get('code') or '')
    if not code.strip():
        raise HTTPException(status_code=400, detail='code is required')
    if len(code) > 20_000:
        raise HTTPException(status_code=400, detail='code too large (max 20k chars)')

    cwd_raw = str(body.get('cwd') or '').strip()
    timeout_ms = int(body.get('timeoutMs') or body.get('timeout_ms') or 3000)
    timeout_ms = max(200, min(timeout_ms, 10_000))

    # Bind cwd to workspace-ish paths only
    cwd_path = None
    if cwd_raw:
        cwd_path = Path(cwd_raw).resolve()
        if not cwd_path.is_dir():
            raise HTTPException(status_code=400, detail='cwd is not a directory')

    # Fast-fail AST policy check on the calling side (the subprocess runner
    # re-checks authoritatively before exec).
    ban_error = _sandbox_ast_check(code)
    if ban_error:
        return {'ok': False, 'error': ban_error, 'stdout': '', 'stderr': ''}

    import asyncio

    result = await asyncio.to_thread(_run_sandbox_subprocess, code, cwd_path, timeout_ms)
    result.setdefault('elapsedMs', None)
    result['cwd'] = str(cwd_path) if cwd_path else None
    result['policy'] = {
        'network': False,
        'subprocess': False,
        'timeoutMs': timeout_ms,
        'bannedImports': sorted(_SANDBOX_BANNED_MODULES),
    }
    return result


@router.get('/skills/hub')
async def skills_hub():
    """Catalog of installable skill recipes (browse / install surface)."""
    return {
        'entries': [
            {
                'id': 'hub-tdd',
                'name': 'test-driven-development',
                'title': 'Test-Driven Development',
                'description': 'Red-green-refactor loop for safe code changes.',
                'category': 'development',
                'source': 'bundled',
                'packagePath': 'skills/test-driven-development',
            },
            {
                'id': 'hub-debug',
                'name': 'systematic-debugging',
                'title': 'Systematic Debugging',
                'description': 'Root-cause analysis before applying fixes.',
                'category': 'development',
                'source': 'bundled',
                'packagePath': 'skills/systematic-debugging',
            },
            {
                'id': 'hub-plan',
                'name': 'writing-plans',
                'title': 'Writing Plans',
                'description': 'Turn goals into step-by-step implementation plans.',
                'category': 'research',
                'source': 'bundled',
                'packagePath': 'skills/writing-plans',
            },
            {
                'id': 'hub-review',
                'name': 'requesting-code-review',
                'title': 'Requesting Code Review',
                'description': 'Structure a clear review request for PRs.',
                'category': 'development',
                'source': 'bundled',
                'packagePath': 'skills/requesting-code-review',
            },
            {
                'id': 'hub-worktree',
                'name': 'using-git-worktrees',
                'title': 'Git Worktrees',
                'description': 'Isolate parallel work in git worktrees.',
                'category': 'devops',
                'source': 'bundled',
                'packagePath': 'skills/using-git-worktrees',
            },
        ]
    }


@router.get('/doctor')
async def workbenchDoctor():
    """Setup / health doctor for the first-run checklist and Settings.

    Checks: backend alive, workspace disk, MCP registry, Google OAuth config.
    """
    import os
    import shutil
    from pathlib import Path

    checks: list[dict[str, object]] = []
    ok_count = 0

    # 1) Backend (if this runs, we're up)
    checks.append(
        {
            'id': 'backend',
            'label': 'Backend API',
            'ok': True,
            'detail': 'Responding',
        }
    )
    ok_count += 1

    # 2) Disk free on data / cwd
    try:
        data_root = Path(os.environ.get('AUGUST_DATA_DIR', 'data')).resolve()
        if not data_root.exists():
            data_root = Path.cwd()
        usage = shutil.disk_usage(str(data_root))
        free_gb = usage.free / (1024**3)
        disk_ok = free_gb >= 0.5
        checks.append(
            {
                'id': 'disk',
                'label': 'Disk space',
                'ok': disk_ok,
                'detail': f'{free_gb:.1f} GB free under {data_root}',
            }
        )
        if disk_ok:
            ok_count += 1
    except Exception as exc:
        checks.append(
            {
                'id': 'disk',
                'label': 'Disk space',
                'ok': False,
                'detail': f'Could not check disk: {exc}',
            }
        )

    # 3) MCP servers registered / reachable
    try:
        from app.services.tools import mcp_client

        servers = mcp_client.listRegisteredServers()
        n = len(servers) if isinstance(servers, list) else 0
        alive = 0
        if isinstance(servers, list):
            for s in servers:
                if not isinstance(s, dict):
                    continue
                status = str(s.get('status') or s.get('state') or '').lower()
                if status in ('running', 'connected', 'ok', 'ready') or s.get('connected') or s.get('running'):
                    alive += 1
        mcp_ok = n == 0 or alive > 0 or n > 0  # registered counts as healthy-enough for checklist
        checks.append(
            {
                'id': 'mcp',
                'label': 'MCP servers',
                'ok': True if n == 0 else mcp_ok,
                'detail': (
                    'No MCP servers registered (optional)'
                    if n == 0
                    else f'{alive}/{n} running · {n} registered'
                ),
                'optional': True,
            }
        )
        ok_count += 1
    except Exception as exc:
        checks.append(
            {
                'id': 'mcp',
                'label': 'MCP servers',
                'ok': False,
                'detail': f'MCP registry error: {exc}',
                'optional': True,
            }
        )

    # 4) Google OAuth redirect / client id configuration
    try:
        client_id = (
            os.environ.get('AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID')
            or os.environ.get('GOOGLE_OAUTH_CLIENT_ID')
            or ''
        ).strip()
        redirect = (os.environ.get('GOOGLE_OAUTH_REDIRECT_URI') or '').strip()
        # Desktop PKCE often uses loopback; config may also live in service connections
        has_id = bool(client_id)
        try:
            from app.services import service_connections as sc

            conns = sc.get_connections() if hasattr(sc, 'get_connections') else {}
            g = (conns or {}).get('google') if isinstance(conns, dict) else None
            if isinstance(g, dict) and (g.get('hasClientId') or g.get('clientId') or g.get('connected')):
                has_id = True
        except Exception:
            pass
        detail_parts = []
        if has_id:
            detail_parts.append('Client ID configured')
        else:
            detail_parts.append('No Client ID (BYO or AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID)')
        if redirect:
            detail_parts.append(f'redirect {redirect}')
        else:
            detail_parts.append('native callback / PKCE ready')
        checks.append(
            {
                'id': 'oauth',
                'label': 'Google OAuth',
                'ok': has_id,
                'detail': ' · '.join(detail_parts),
                'optional': True,
            }
        )
        if has_id:
            ok_count += 1
    except Exception as exc:
        checks.append(
            {
                'id': 'oauth',
                'label': 'Google OAuth',
                'ok': False,
                'detail': str(exc),
                'optional': True,
            }
        )

    # 5) Agent sandbox backend capability (Codex-like)
    try:
        from app.services.sandbox import DEFAULT_SANDBOX_MODE, active_backend

        backend = active_backend()
        detail_map = {
            'windows-appcontainer': 'Windows AppContainer isolation',
            'seatbelt': 'macOS Seatbelt (sandbox-exec)',
            'landlock': 'Linux Landlock',
            'bwrap': 'Linux bubblewrap',
            'soft': 'Soft policy (cwd + network/path guards) — not OS isolation',
        }
        checks.append(
            {
                'id': 'sandbox',
                'label': 'Agent sandbox',
                'ok': True,
                'detail': f'{detail_map.get(backend, backend)} · default {DEFAULT_SANDBOX_MODE}',
                'backend': backend,
                'optional': True,
            }
        )
        ok_count += 1
    except Exception as exc:
        checks.append(
            {
                'id': 'sandbox',
                'label': 'Agent sandbox',
                'ok': False,
                'detail': str(exc),
                'optional': True,
            }
        )

    required = [c for c in checks if not c.get('optional')]
    all_required_ok = all(bool(c.get('ok')) for c in required)
    return {
        'ok': all_required_ok,
        'checks': checks,
        'summary': f'{ok_count}/{len(checks)} checks healthy',
    }


@router.post('/sessions/{sessionId}/worktree')
async def createSessionWorktree(sessionId: str):
    """Create an isolated git worktree for this session (manual / demo)."""
    from app.services.workbench.worktree_service import create_agent_worktree

    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    ws = session.workspacePath or ''
    result = create_agent_worktree(ws, session_id=sessionId, agent_label='session')
    if result.get('ok') and result.get('path'):
        meta = dict(session.metadata) if isinstance(session.metadata, dict) else {}
        meta['activeWorktree'] = result['path']
        meta['isolateSubagents'] = True
        session.metadata = meta
        from app.services.workbench.sessions import save_sessions

        save_sessions()
    return result


@router.post('/sessions/{sessionId}/undo-last-turn')
async def undoLastTurn(sessionId: str):
    """Remove the last user turn and all following messages from the session."""
    from app.services.workbench.sessions import undo_last_turn

    result = undo_last_turn(sessionId)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.post('/sessions/{sessionId}/truncate')
async def truncateSession(sessionId: str, request: Request):
    """Truncate the session in place up to (and including) ``upToIndex``.

    Body: ``{ "upToIndex": int }`` — the message index to keep up to
    (inclusive); everything after is removed. Used by the chat UI's
    revert/edit/regenerate actions so backend history matches the thread.
    """
    from app.services.workbench.sessions import truncate_session

    body: dict = {}
    try:
        if request.headers.get('content-type', '').startswith('application/json'):
            raw = await request.json()
            if isinstance(raw, dict):
                body = raw
    except Exception:
        body = {}
    up_to = body.get('upToIndex')
    if up_to is None or up_to == '':
        raise HTTPException(status_code=400, detail='upToIndex is required')
    try:
        up_to_index = int(up_to)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail='upToIndex must be an integer') from exc
    result = truncate_session(sessionId, up_to_index=up_to_index)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.post('/sessions/{sessionId}/branch')
async def branchSession(sessionId: str, request: Request):
    """Fork a session into a new branch (optional upToIndex of source messages)."""
    from app.services.workbench.sessions import branch_workbench_session

    body: dict = {}
    try:
        if request.headers.get('content-type', '').startswith('application/json'):
            raw = await request.json()
            if isinstance(raw, dict):
                body = raw
    except Exception:
        body = {}
    up_to = body.get('upToIndex', body.get('up_to_index'))
    up_to_index: int | None
    if up_to is None or up_to == '':
        up_to_index = None
    else:
        try:
            up_to_index = int(up_to)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail='upToIndex must be an integer') from exc
    session = branch_workbench_session(sessionId, up_to_index=up_to_index)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()


@router.post('/sessions/{sessionId}/compact')
async def compactSession(sessionId: str):
    """Force context compression (\"Free up chat memory\")."""
    from app.services.workbench.sessions import compact_workbench_session_now

    result = await compact_workbench_session_now(sessionId)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.get('/sessions/{sessionId}/transcript')
async def sessionTranscript(sessionId: str):
    """Archived transcript (source of truth) with live projection fallback."""
    from app.services.transcript_archive import derive_messages
    from app.services.workbench.sessions import get_workbench_session

    session = get_workbench_session(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return {'sessionId': sessionId, 'messages': derive_messages(sessionId, list(session.messages or []))}


@router.post('/sessions/{sessionId}/handoff')
async def createSessionHandoff(sessionId: str, request: Request):
    """Summarize context for a model switch and persist it on the session.

    Body: ``{ from_model, to_model }`` (camelCase ``fromModel``/``toModel``
    also accepted). Summarizes messages since the last handoff cursor (or a
    recent tail window if there's no cursor yet), persists the record on the
    session's metadata, and returns it. The next ``POST /chat`` for this
    session will consume the persisted record automatically if the request
    doesn't already carry a client-computed ``handoffSummary``.

    Always returns 200 with a summary (truncated fallback on internal
    failure) as long as the session exists — this is a best-effort context
    aid, not a hard dependency for chat to proceed.
    """
    body: dict = {}
    try:
        if request.headers.get('content-type', '').startswith('application/json'):
            raw = await request.json()
            if isinstance(raw, dict):
                body = raw
    except Exception:
        body = {}
    from_model = as_str(body.get('from_model') or body.get('fromModel') or '')
    to_model = as_str(body.get('to_model') or body.get('toModel') or '')

    from app.services.workbench.sessions import create_workbench_handoff

    try:
        record = create_workbench_handoff(sessionId, from_model=from_model, to_model=to_model)
    except Exception:
        record = None
        session_exists = wb.getWorkbenchSession(sessionId) is not None
        if not session_exists:
            raise HTTPException(status_code=404, detail='Session not found')
        record = {
            'fromModel': from_model,
            'toModel': to_model,
            'summary': 'Context summary unavailable; continuing from prior messages as-is.',
            'createdAt': wb._now(),
            'sourceMessageRange': [0, 0],
        }
    if record is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return record


def restoreAgentAfterPlan(session: object) -> None:
    """Restore the agent role stashed when the session entered plan mode.

    Leaving plan mode must not permanently clobber a user-selected agent
    role. When no role was stashed, falls back to the default 'build'
    mapping the guard-mode selector expects.
    """
    meta = dict(getattr(session, 'metadata', None) or {})
    stashed = as_str(meta.pop('planAgentId', '') or '')
    if stashed and as_str(getattr(session, 'agentId', '') or '') == 'plan':
        session.agentId = stashed  # type: ignore[attr-defined]
    else:
        session.agentId = 'build'  # type: ignore[attr-defined]
    session.metadata = meta  # type: ignore[attr-defined]


@router.post('/guard-mode')
async def setGuardMode(request: Request):
    """Update guard mode on a workbench session (system barrier).

    Also maps agentId (plan vs build) and clears a pending plan when entering
    Full Access so the chat is not stuck on plan approval.
    """
    from datetime import datetime, timezone

    from app.services.workbench.sessions import save_sessions

    body = await request.json()
    sessionId = body.get('sessionId', '')
    guardMode = body.get('guardMode', 'full')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    mode = wb.normalizeGuardMode(str(guardMode or 'full'))
    session.guardMode = mode
    # Keep agent role aligned with the barrier the UI selected — but never
    # clobber a user-selected agent permanently: entering plan mode stashes
    # the previous role; leaving plan mode restores it when one was stashed.
    if mode == 'plan':
        meta = dict(session.metadata or {})
        prev_agent = as_str(getattr(session, 'agentId', '') or '')
        if prev_agent and prev_agent != 'plan':
            meta['planAgentId'] = prev_agent
        session.metadata = meta
        session.agentId = 'plan'
    else:
        restoreAgentAfterPlan(session)
    if mode == 'full':
        # Drop pending plan gate — Full Access must not present a plan.
        session.plan = None
        session.planApproved = False
        if hasattr(session, 'approved'):
            try:
                session.approved = False  # type: ignore[attr-defined]
            except Exception:
                pass
        # Drop ask/edit (and sandbox-escape) permission prompts — Full Access
        # must not replace the composer with the approval banner.
        session.pendingMutations = []
        if as_str(getattr(session, 'status', '') or '') == 'awaiting_approval':
            session.status = 'idle'
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    # Prompt cache is content-hash keyed — guardMode change alters the hash
    # automatically; no manual invalidation needed.
    save_sessions()
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime(
            'session.updated',
            sessionId=sessionId,
            guardMode=session.guardMode,
            agentId=session.agentId,
        )
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return session.toDict()


@router.post('/agent-mode')
async def setAgentModeApi(request: Request):
    """Persist harness agent_mode (chat / agent / code / orchestrator)."""
    from datetime import datetime, timezone

    from app.services.workbench.sessions import save_sessions

    body = await request.json()
    sessionId = body.get('sessionId', '')
    raw = as_str(body.get('agentMode') or body.get('agent_mode'), '').strip().lower()
    if raw == 'planner':
        raw = 'orchestrator'
    if raw not in ('chat', 'agent', 'code', 'orchestrator'):
        raise HTTPException(status_code=400, detail='agentMode must be chat, agent, code, or orchestrator')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    session.agent_mode = raw
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    save_sessions()
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, agentMode=raw)
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return session.toDict()


@router.post('/cost-ceiling')
async def setCostCeiling(request: Request):
    """Set a per-session spend ceiling (USD). 0 clears it.

    When the estimated cumulative session cost reaches the ceiling, new
    turns are blocked with a clear error until the user raises it or starts
    a new chat.
    """
    from datetime import datetime, timezone

    from app.services.workbench.sessions import save_sessions

    body = await request.json()
    sessionId = body.get('sessionId', '')
    ceiling = max(0.0, as_float(body.get('costCeiling', 0.0), 0.0))
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    session.costCeiling = ceiling
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    save_sessions()
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=sessionId, costCeiling=session.costCeiling)
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
    except Exception:
        pass
    return session.toDict()


async def _apply_sandbox_body(sessionId: str, body: dict) -> dict[str, object]:
    from datetime import datetime, timezone

    from app.services.sandbox import normalize_sandbox_mode
    from app.services.workbench.sessions import save_sessions

    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    if 'sandboxMode' in body and body.get('sandboxMode') is not None:
        session.sandboxMode = normalize_sandbox_mode(str(body.get('sandboxMode')))
    if 'sandboxNetwork' in body:
        session.sandboxNetwork = bool(body.get('sandboxNetwork'))
    if 'workspacePath' in body or 'workspace_path' in body:
        session.workspacePath = str(body.get('workspacePath') or body.get('workspace_path') or '')
    if session.sandboxMode == 'danger-full-access':
        session.sandboxNetwork = True
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    save_sessions()
    # The workspace path — and the VCS branch / AUG.md derived from it — is
    # baked into the cached Tier-1/Tier-2 system prompt (keyed by session id,
    # 5-min TTL; a cache hit skips rebuilding Tier 2 entirely). If the path
    # changed, drop that cache so the next turn's prompt names the new
    # directory. Without this, a session switch leaves the model "thinking" it
    # is still in the previous folder (stale `Path:` line, stale branch, stale
    # AUG.md) while the file/shell tools already execute in the new one — the
    # cross-session path leak seen when switching between folders.
    # Prompt cache is content-hash keyed — workspacePath change alters the
    # hash automatically; no manual invalidation needed.
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime
        from app.services.workbench.sessions import _emit_session_status

        emit_realtime(
            'session.updated',
            sessionId=sessionId,
            sandboxMode=session.sandboxMode,
            sandboxNetwork=session.sandboxNetwork,
        )
        emit_invalidate('workbench-session', 'session-status', session_id=sessionId)
        _emit_session_status(sessionId)
    except Exception:
        pass
    return session.toDict()


@router.post('/sandbox-mode')
async def setSandboxMode(request: Request):
    """Update Codex-like sandbox mode on a workbench session.

    Body: { sessionId, sandboxMode?, sandboxNetwork? }
    Modes: read-only | workspace-write | danger-full-access
    """
    body = await request.json()
    sessionId = str(body.get('sessionId') or '')
    return await _apply_sandbox_body(sessionId, body if isinstance(body, dict) else {})


@router.patch('/sessions/{sessionId}/sandbox')
async def patchSessionSandbox(sessionId: str, request: Request):
    """REST alias: PATCH sandbox fields on a session."""
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    return await _apply_sandbox_body(sessionId, body)


@router.post('/btw')
async def answerBtw(request: Request):
    """BTW side-channel: always the same model as chat for this session.

    Uses ``session.model`` and ``session.provider`` only (set by chat turns).
    Request body is just sessionId + question — no separate model or key.
    """
    import uuid

    body = await request.json()
    sessionId = body.get('sessionId', '')
    question = (body.get('question') or '').strip()
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    if not question:
        raise HTTPException(status_code=400, detail='question is required')

    from app.services.workbench.providers import (
        call_anthropic_workbench,
        call_openai_workbench,
        extract_text,
        is_anthropic_provider,
        is_openai_provider,
        resolve_chat_llm,
    )

    # Hardcoded to chat session LLM — ignore any model/provider overrides on the body.
    resolvedProvider, resolvedModel = resolve_chat_llm(
        model=session.model or '',
        model_provider=session.provider or '',
        session_provider=session.provider or '',
        session_model=session.model or '',
    )
    if not resolvedProvider or not resolvedModel:
        raise HTTPException(
            status_code=503,
            detail=(
                'No chat model on this session yet. Send a chat message (or pick a model '
                'in the composer and send once) so BTW can reuse that same LLM.'
            ),
        )

    system_text = (
        'You are answering a quick BTW (by-the-way) question about the '
        'current workbench session. Be concise. Do not call tools.'
    )
    msgs: list[dict[str, object]] = []
    for m in (session.messages or [])[-8:]:
        if isinstance(m, dict) and m.get('role') in ('user', 'assistant') and m.get('content'):
            msgs.append({'role': m['role'], 'content': str(m['content'])[:2000]})
    msgs.append({'role': 'user', 'content': question})

    answer = ''
    err = ''
    try:
        if is_anthropic_provider(resolvedProvider):
            result = await call_anthropic_workbench(
                messages=msgs,
                system_text=system_text,
                model=resolvedModel,
                tools=[],
                effort='low',
                provider=resolvedProvider,
            )
        elif is_openai_provider(resolvedProvider):
            result = await call_openai_workbench(
                messages=msgs,
                system_text=system_text,
                model=resolvedModel,
                tools=[],
                effort='low',
                provider=resolvedProvider,
            )
        else:
            raise HTTPException(
                status_code=503,
                detail=f"Chat provider format unsupported for BTW: {resolvedProvider.get('apiMode')}",
            )
        if isinstance(result, dict):
            if result.get('error'):
                err = str(result.get('error'))
            else:
                answer = str(result.get('text') or result.get('content') or '')
                if not answer and isinstance(result.get('content'), list):
                    answer = extract_text(
                        [b for b in as_list(result.get('content'), []) if isinstance(b, dict)]
                    )
    except HTTPException:
        raise
    except Exception as exc:
        err = str(exc)

    if not answer:
        raise HTTPException(
            status_code=503,
            detail=err or f'Chat model {resolvedModel} failed on BTW (same model as chat).',
        )

    pname = str(resolvedProvider.get('name') or resolvedProvider.get('id') or '')
    return {
        'id': f'btw_{uuid.uuid4().hex[:10]}',
        'answer': answer,
        'model': resolvedModel,
        'provider': pname,
        'citations': [],
        'confidence': 0.8,
    }

@router.post('/goal')
async def updateGoal(request: Request):
    """Set/clear/status for goals."""
    body = await request.json()
    sessionId = body.get('sessionId', '')
    action = body.get('action', 'status')
    condition = body.get('condition', '')
    result = wb.updateWorkbenchGoal(sessionId, action, condition)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.get('/activity')
async def workbenchActivity():
    """Return recent workbench activity."""
    return wb.getWorkbenchActivity()


@router.get('/capabilities')
async def proxyCapabilities():
    """List all tools grouped by source."""
    return wb.listProxyCapabilities()


@router.get('/agents')
async def workbenchAgents(active: str = ''):
    """List agents for the UI's Agents tab (frontend listWorkbenchAgents)."""
    from app.services.tools import agent_registry

    agents = agent_registry.listAgents()
    if active:
        pass
    return {'agents': agents, 'active': active}


@router.post('/sessions/{sessionId}/agent')
async def setSessionAgent(sessionId: str, request: Request):
    """Bind an agent to a session (or clear it with an empty agentId)."""
    body = await request.json() if request.headers.get('content-type') else {}
    agentId = body.get('agentId', '')
    session = wb.setWorkbenchSessionAgent(sessionId, agentId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()
