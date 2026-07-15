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
        provider=body.get('provider', ''), agentId=body.get('agentId', ''), guardMode=body.get('guardMode', '')
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

    The message is stored on the session and surfaced to the model's
    chat loop at the next iteration boundary. If no turn is running,
    the next turn will pick the message up automatically.
    """
    body = await request.json()
    sessionId = body.get('sessionId', '')
    text = body.get('text', '')
    attachments = body.get('attachments') or []
    if not sessionId:
        raise HTTPException(status_code=400, detail='sessionId is required')
    if not text and (not attachments):
        raise HTTPException(status_code=400, detail='text or attachments required')
    entry = wb.enqueueUserMessage(sessionId=sessionId, text=text, attachments=attachments)
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
    """Respond to a pending mutation (approve/reject)."""
    body = await request.json()
    token = body.get('token', '')
    reject = body.get('reject', False)
    if not wb.consumePendingMutation(token, reject=reject):
        raise HTTPException(status_code=404, detail='Mutation token not found')
    try:
        from app.services.realtime_bus import emit_invalidate

        emit_invalidate('session-status', 'workbench-session')
    except Exception:
        pass
    return {'status': 'consumed'}


@router.post('/confirm-mutation')
async def confirmMutationAlias(request: Request):
    """Alias for POST /mutations/respond (legacy frontend path)."""
    return await respondMutation(request)


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
                        [b for b in result['content'] if isinstance(b, dict)]  # type: ignore[index]
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
