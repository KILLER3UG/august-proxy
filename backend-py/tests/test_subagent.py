"""Sub-agent execution test with a mocked model caller (no real API)."""
import asyncio
import types

from app.services.workbench.subagent import execute_sub_agent


def test_execute_sub_agent_runs_and_emits(monkeypatch, isolated_data):
    collected: list[dict] = []
    def emit(ev): collected.append(ev)

    async def fake_caller(messages, system_text, model, tools, effort, provider=None, emit=None):
        if emit:
            emit({"type": "final_output", "content": "done"})
        return {"content": [{"type": "text", "text": "done"}], "text": "done", "tool_uses": []}

    import app.services.workbench.workbench as wb
    monkeypatch.setattr(wb, "_is_anthropic_provider", lambda p: True)
    monkeypatch.setattr(wb, "_is_openai_provider", lambda p: False)
    monkeypatch.setattr(wb, "_call_anthropic_workbench", fake_caller)
    monkeypatch.setattr(wb, "_call_openai_workbench", fake_caller)
    monkeypatch.setattr(wb, "_resolve_workbench_provider", lambda *a, **k: {"name": "Test", "api_mode": "anthropic_messages"})
    monkeypatch.setattr(wb, "_resolve_model", lambda p, m="": "test-model")
    monkeypatch.setattr(wb, "tool_definitions", lambda s: [])
    monkeypatch.setattr(wb, "openai_tool_definitions", lambda s: [])

    import app.providers.model_resolver as mr
    monkeypatch.setattr(mr, "resolve_or_fallback", lambda *a, **k: {"model": "m", "provider": "Test", "is_fallback": False})

    import app.services.fallback_service as fs
    monkeypatch.setattr(fs, "get_fallback", lambda: {"enabled": False, "mode": "off", "provider": "", "model": ""})

    session = types.SimpleNamespace(id="sess1", model="m", agent_id="", provider="")
    result = asyncio.run(execute_sub_agent(session, "general", "do the thing", "ctx", emit=emit))

    assert result["status"] == "completed"
    assert result["result"] == "done"
    types_emitted = [e["type"] for e in collected]
    assert "subagent_start" in types_emitted
    assert "subagent_text" in types_emitted
    assert "subagent_done" in types_emitted
    done_evt = next(e for e in collected if e["type"] == "subagent_done")
    assert done_evt["status"] == "completed"
