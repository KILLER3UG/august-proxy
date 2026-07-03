"""Tests for the sub-agent orchestrator."""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import (
    SubagentOrchestrator,
    SubagentSpawnRequest,
    SubagentHandle,
)


@pytest.fixture
def bus():
    return AgentMessageBus()


@pytest.fixture
def orchestrator(bus):
    return SubagentOrchestrator(bus, maxWorkers=5)


@pytest.mark.asyncio
async def test_spawn_returns_handles(orchestrator):
    """Spawning creates handles for each work item."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[
            {"goal": "do thing 1", "agentId": "general"},
            {"goal": "do thing 2", "agentId": "coder"},
        ],
        mode="auto",
    )

    handles = await orchestrator.spawn(request)
    assert len(handles) == 2
    assert handles[0].status == "pending"
    assert handles[1].status == "pending"
    assert handles[0].agentId == "general"
    assert handles[1].agentId == "coder"


@pytest.mark.asyncio
async def test_listActive(orchestrator):
    """Active tasks appear in listActive."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[{"goal": "test"}],
        mode="auto",
    )

    handles = await orchestrator.spawn(request)
    active = orchestrator.listActive()
    assert len(active) >= 1
    assert active[0]["taskId"] == handles[0].taskId


@pytest.mark.asyncio
async def test_terminate_cancels_task(orchestrator):
    """Terminate cancels a running task."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[{"goal": "long task", "agentId": "general"}],
        mode="auto",
    )

    handles = await orchestrator.spawn(request)
    taskId = handles[0].taskId

    # Give it a moment to start running
    await asyncio.sleep(0.05)

    result = await orchestrator.terminate(taskId)
    assert result is True

    await asyncio.sleep(0.05)
    handle = orchestrator.getHandle(taskId)
    assert handle is not None


@pytest.mark.asyncio
async def test_orchestrator_events(bus):
    """Orchestrator-level event handlers fire on completion/failure."""
    events: list[str] = []
    orch = SubagentOrchestrator(bus, maxWorkers=5)

    async def on_complete(data):
        events.append(("completed", data.get("status")))

    async def on_fail(data):
        events.append(("failed", data.get("status")))

    orch.on("subagentCompleted", on_complete)
    orch.on("subagentFailed", on_fail)

    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[{"goal": "quick test", "agentId": "general"}],
        mode="auto",
    )

    with patch("app.services.subagent_orchestrator.runSubagent", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = {"status": "completed", "result": "done", "error": ""}
        handles = await orch.spawn(request)
        # Wait for tasks to finish
        await asyncio.sleep(0.2)

    # Check if completed event was fired
    completed_events = [e for e in events if e[0] == "completed"]
    assert len(completed_events) > 0


@pytest.mark.asyncio
async def test_close_cancels_all(orchestrator):
    """Close cancels all running tasks."""
    session = MagicMock()
    request = SubagentSpawnRequest(
        session=session,
        workItems=[{"goal": "task 1"}, {"goal": "task 2"}],
        mode="auto",
    )

    await orchestrator.spawn(request)
    await orchestrator.close()

    active = orchestrator.listActive()
    assert len(active) == 0
