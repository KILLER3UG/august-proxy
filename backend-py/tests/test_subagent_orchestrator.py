"""Tests for the sub-agent orchestrator."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import SubagentHandle, SubagentOrchestrator, SubagentSpawnRequest


@pytest.fixture
def bus():
    return AgentMessageBus()


@pytest.fixture
def orchestrator(bus):
    return SubagentOrchestrator(bus, max_workers=5)


@pytest.mark.asyncio
async def testSpawnReturnsHandles(orchestrator):
    """Spawning creates handles for each work item."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[{'goal': 'do thing 1', 'agentId': 'general'}, {'goal': 'do thing 2', 'agentId': 'coder'}],
        mode='auto',
    )
    handles = await orchestrator.spawn(request)
    assert len(handles) == 2
    assert handles[0].status == 'pending'
    assert handles[1].status == 'pending'
    assert handles[0].agentId == 'general'
    assert handles[1].agentId == 'coder'


@pytest.mark.asyncio
async def testListactive(orchestrator):
    """Active tasks appear in listActive."""
    session = MagicMock()
    request = SubagentSpawnRequest(session=session, workItems=[{'goal': 'test'}], mode='auto')
    handles = await orchestrator.spawn(request)
    active = orchestrator.listActive()
    assert len(active) >= 1
    assert active[0]['taskId'] == handles[0].taskId


@pytest.mark.asyncio
async def testTerminateCancelsTask(orchestrator):
    """Terminate cancels a running task."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session, workItems=[{'goal': 'long task', 'agentId': 'general'}], mode='auto'
    )
    handles = await orchestrator.spawn(request)
    taskId = handles[0].taskId
    await asyncio.sleep(0.05)
    result = await orchestrator.terminate(taskId)
    assert result is True
    await asyncio.sleep(0.05)
    handle = orchestrator.getHandle(taskId)
    assert handle is not None


@pytest.mark.asyncio
async def testOrchestratorEvents(bus):
    """Orchestrator-level event handlers fire on completion/failure."""
    events: list[str] = []
    orch = SubagentOrchestrator(bus, max_workers=5)

    async def onComplete(data):
        events.append(('completed', data.get('status')))

    async def onFail(data):
        events.append(('failed', data.get('status')))

    orch.on('subagentCompleted', onComplete)
    orch.on('subagentFailed', onFail)
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session, workItems=[{'goal': 'quick test', 'agentId': 'general'}], mode='auto'
    )
    with patch('app.services.subagent_worker.runSubagent', new_callable=AsyncMock) as mockRun:
        mockRun.return_value = {'status': 'completed', 'result': 'done', 'error': ''}
        await orch.spawn(request)
        await asyncio.sleep(0.2)
    completedEvents = [e for e in events if e[0] == 'completed']
    assert len(completedEvents) > 0


@pytest.mark.asyncio
async def testCloseCancelsAll(orchestrator):
    """Close cancels all running tasks."""
    session = MagicMock()
    request = SubagentSpawnRequest(session=session, workItems=[{'goal': 'task 1'}, {'goal': 'task 2'}], mode='auto')
    await orchestrator.spawn(request)
    await orchestrator.close()
    active = orchestrator.listActive()
    assert len(active) == 0
