"""resolve_chat_llm must re-resolve the model against the winning provider
after the last-resort 'first provider with a key' fallback."""

from __future__ import annotations

from app.services.workbench import providers as prov


def test_last_resort_fallback_resolves_model_against_winning_provider(monkeypatch):
    """Old session model not on the winning provider → provider default wins."""
    winning = {
        'name': 'Winning',
        'apiKey': 'k',
        'defaultModel': 'gpt-x',
        'models': [{'id': 'gpt-x'}, {'id': 'gpt-y'}],
    }

    def fake_resolve(name: str = '', model_hint: str = '') -> dict | None:
        if not name and not model_hint:
            return winning
        return None

    monkeypatch.setattr(prov, 'resolve_workbench_provider', fake_resolve)
    provider, model = prov.resolve_chat_llm(
        model='', model_provider='', session_provider='Dead', session_model='claude-3'
    )
    assert provider is winning
    assert model == 'gpt-x'


def test_last_resort_keeps_model_when_winning_provider_lists_it(monkeypatch):
    """Session model present on the winning provider's list is kept."""
    winning = {
        'name': 'Winning',
        'apiKey': 'k',
        'defaultModel': 'gpt-x',
        'models': [{'id': 'claude-3'}, {'id': 'gpt-x'}],
    }

    def fake_resolve(name: str = '', model_hint: str = '') -> dict | None:
        if not name and not model_hint:
            return winning
        return None

    monkeypatch.setattr(prov, 'resolve_workbench_provider', fake_resolve)
    _provider, model = prov.resolve_chat_llm(
        model='', model_provider='', session_provider='Dead', session_model='claude-3'
    )
    assert model == 'claude-3'


def test_last_resort_keeps_hint_when_provider_has_no_model_list(monkeypatch):
    """No authoritative model list → cannot verify, the hint is kept."""
    winning = {'name': 'Winning', 'apiKey': 'k', 'defaultModel': 'gpt-x'}

    def fake_resolve(name: str = '', model_hint: str = '') -> dict | None:
        if not name and not model_hint:
            return winning
        return None

    monkeypatch.setattr(prov, 'resolve_workbench_provider', fake_resolve)
    _provider, model = prov.resolve_chat_llm(
        model='', model_provider='', session_provider='Dead', session_model='claude-3'
    )
    assert model == 'claude-3'


def test_no_fallback_when_session_provider_resolves(monkeypatch):
    """Normal path: session provider resolves → its model is kept untouched."""
    session_prov = {'name': 'SessionP', 'apiKey': 'k', 'defaultModel': 's-model', 'models': [{'id': 's-model'}]}

    def fake_resolve(name: str = '', model_hint: str = '') -> dict | None:
        if name == 'SessionP':
            return session_prov
        return None

    monkeypatch.setattr(prov, 'resolve_workbench_provider', fake_resolve)
    provider, model = prov.resolve_chat_llm(
        model='', model_provider='', session_provider='SessionP', session_model='s-model'
    )
    assert provider is session_prov
    assert model == 's-model'
