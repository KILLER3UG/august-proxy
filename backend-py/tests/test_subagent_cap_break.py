"""Sub-agent tool-round cap break must NOT be reported as 'completed'.

The loop exits when ``toolRound > managedToolLoopCap``; before the fix the
job was still marked completed with whatever (possibly empty) text existed,
so the orchestrator's failure tally and _doSpawn's `succeeded` counter
counted capped runs as wins.
"""

from __future__ import annotations

import asyncio
import types

from app.services.workbench.subagent import executeSubAgent


def _patch_env(monkeypatch, cap: int) -> None:
    import app.providers.model_resolver as mr
    import app.services.fallback_service as fs
    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_isAnthropicProvider', lambda p: True)
    monkeypatch.setattr(wb, '_isOpenaiProvider', lambda p: False)
    monkeypatch.setattr(
        wb, '_resolveWorkbenchProvider', lambda *a, **k: {'name': 'Test', 'apiMode': 'anthropicMessages'}
    )
    monkeypatch.setattr(wb, '_resolveModel', lambda p, m='': m or 'test-model')
    monkeypatch.setattr(wb, 'toolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, 'openaiToolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, '_managedToolLoopCap', lambda: cap)
    monkeypatch.setattr(
        mr, 'resolve_or_fallback', lambda *a, **k: {'model': 'm', 'provider': 'Test', 'is_fallback': False}
    )
    monkeypatch.setattr(fs, 'getFallback', lambda: {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''})


def _tool_only_response() -> dict:
    return {
        'content': [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'eval_probe', 'input': {}}],
        'text': '',
        'tool_uses': [],
    }


def test_cap_break_without_text_reports_failed(monkeypatch):
    """A capped run with no text is 'failed', not 'completed'."""
    _patch_env(monkeypatch, cap=2)
    collected: list[dict] = []

    async def toolCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        return _tool_only_response()

    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', toolCaller)
    session = types.SimpleNamespace(id='sess_cap1', model='m', agent_id='', provider='')
    result = asyncio.run(executeSubAgent(session, 'general', 'do it', 'ctx', emit=collected.append))
    assert result['status'] == 'failed'
    assert '[loop cap reached]' in result['result']
    done = [e for e in collected if e.get('type') == 'subagentDone'][-1]
    assert done['status'] == 'failed'


def test_cap_break_with_text_reports_partial(monkeypatch):
    """A capped run that produced text is 'partial' (never 'completed')."""
    _patch_env(monkeypatch, cap=2)
    collected: list[dict] = []

    async def textToolCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        return {
            'content': [
                {'type': 'text', 'text': 'working on it'},
                {'type': 'tool_use', 'id': 'toolu_1', 'name': 'eval_probe', 'input': {}},
            ],
            'text': 'working on it',
            'tool_uses': [],
        }

    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', textToolCaller)
    session = types.SimpleNamespace(id='sess_cap2', model='m', agent_id='', provider='')
    result = asyncio.run(executeSubAgent(session, 'general', 'do it', 'ctx', emit=collected.append))
    assert result['status'] == 'partial'
    assert '[loop cap reached]' in result['result']
    assert 'working on it' in result['result']
    done = [e for e in collected if e.get('type') == 'subagentDone'][-1]
    assert done['status'] == 'partial'


def test_within_cap_clean_completion_still_completed(monkeypatch):
    """A run that finishes inside the cap is still 'completed'."""
    _patch_env(monkeypatch, cap=10)
    collected: list[dict] = []

    async def textCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        return {'content': [{'type': 'text', 'text': 'done clean'}], 'text': 'done clean', 'tool_uses': []}

    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', textCaller)
    session = types.SimpleNamespace(id='sess_cap3', model='m', agent_id='', provider='')
    result = asyncio.run(executeSubAgent(session, 'general', 'do it', 'ctx', emit=collected.append))
    assert result['status'] == 'completed'
    assert result['result'] == 'done clean'
