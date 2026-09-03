"""Subagent parity batch (2026-09-02 review):

1. ``submit_todos`` / ``update_todos`` are REGISTERED tools (visible to native
   tool-calling models, covered by the validator + policy buckets) — before
   this they were loop-intercept names no schema ever advertised.
2. A worker's todo list is UNIQUE to that worker: ``routeTodos`` with the
   task-scoped ContextVar set stores on the orchestrator handle, never on the
   parent session (two parallel workers must not clobber each other).
3. Guard parity: the ``tool_call`` bridge re-applies the session guard
   (plan-mode / read-only sandbox could otherwise be bypassed by name).
4. Worker-loop guard parity: a sub-agent spawned from a plan-mode session is
   blocked from mutating tools (spawn_subagents was a plan-mode escape).
"""

from __future__ import annotations

import asyncio
import json
import types

import pytest

# ── 1. Registration ──────────────────────────────────────────────────────


def test_todo_tools_registered_with_schemas():
    from app.services import tool_registry
    from app.services.tool_registrations import register_all

    register_all()
    for name in ('submit_todos', 'update_todos'):
        tool = tool_registry.getTool(name)
        assert tool is not None, f'{name} must be a registered tool'
        schema = tool.get('input_schema') or tool.get('parameters') or {}
        props = schema.get('properties') or {}
        assert 'todos' in props
        item = (props.get('todos') or {}).get('items') or {}
        assert set(item.get('required') or []) == {'content', 'status'}


def test_todo_tools_policy_buckets():
    """Both land in tool_write (session-state writes, update_state precedent)."""
    from app.services import tool_policy

    assert tool_policy.prompt_bucket('submit_todos') == 'tool_write'
    assert tool_policy.prompt_bucket('update_todos') == 'tool_write'


# ── 2. Per-agent todo routing ────────────────────────────────────────────


def test_route_todos_lands_on_worker_handle_not_session(isolatedData, monkeypatch):
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSubagentTaskId
    from app.services.workbench.workbench import routeTodos

    class _Handle:
        agentId = 'general'
        todos: list = []

    handle = _Handle()

    class _Orch:
        def getHandle(self, tid):
            return handle if tid == 'task_worker1' else None

    monkeypatch.setattr(
        'app.services.runtime_services.get_orchestrator', lambda: _Orch(), raising=True
    )

    parent_session = types.SimpleNamespace(id='sessP', todos=[], updatedAt='')
    monkeypatch.setitem(wb._sessions, 'sessP', parent_session)
    monkeypatch.setattr(wb, '_emitSessionStatus', lambda sid: None)

    items = [{'content': 'step one', 'status': 'in_progress'}]
    emitted: list[dict] = []
    token = currentSubagentTaskId.set('task_worker1')
    try:
        receipt = routeTodos(items, emit=emitted.append)
    finally:
        currentSubagentTaskId.reset(token)

    assert handle.todos == items
    assert parent_session.todos == []  # parent untouched
    assert 'worker' in receipt.lower()
    assert emitted and emitted[0]['type'] == 'subagentTodos'
    assert emitted[0]['jobId'] == 'task_worker1'


def test_route_todos_main_path_stores_on_session(isolatedData, monkeypatch):
    from app.services.workbench import workbench as wb
    from app.services.workbench.workbench import routeTodos

    session = types.SimpleNamespace(id='sessM', todos=[], updatedAt='')
    monkeypatch.setitem(wb._sessions, 'sessM', session)
    monkeypatch.setattr(wb, '_emitSessionStatus', lambda sid: None)

    items = [{'content': 'a', 'status': 'pending'}]
    receipt = routeTodos(items)
    assert session.todos == items
    assert receipt == 'Todo list saved.'


# ── 3. tool_call bridge guard parity ─────────────────────────────────────


def test_tool_call_bridge_blocks_plan_mode_write(isolatedData, monkeypatch):
    from app.services.tool_registrations import register_all
    from app.services.tools.tool_bridges import handleToolCall
    from app.services.workbench import workbench as wb

    register_all()
    session = types.SimpleNamespace(
        id='sessG', guardMode='plan', planApproved=False, sandboxMode='workspace-write',
        plan=None, planRisk='', metadata={},
    )
    monkeypatch.setitem(wb._sessions, 'sessG', session)
    from app.services.workbench.context import currentSessionId

    tok = currentSessionId.set('sessG')
    try:
        out = asyncio.run(
            handleToolCall('write_file', json.dumps({'path': 'x.txt', 'content': 'hi'}))
        )
    finally:
        currentSessionId.reset(tok)
    assert out.startswith('[Blocked]'), out


