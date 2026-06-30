"""Sub-agent execution test with a mocked model caller (no real API)."""
import asyncio
import types
from app.services.workbench.subagent import executeSubAgent

def testExecuteSubAgentRunsAndEmits(monkeypatch, isolatedData):
    collected: list[dict] = []

    def emit(ev):
        collected.append(ev)

    async def fakeCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        if emit:
            emit({'type': 'final_output', 'content': 'done'})
        return {'content': [{'type': 'text', 'text': 'done'}], 'text': 'done', 'tool_uses': []}
    import app.services.workbench.workbench as wb
    monkeypatch.setattr(wb, '_is_anthropic_provider', lambda p: True)
    monkeypatch.setattr(wb, '_is_openai_provider', lambda p: False)
    monkeypatch.setattr(wb, '_call_anthropic_workbench', fakeCaller)
    monkeypatch.setattr(wb, '_call_openai_workbench', fakeCaller)
    monkeypatch.setattr(wb, '_resolve_workbench_provider', lambda *a, **k: {'name': 'Test', 'api_mode': 'anthropic_messages'})
    monkeypatch.setattr(wb, '_resolve_model', lambda p, m='': 'test-model')
    monkeypatch.setattr(wb, 'tool_definitions', lambda s: [])
    monkeypatch.setattr(wb, 'openai_tool_definitions', lambda s: [])
    import app.providers.modelResolver as mr
    monkeypatch.setattr(mr, 'resolve_or_fallback', lambda *a, **k: {'model': 'm', 'provider': 'Test', 'is_fallback': False})
    import app.services.fallbackService as fs
    monkeypatch.setattr(fs, 'get_fallback', lambda: {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''})
    session = types.SimpleNamespace(id='sess1', model='m', agent_id='', provider='')
    result = asyncio.run(executeSubAgent(session, 'general', 'do the thing', 'ctx', emit=emit))
    assert result['status'] == 'completed'
    assert result['result'] == 'done'
    typesEmitted = [e['type'] for e in collected]
    assert 'subagent_start' in typesEmitted
    assert 'subagent_text' in typesEmitted
    assert 'subagent_done' in typesEmitted
    doneEvt = next((e for e in collected if e['type'] == 'subagent_done'))
    assert doneEvt['status'] == 'completed'