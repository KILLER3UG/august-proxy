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
    seq = event_log.event_log.append(sessionId, 'started', {'sinceSeq': 0})
    cancelEvent = asyncio.Event()
    _cancelled[sessionId] = cancelEvent

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

    task = asyncio.create_task(safeStream())
    _chatTasks.add(task)
    task.add_done_callback(_chatTasks.discard)
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
    return {'status': 'ok'}


@router.post('/plan/approve')
async def approvePlan(sessionId: str = Query('')):
    """Approve a pending plan."""
    if not wb.approveWorkbenchPlan(sessionId):
        raise HTTPException(status_code=404, detail='Session not found or no plan pending')
    return {'status': 'approved'}


@router.post('/plan/reject')
async def rejectPlan(sessionId: str = Query('')):
    """Reject a pending plan."""
    if not wb.rejectWorkbenchPlan(sessionId):
        raise HTTPException(status_code=404, detail='Session not found')
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
    return {'status': 'ok', 'todos': session.todos}


@router.post('/mutations/respond')
async def respondMutation(request: Request):
    """Respond to a pending mutation (approve/reject)."""
    body = await request.json()
    token = body.get('token', '')
    reject = body.get('reject', False)
    if not wb.consumePendingMutation(token, reject=reject):
        raise HTTPException(status_code=404, detail='Mutation token not found')
    return {'status': 'consumed'}


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