def test_tool_call_bridge_allows_reads(isolatedData, monkeypatch, tmp_path):
    from app.services.tool_registrations import register_all
    from app.services.tools.tool_bridges import handleToolCall
    from app.services.workbench import workbench as wb

    register_all()
    session = types.SimpleNamespace(
        id='sessR', guardMode='plan', planApproved=False, sandboxMode='workspace-write',
        plan=None, planRisk='', metadata={},
    )
    monkeypatch.setitem(wb._sessions, 'sessR', session)
    from app.services.workbench.context import currentSessionId

    f = tmp_path / 'hello.txt'
    f.write_text('content-here', encoding='utf-8')
    tok = currentSessionId.set('sessR')
    try:
        out = asyncio.run(handleToolCall('read_file', json.dumps({'path': str(f)})))
    finally:
        currentSessionId.reset(tok)
    assert 'content-here' in out


# ── 4. Worker-loop guard parity (plan-mode escape closed) ────────────────


def _patch_model_callers(monkeypatch, wb, tool_uses: list[dict]):
    calls = {'n': 0}

    async def fakeCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        calls['n'] += 1
        if calls['n'] == 1:
            return {'content': tool_uses, 'text': '', 'tool_uses': tool_uses}
        return {'content': [{'type': 'text', 'text': 'finished'}], 'text': 'finished', 'tool_uses': []}

    monkeypatch.setattr(wb, '_isAnthropicProvider', lambda p: True)
    monkeypatch.setattr(wb, '_isOpenaiProvider', lambda p: False)
    monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeCaller)
    monkeypatch.setattr(wb, '_callOpenaiWorkbench', fakeCaller)
    monkeypatch.setattr(
        wb, '_resolveWorkbenchProvider',
        lambda *a, **k: {'name': 'Test', 'apiMode': 'anthropicMessages'},
    )
    monkeypatch.setattr(wb, '_resolveModel', lambda p, m='': 'test-model')
    monkeypatch.setattr(wb, 'toolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, 'openaiToolDefinitions', lambda s: [])
    import app.providers.model_resolver as mr

    monkeypatch.setattr(
        mr, 'resolve_or_fallback',
        lambda *a, **k: {'model': 'm', 'provider': 'Test', 'is_fallback': False},
    )
    import app.services.fallback_service as fs

    monkeypatch.setattr(
        fs, 'getFallback', lambda: {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''}
    )


def test_worker_blocked_by_parent_plan_mode(isolatedData, monkeypatch, tmp_path):
    """A sub-agent of a plan-mode session must not write files via dispatch."""
    import app.services.workbench.workbench as wb
    from app.services.workbench.subagent import executeSubAgent

    written = tmp_path / 'escape.txt'

    async def fakeDispatch(name, args):
        # Would create the file if the guard let it through.
        written.write_text('escaped', encoding='utf-8')
        return 'wrote file'

    monkeypatch.setattr('app.services.tool_registry.dispatch', fakeDispatch)
    _patch_model_callers(
        monkeypatch, wb,
        [{'type': 'tool_use', 'id': 't1', 'name': 'write_file',
          'input': {'path': str(written), 'content': 'x'}}],
    )
    session = types.SimpleNamespace(
        id='sessW', model='m', agent_id='', provider='', guardMode='plan',
        planApproved=False, sandboxMode='workspace-write', metadata={},
    )
    monkeypatch.setitem(wb._sessions, 'sessW', session)
    result = asyncio.run(executeSubAgent(session, 'general', 'try to write', ''))
    assert result['status'] == 'completed'
    assert not written.exists(), 'plan-mode guard must block the worker write'


def test_worker_full_mode_not_blocked(isolatedData, monkeypatch):
    """In full guard mode the worker dispatches normally (no over-blocking)."""
    import app.services.workbench.workbench as wb
    from app.services.workbench.subagent import executeSubAgent

    seen: list[str] = []

    async def fakeDispatch(name, args):
        seen.append(name)
        return 'ok-result'

    monkeypatch.setattr('app.services.tool_registry.dispatch', fakeDispatch)
    _patch_model_callers(
        monkeypatch, wb,
        [{'type': 'tool_use', 'id': 't1', 'name': 'write_file',
          'input': {'path': 'a.txt', 'content': 'x'}}],
    )
    session = types.SimpleNamespace(
        id='sessF', model='m', agent_id='', provider='', guardMode='full',
        planApproved=False, sandboxMode='workspace-write', metadata={},
    )
    monkeypatch.setitem(wb._sessions, 'sessF', session)
    result = asyncio.run(executeSubAgent(session, 'general', 'write it', ''))
    assert result['status'] == 'completed'
    assert seen == ['write_file']


# ── 5. D-1 missed-steer preservation + D-2 stop→partial (Part 22) ───────


def test_missed_steer_attaches_to_result(isolatedData):
    import asyncio

    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import (
        SubagentHandle,
        SubagentOrchestrator,
        SubagentSpawnRequest,
    )

    orch = SubagentOrchestrator(AgentMessageBus())
    handle = SubagentHandle('task_steer', 'general', 'goal', sessionId='s1')
    orch._handles['task_steer'] = handle

    async def fakeRun(**kwargs):
        # Worker finishes WITHOUT draining the steer queued after its last round.
        return {'taskId': 'task_steer', 'agentId': 'general', 'status': 'completed', 'result': 'done'}

    import app.services.subagent_worker as sw

    orig = sw.runSubagent
    sw.runSubagent = fakeRun  # type: ignore[assignment]
    try:
        session = types.SimpleNamespace(id='s1', model='m', provider='', subagent_depth=0)
        req = SubagentSpawnRequest(session=session, workItems=[{'goal': 'goal'}])

        async def _run():
            handles = await orch.spawn(req)
            # Queue steering AFTER the worker started (it will finish without draining).
            orch.enqueueMailbox(handles[0].taskId, 'please also check X')
            return await orch.waitForAll(handles)

        results = asyncio.run(_run())
    finally:
        sw.runSubagent = orig  # type: ignore[assignment]

    r = results[0]
    payload = r.get('result')
    assert isinstance(payload, dict)
    assert payload.get('missedSteer') == 'please also check X'
    assert 'please also check X' in str(payload.get('result'))


def test_terminate_collects_partial_from_transcript(isolatedData):
    """D-2: a cancelled worker's partial text is persisted on the handle."""
    import asyncio

    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import (
        SubagentHandle,
        SubagentOrchestrator,
        _append_transcript,
    )

    orch = SubagentOrchestrator(AgentMessageBus())
    handle = SubagentHandle('task_stop', 'general', 'goal', sessionId='s2')
    handle.status = 'running'
    orch._handles['task_stop'] = handle
    _append_transcript('task_stop', {'type': 'subagentText', 'jobId': 'task_stop', 'content': 'found A'})
    _append_transcript('task_stop', {'type': 'subagentToolCall', 'jobId': 'task_stop', 'name': 'read_file'})
    _append_transcript('task_stop', {'type': 'subagentText', 'jobId': 'task_stop', 'content': 'found B'})

    async def _stop():
        task = asyncio.create_task(asyncio.sleep(60))
        orch._tasks['task_stop'] = task
        return await orch.terminate('task_stop')

    assert asyncio.run(_stop()) is True
    assert handle.status == 'cancelled'
    assert isinstance(handle.result, dict)
    text = str(handle.result.get('result'))
    assert 'found A' in text and 'found B' in text and 'read_file' in text


def test_worker_submit_todos_routes_to_handle(isolatedData, monkeypatch):
    """End-to-end through executeSubAgent: submit_todos lands on the worker's
    orchestrator handle and emits subagentTodos, not the parent session."""
    import app.services.workbench.workbench as wb
    from app.services.workbench.subagent import executeSubAgent

    class _Handle:
        agentId = 'general'
        todos: list = []

    handle = _Handle()

    class _Orch:
        def getHandle(self, tid):
            return handle if tid == 'task_e2e' else None

        def drainMailbox(self, tid):
            return []

    monkeypatch.setattr(
        'app.services.runtime_services.get_orchestrator', lambda: _Orch(), raising=True
    )
    _patch_model_callers(
        monkeypatch, wb,
        [{'type': 'tool_use', 'id': 't1', 'name': 'submit_todos',
          'input': {'todos': [{'content': 'step', 'status': 'in_progress'}]}}],
    )
    parent = types.SimpleNamespace(
        id='sessE', model='m', agent_id='', provider='', guardMode='full',
        sandboxMode='workspace-write', metadata={}, todos=[],
    )
    monkeypatch.setitem(wb._sessions, 'sessE', parent)
    monkeypatch.setattr(wb, '_emitSessionStatus', lambda sid: None)
    events: list[dict] = []
    result = asyncio.run(
        executeSubAgent(parent, 'general', 'plan your work', '', emit=events.append, task_id='task_e2e')
    )
    assert result['status'] == 'completed'
    assert handle.todos == [{'content': 'step', 'status': 'in_progress'}]
    assert parent.todos == []
    assert any(e['type'] == 'subagentTodos' for e in events)
