"""
Workbench chat routes — POST to start, GET SSE stream.

Port of the Express routes from the JS backend. Uses the workbench
service for session management and chat loop.
"""

from __future__ import annotations
import asyncio
import json
import uuid
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.services import event_log
from app.services.workbench import workbench as wb

router = APIRouter(prefix='/api/workbench')
_chatTasks: set[asyncio.Task] = set()
_cancelled: dict[str, asyncio.Event] = {}
# One in-flight stream per session (gateway parity). Extra POSTs enqueue.
_activeStreams: dict[str, asyncio.Task] = {}


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


@router.get('/sessions/{session_id}')
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


@router.delete('/sessions/{session_id}')
async def deleteSession(sessionId: str):
    """Delete a session."""
    if not wb.deleteWorkbenchSession(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
    return {'status': 'ok'}


@router.patch('/sessions/{session_id}/title')
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


@router.post('/sessions/{session_id}/reset')
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
        entry = wb.enqueueUserMessage(sessionId, message) if message else None
        return {
            'status': 'queued',
            'sessionId': sessionId,
            'queuedMessageId': (entry or {}).get('id') if entry else None,
            'message': 'A turn is already in progress; message queued for the next iteration boundary.',
        }
    if existing and existing.done():
        _activeStreams.pop(sessionId, None)

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
                emit=lambda event: event_log.event_log.append(sessionId, event.get('type', 'message'), event),
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
    """Abort a running generation."""
    body = await request.json()
    sessionId = body.get('sessionId', '')
    cancelEvent = _cancelled.get(sessionId)
    if cancelEvent and (not cancelEvent.is_set()):
        cancelEvent.set()
    event_log.event_log.append(sessionId, 'aborted', {})
    return {'status': 'ok'}


@router.get('/chat/active')
async def activeChats():
    """List active status for all sessions."""
    activity = wb.getWorkbenchActivity()
    return activity


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
async def dequeueMessage(messageId: str, sessionId: str = Query(default='', alias='sessionId')):
    """Remove a queued message by id before it's delivered to the model."""
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    removed = wb.dequeueUserMessage(sessionId=sessionId, messageId=messageId)
    if not removed:
        raise HTTPException(status_code=404, detail='Queued message not found')
    return {'status': 'ok', 'messageId': messageId}


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
async def updateQueueMessage(messageId: str, request: Request):
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
    entry = wb.updateQueuedMessage(sessionId, messageId, text=str(text))
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


@router.post('/plan/approve')
async def approvePlan(sessionId: str = Query('')):
    """Approve a pending plan."""
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
async def rejectPlan(sessionId: str = Query('')):
    """Reject a pending plan."""
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

    Body: { token, reject?, scope?: 'once'|'session'|'always', continue?: bool }

    On **accept**: records a grant, **executes the tool with the stored args**,
    then optionally starts a continuation turn that feeds the real tool result
    to the model (no blind retry).

    On **reject**: discards the pending change without running the tool.
    """
    body = await request.json()
    token = str(body.get('token') or '')
    reject = bool(body.get('reject', False))
    scope = str(body.get('scope') or 'once')
    do_continue = body.get('continue', True) is not False
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
            msg = (
                f'The user **rejected** the pending tool `{tool_name}`. '
                'Do not run that change. Acknowledge briefly and ask how they want to proceed.'
            )
        else:
            result_snip = (exec_result or as_str(result.get('toolResult'), ''))[:6000]
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


@router.get('/sessions/{session_id}/checkpoints')
async def listCheckpoints(sessionId: str):
    """List filesystem save points for a session."""
    from app.services.workbench.checkpoint_service import list_checkpoints

    return {'checkpoints': list_checkpoints(sessionId)}


@router.post('/sessions/{session_id}/checkpoints/{checkpoint_id}/restore')
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


@router.get('/sessions/{session_id}/agents')
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


@router.post('/sessions/{session_id}/agents/cancel-all')
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


@router.post('/sessions/{session_id}/isolate-subagents')
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


@router.post('/sandbox/python')
async def sandbox_python(request: Request):
    """Restricted Python cell: no network, limited builtins, timeout, cwd bound.

    Body: { code: string, cwd?: string, timeoutMs?: number }
    """
    import ast
    import io
    import traceback
    from contextlib import redirect_stdout, redirect_stderr
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
    if cwd_raw:
        cwd_path = Path(cwd_raw).resolve()
        if not cwd_path.is_dir():
            raise HTTPException(status_code=400, detail='cwd is not a directory')
    else:
        cwd_path = Path.cwd()

    # Block obvious network / process escape imports via AST
    banned = {
        'socket',
        'http',
        'urllib',
        'requests',
        'httpx',
        'subprocess',
        'multiprocessing',
        'ctypes',
        'importlib',
        'pty',
        'fcntl',
    }
    try:
        tree = ast.parse(code, mode='exec')
    except SyntaxError as exc:
        return {
            'ok': False,
            'error': f'SyntaxError: {exc}',
            'stdout': '',
            'stderr': '',
        }
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = (alias.name or '').split('.')[0]
                if root in banned:
                    return {
                        'ok': False,
                        'error': f'Import blocked by sandbox policy: {root}',
                        'stdout': '',
                        'stderr': '',
                    }
        if isinstance(node, ast.ImportFrom):
            root = (node.module or '').split('.')[0]
            if root in banned:
                return {
                    'ok': False,
                    'error': f'Import blocked by sandbox policy: {root}',
                    'stdout': '',
                    'stderr': '',
                }

    safe_builtins = {
        'abs': abs,
        'all': all,
        'any': any,
        'bool': bool,
        'dict': dict,
        'enumerate': enumerate,
        'float': float,
        'int': int,
        'len': len,
        'list': list,
        'max': max,
        'min': min,
        'print': print,
        'range': range,
        'repr': repr,
        'reversed': reversed,
        'round': round,
        'set': set,
        'sorted': sorted,
        'str': str,
        'sum': sum,
        'tuple': tuple,
        'zip': zip,
        'True': True,
        'False': False,
        'None': None,
    }
    # Allow a tiny stdlib subset
    import math
    import json as _json
    import re as _re

    globals_dict: dict = {
        '__builtins__': safe_builtins,
        'math': math,
        'json': _json,
        're': _re,
    }
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    ok = True
    err_msg = ''
    import os
    import time as _time

    old_cwd = os.getcwd()
    started = _time.monotonic()
    try:
        os.chdir(str(cwd_path))
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            # Cooperative timeout via bytecode size / wall clock check is limited;
            # we rely on short timeout_ms budget and no network/process.
            exec(compile(tree, '<sandbox>', 'exec'), globals_dict, {})  # noqa: S102
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            if elapsed_ms > timeout_ms:
                ok = False
                err_msg = f'Exceeded timeout ({timeout_ms}ms)'
    except Exception as exc:
        ok = False
        err_msg = f'{type(exc).__name__}: {exc}'
        stderr_buf.write(traceback.format_exc()[-2000:])
    finally:
        try:
            os.chdir(old_cwd)
        except Exception:
            pass

    return {
        'ok': ok,
        'stdout': stdout_buf.getvalue()[:50_000],
        'stderr': stderr_buf.getvalue()[:10_000],
        'error': err_msg or None,
        'cwd': str(cwd_path),
        'elapsedMs': int((_time.monotonic() - started) * 1000),
        'policy': {
            'network': False,
            'subprocess': False,
            'timeoutMs': timeout_ms,
            'bannedImports': sorted(banned),
        },
    }


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
        from app.services.sandbox import active_backend, DEFAULT_SANDBOX_MODE

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


@router.post('/sessions/{session_id}/worktree')
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


@router.post('/sessions/{session_id}/undo-last-turn')
async def undoLastTurn(sessionId: str):
    """Remove the last user turn and all following messages from the session."""
    from app.services.workbench.sessions import undo_last_turn

    result = undo_last_turn(sessionId)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.post('/sessions/{session_id}/branch')
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


@router.post('/sessions/{session_id}/compact')
async def compactSession(sessionId: str):
    """Force context compression (\"Free up chat memory\")."""
    from app.services.workbench.sessions import compact_workbench_session_now

    result = compact_workbench_session_now(sessionId)
    if result is None:
        raise HTTPException(status_code=404, detail='Session not found')
    return result


@router.post('/guard-mode')
async def setGuardMode(request: Request):
    """Update guard mode on a workbench session (system barrier).

    Also maps agentId (plan vs build) and clears a pending plan when entering
    Full Access so the chat is not stuck on plan approval.
    """
    from datetime import datetime, timezone
    from app.services.workbench.sessions import save_sessions
    from app.services.workbench.prompt_cache import getCache

    body = await request.json()
    sessionId = body.get('sessionId', '')
    guardMode = body.get('guardMode', 'full')
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    mode = wb.normalizeGuardMode(str(guardMode or 'full'))
    session.guardMode = mode
    # Keep agent role aligned with the barrier the UI selected.
    if mode == 'plan':
        session.agentId = 'plan'
    else:
        session.agentId = 'build'
    if mode == 'full':
        # Drop pending plan gate — Full Access must not present a plan.
        session.plan = None
        session.planApproved = False
        if hasattr(session, 'approved'):
            try:
                session.approved = False  # type: ignore[attr-defined]
            except Exception:
                pass
    session.updatedAt = datetime.now(timezone.utc).isoformat()
    # Invalidate cached Tier1/Tier2 so guard-mode barrier text refreshes.
    try:
        getCache().invalidate(sessionId)
    except Exception:
        pass
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


@router.patch('/sessions/{session_id}/sandbox')
async def patchSessionSandbox(session_id: str, request: Request):
    """REST alias: PATCH sandbox fields on a session."""
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    return await _apply_sandbox_body(session_id, body)


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
        resolve_chat_llm,
        is_anthropic_provider,
        is_openai_provider,
        call_anthropic_workbench,
        call_openai_workbench,
        extract_text,
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


@router.post('/sessions/{session_id}/agent')
async def setSessionAgent(sessionId: str, request: Request):
    """Bind an agent to a session (or clear it with an empty agentId)."""
    body = await request.json() if request.headers.get('content-type') else {}
    agentId = body.get('agentId', '')
    session = wb.setWorkbenchSessionAgent(sessionId, agentId)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found')
    return session.toDict()
