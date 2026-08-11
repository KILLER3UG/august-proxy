"""subAgentFallback must not override explicit model pins.

A pinned ``model:`` directive or the agent's own modelAlias must win; the
fallback applies only when there is no alias hint or the pinned provider
could not be resolved. A warning event is still emitted on actual fallback.
"""

from __future__ import annotations

import asyncio
import types

from app.services.workbench.subagent import executeSubAgent


def _session() -> types.SimpleNamespace:
    return types.SimpleNamespace(id='sess_fb', model='m', agent_id='', provider='')


def _patch_base(monkeypatch, resolution: dict) -> None:
    import app.providers.model_resolver as mr
    import app.services.workbench.workbench as wb

    monkeypatch.setattr(wb, '_isAnthropicProvider', lambda p: True)
    monkeypatch.setattr(wb, '_isOpenaiProvider', lambda p: False)
    monkeypatch.setattr(
        wb, '_resolveWorkbenchProvider', lambda *a, **k: {'name': 'Pinned', 'apiMode': 'anthropicMessages'}
    )
    monkeypatch.setattr(wb, '_resolveModel', lambda p, m='': m or 'test-model')
    monkeypatch.setattr(wb, 'toolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, 'openaiToolDefinitions', lambda s: [])
    monkeypatch.setattr(wb, '_managedToolLoopCap', lambda: 0)
    monkeypatch.setattr(mr, 'resolve_or_fallback', lambda *a, **k: dict(resolution))


def test_fallback_does_not_override_explicit_pin(monkeypatch):
    """aliasHint set + provider resolved → pinned model wins, no warning."""
    import app.services.fallback_service as fs
    import app.services.workbench.workbench as wb

    _patch_base(
        monkeypatch,
        {'model': 'pinned-model', 'provider': 'Pinned', 'is_fallback': False},
    )
    monkeypatch.setattr(
        fs, 'getFallback', lambda: {'enabled': True, 'mode': 'smart', 'provider': 'Fallback', 'model': 'fb-model'}
    )
    used_models: list[str] = []
    collected: list[dict] = []

    async def fakeCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        used_models.append(model)
        return {'content': [{'type': 'text', 'text': 'done'}], 'text': 'done', 'tool_uses': []}

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeCaller)
    # Explicit pin via model_override (directive path).
    result = asyncio.run(
        executeSubAgent(_session(), 'general', 'goal', 'ctx', emit=collected.append, model_override='pinned-model')
    )
    assert result['status'] == 'completed'
    assert used_models == ['pinned-model']
    assert not any(e.get('kind') == 'model_fallback' for e in collected)


def test_fallback_applies_when_no_alias_hint(monkeypatch):
    """aliasHint empty → the fallback model is used and a warning is emitted."""
    import app.providers.route_resolver as rr
    import app.services.fallback_service as fs
    import app.services.model_fleet_service as mfs
    import app.services.workbench.workbench as wb

    _patch_base(monkeypatch, {'model': '', 'provider': '', 'is_fallback': False})
    monkeypatch.setattr(
        fs, 'getFallback', lambda: {'enabled': True, 'mode': 'smart', 'provider': 'Fallback', 'model': 'fb-model'}
    )
    monkeypatch.setattr(rr, 'resolve_for_model', lambda m, p='': {'name': p or 'Fallback', 'apiMode': 'anthropicMessages'})
    monkeypatch.setattr(mfs, 'getModelForRole', lambda role, workspace='': '')
    used_models: list[str] = []
    collected: list[dict] = []

    async def fakeCaller(messages, systemText, model, tools, effort, provider=None, emit=None):
        used_models.append(model)
        return {'content': [{'type': 'text', 'text': 'done'}], 'text': 'done', 'tool_uses': []}

    monkeypatch.setattr(wb, '_callAnthropicWorkbench', fakeCaller)
    session = types.SimpleNamespace(id='sess_fb2', model='', agent_id='', provider='')
    result = asyncio.run(executeSubAgent(session, 'general', 'goal', 'ctx', emit=collected.append))
    assert result['status'] == 'completed'
    assert used_models == ['fb-model']
    assert any(e.get('kind') == 'model_fallback' for e in collected)
