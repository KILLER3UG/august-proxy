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
    monkeypatch.setattr(wb, '_isAnthropicProvider', lambda p: True)
    monkeypatch.setattr(wb, '_isOpenaiProvider', lambda p: False)
    monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeCaller)
    monkeypatch.setattr(wb, '_callOpenaiWorkbench', fakeCaller)
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **k: {'name': 'Test', 'api_mode': 'anthropicMessages'})
    monkeypatch.setattr(wb, '_resolveModel', lambda p, m='': 'test-model')
    monkeypatch.setattr(wb, 'toolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, 'openaiToolDefinitions', lambda s: [])
    import app.providers.modelResolver as mr
    monkeypatch.setattr(mr, 'resolveOrFallback', lambda *a, **k: {'model': 'm', 'provider': 'Test', 'is_fallback': False})
    import app.services.fallback_service as fs
    monkeypatch.setattr(fs, 'getFallback', lambda: {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''})
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