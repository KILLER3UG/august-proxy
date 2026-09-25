"""One real worker run, end to end: the answer must survive with its tail.

This is the regression test for the symptom "a subagent does not return its
output to the main agent". It drives `executeSubAgent` through three rounds —
two that call tools and one that answers — and asserts that what the PARENT
receives is the child's conclusion, not the child's narration about how it got
there. Every earlier fix in this area patched one of the four delivery paths
(spawn / return-to-model / stream-to-UI / render) and left the other three, so
the assertions here deliberately cross all of them.
"""

from __future__ import annotations

import asyncio
import types

import pytest

NARRATION_1 = 'round one: reading the migrations directory'
NARRATION_2 = 'round two: cross-checking the router registrations'
# Long enough that any head-only cap truncates it, and the payload is at the end
# — which is where a model puts a conclusion and where `text[:4000]` never looked.
ANSWER = 'FINAL ANSWER: the migration is 049_client_folder.sql\n' + ('padding ' * 3000)


@pytest.fixture()
def _worker_env(monkeypatch):
    """Stub the provider call and the tool dispatch for a three-round worker."""
    calls = {'n': 0}

    async def fakeCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        calls['n'] += 1
        if calls['n'] == 1:
            text = NARRATION_1
        elif calls['n'] == 2:
            text = NARRATION_2
        else:
            return {'content': [{'type': 'text', 'text': ANSWER}], 'text': ANSWER, 'tool_uses': []}
        return {
            'content': [
                {'type': 'text', 'text': text},
                {'type': 'tool_use', 'id': f'tu_{calls["n"]}', 'name': 'read_file', 'input': {'path': 'a.py'}},
            ],
            'text': text,
            'tool_uses': [{'id': f'tu_{calls["n"]}', 'name': 'read_file', 'input': {'path': 'a.py'}}],
        }

    async def fakeExecuteTool(*args, **kwargs):
        return 'tool output bytes'

    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_isAnthropicProvider', lambda p: True)
    monkeypatch.setattr(wb, '_isOpenaiProvider', lambda p: False)
    monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeCaller)
    monkeypatch.setattr(wb, '_callOpenaiWorkbench', fakeCaller)
    monkeypatch.setattr(wb, '_executeTool', fakeExecuteTool)
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **k: {'name': 'T', 'apiMode': 'anthropicMessages'})
    monkeypatch.setattr(wb, '_resolveModel', lambda p, m='': 'test-model')
    monkeypatch.setattr(wb, 'toolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, 'openaiToolDefinitions', lambda s: [])

    import app.providers.model_resolver as mr

    monkeypatch.setattr(mr, 'resolve_or_fallback', lambda *a, **k: {'model': 'm', 'provider': 'T', 'is_fallback': False})
    import app.services.fallback_service as fs

    monkeypatch.setattr(fs, 'getFallback', lambda: {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''})
    return calls


def _session(tmp_path):
    return types.SimpleNamespace(
        id='sess_delivery',
        model='m',
        agent_id='',
        provider='',
        workspacePath=str(tmp_path),
        guardMode='full',
        metadata={},
    )


def test_parent_receives_the_conclusion_not_the_narration(_worker_env, isolatedData, tmp_path):
    from app.services.workbench.subagent import executeSubAgent

    collected: list[dict] = []
    result = asyncio.run(
        executeSubAgent(_session(tmp_path), 'general', 'find the migration', 'ctx', emit=collected.append)
    )

    assert _worker_env['n'] == 3, 'the worker did not run the expected three rounds'
    assert result['status'] == 'completed'

    # PATH 1 — what the orchestrator hands up. Under the old accumulation rule
    # this was `NARRATION_1 + NARRATION_2 + ANSWER` and every consumer had to
    # guess where the answer started.
    assert result['result'] == ANSWER.strip()

    # PATH 2 — the SSE frame the chat renders. It is capped, so assert the cap
    # kept the END: `text[:4000]` satisfied `startswith` while losing the tail,
    # which was the single most user-visible form of this bug.
    done = next(e for e in collected if e['type'] == 'subagentDone')
    assert done['status'] == 'completed'
    assert ANSWER[-60:] in done['result'], 'the subagentDone frame truncated away the answer'
    assert len(done['result']) < len(ANSWER), 'the frame should still be bounded'

    # PATH 3 — the job row the roster reads back after a reload.
    from app.services.tools.agent_registry import listJobs

    rows = [j for j in listJobs() if j.get('id') == result['jobId']]
    assert rows, 'the worker left no job row for the roster to read'
    assert ANSWER.strip()[-60:] in str(rows[0].get('result') or ''), 'the stored row lost the answer'

    # The narration is not asserted to be GONE from the receipt chain — but the
    # answer must be the thing named by `result`, not a tail inside a blob.


def test_a_long_completion_notice_reaches_the_parent_with_its_tail(_worker_env, isolatedData, tmp_path):
    """PATH 1 all the way to the parent's message queue."""
    from app.services.tools.spawn_subagents_tool import _enqueue_completion
    from app.services.workbench import workbench as wb
    from app.services.workbench.subagent import executeSubAgent

    result = asyncio.run(
        executeSubAgent(_session(tmp_path), 'general', 'find the migration', 'ctx', emit=None)
    )

    sent: list[str] = []
    original = wb.enqueueUserMessage

    def fakeEnqueue(sid, text, kind='subagent'):
        sent.append(text)

    wb.enqueueUserMessage = fakeEnqueue  # type: ignore[assignment]
    try:
        _enqueue_completion({'id': 'wb_parent'}, result)
    finally:
        wb.enqueueUserMessage = original  # type: ignore[assignment]

    assert len(sent) == 1
    assert ANSWER[-60:] in sent[0], 'the parent was handed the narration and not the conclusion'
    assert 'SUBAGENT_COMPLETE' in sent[0]
