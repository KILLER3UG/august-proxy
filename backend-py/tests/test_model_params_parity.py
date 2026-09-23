"""Refactor parity for the model family table.

The table replaces two hand-maintained substring heuristics. A replacement is
only safe if it answers every id the way the old code did, so the old logic is
re-implemented here verbatim as the oracle — the same pattern
tests/test_tool_policy_parity.py uses — and replayed over a corpus that
includes the awkward ids.
"""

from __future__ import annotations

import pytest
from app.providers import model_params
from app.services.workbench.effort import resolve_effective_effort

# ── oracles: the pre-table implementations, copied literally ──────────────

_OLD_REASONING_TOKENS = (
    'o1', 'o3', 'o4', 'reasoner', 'thinking', 'reasoning', 'deepseek', 'gpt-5',
    'qwen3', 'qwq', 'glm-4', 'glm-5', 'kimi-k2', 'grok-3', 'grok-4', 'nemotron',
)


def _old_accepts_reasoning(model: str) -> bool:
    mid = (model or '').lower()
    return any(token in mid for token in _OLD_REASONING_TOKENS)


def _old_claude_thinking(model_l: str) -> bool:
    if 'claude' not in model_l:
        return False
    legacy = (
        'claude-3-5', 'claude-3.5', 'claude-3-haiku', 'claude-3-opus',
        'claude-3-sonnet', 'claude-instant', 'claude-2',
    )
    return not any(token in model_l for token in legacy)


# ── corpus ────────────────────────────────────────────────────────────────

MODEL_IDS = [
    # OpenAI
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o1', 'o1-mini', 'o3', 'o3-mini',
    'o4-mini', 'chatgpt-4o-latest', 'gpt-4o', 'gpt-4.1', 'gpt-4',
    'gpt-5-codex', 'o3-deep-research',
    # DeepSeek / R1 line
    'deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-v3',
    'x2dept1ke-mo', 'siliconflow/deepseek-r1',
    # Qwen / thinking-suffixed
    'qwen3-30b-a3b', 'qwen3-235b-a22b', 'qwq-32b', 'qwen-plus',
    'qwen3-8b-thinking', 'hermes-4-70b-thinking',
    # Z / GLM / Kimi / Grok / Nemotron
    'glm-4.6', 'glm-5-turbo', 'glm-4v', 'kimi-k2-0905', 'kimi-latest',
    'grok-3', 'grok-4-fast', 'grok-2', 'nemotron-70b', 'nemotron-51b',
    # Anthropic
    'claude-opus-4-1', 'claude-sonnet-4', 'claude-3-5-sonnet',
    'claude-3-5-haiku', 'claude-3.5-sonnet', 'claude-3-haiku',
    'claude-3-opus', 'claude-3-sonnet', 'claude-instant-1', 'claude-2.1',
    'anthropic/claude-opus-4',
    # Things that must stay negative, incl. near-miss substrings
    'llama-3.3-70b-instruct', 'mistral-large', 'phi-4', 'command-r-plus',
    'codellama-34b', 'yi-lightning', 'gemma-3-27b', 'mixtral-8x7b',
    'nova-pro', 'jamba-pro', 'groq/llama-3.3-70b', 'together/moe-1',
    '',
]


@pytest.mark.parametrize('model_id', MODEL_IDS)
def test_reasoning_effort_answer_is_unchanged(model_id: str) -> None:
    assert model_params.accepts_reasoning_effort(model_id) is _old_accepts_reasoning(model_id), (
        f'{model_id!r}: table disagrees with the heuristic it replaced'
    )


@pytest.mark.parametrize('model_id', MODEL_IDS)
def test_extended_thinking_answer_is_unchanged(model_id: str) -> None:
    mid = (model_id or '').lower()
    assert model_params.supports_extended_thinking(mid) is _old_claude_thinking(mid), (
        f'{model_id!r}: table disagrees with the heuristic it replaced'
    )


def test_workbench_call_sites_still_delegate_to_the_same_answers() -> None:
    from app.services.workbench.effort import model_likely_accepts_reasoning_effort
    from app.services.workbench.providers import _claude_supports_extended_thinking_by_id

    for model_id in MODEL_IDS:
        mid = (model_id or '').lower()
        assert model_likely_accepts_reasoning_effort(model_id) is _old_accepts_reasoning(mid)
        assert _claude_supports_extended_thinking_by_id(mid) is _old_claude_thinking(mid)


def test_no_builtin_family_changes_an_effort_default() -> None:
    """Adopting the table must not alter a single request today.

    Built-ins describe capability only; `defaultEffort` is reserved for
    operator-declared families, so the new model tier in
    resolve_effective_effort is inert until someone opts in.
    """
    for family in model_params._BUILTIN_FAMILIES:
        assert family.default_effort is None, family.id
        assert family.max_effort is None, family.id


def test_per_model_ui_override_still_wins() -> None:
    """The table sits BELOW the explicit Model settings toggle, not above it."""
    from app.services.workbench.effort import provider_accepts_reasoning_effort

    provider = {'name': 'Something Random', 'apiMode': 'openaiChat'}
    assert provider_accepts_reasoning_effort(provider, 'glm-4.6', {'supportsReasoningEffort': False}) is False
    assert provider_accepts_reasoning_effort(provider, 'llama-3.3-70b', {'supportsReasoningEffort': True}) is True


def _stub_config(monkeypatch: pytest.MonkeyPatch, value: object) -> None:
    """Put a config mapping behind the real `settings.config` property.

    `config` is a read-only property over `_config`/`_config_loaded`, so this
    drives the same path production uses instead of adding a seam to the
    module under test.
    """
    from app.config import settings

    monkeypatch.setattr(settings, '_config', value, raising=False)
    monkeypatch.setattr(settings, '_config_loaded', True, raising=False)
    model_params.invalidate()


@pytest.fixture()
def clean_families() -> object:
    """Leave no cross-test residue in the module-level memos."""
    yield
    model_params.invalidate()


class _Session:
    def __init__(self, effort: str | None = None) -> None:
        self.metadata: dict[str, object] = {} if effort is None else {'effort': effort}


def test_effort_precedence_param_session_model_then_medium() -> None:
    family_entry = {'id': 'kimi-k2-0905'}
    assert resolve_effective_effort('high', _Session('low'), None) == 'high'
    assert resolve_effective_effort(None, _Session('max'), None) == 'max'
    assert resolve_effective_effort(None, _Session(), family_entry) == 'medium'
    assert resolve_effective_effort(None, _Session(), {'id': 'gpt-4o'}) == 'medium'


def test_operator_family_can_supply_a_default_effort(
    monkeypatch: pytest.MonkeyPatch, clean_families: None,
) -> None:
    """The point of the table: a new gateway family without a code change."""
    _stub_config(monkeypatch, {'modelParams': {'families': [{
        'id': 'acme-reasoner', 'tokens': ['acme-r1'],
        'reasoningEffort': True, 'defaultEffort': 'high',
    }]}})
    assert model_params.accepts_reasoning_effort('acme-r1-32b') is True
    assert resolve_effective_effort(None, _Session(), {'id': 'acme-r1-32b'}) == 'high'
    # An explicit param still beats the family default.
    assert resolve_effective_effort('low', _Session(), {'id': 'acme-r1-32b'}) == 'low'


def test_operator_family_overrides_a_builtin_of_the_same_id(
    monkeypatch: pytest.MonkeyPatch, clean_families: None,
) -> None:
    _stub_config(monkeypatch, {'modelParams': {'families': [{
        'id': 'claude-extended-thinking', 'tokens': ['claude'],
        'extendedThinking': False, 'excludes': ['claude-3-5'],
    }]}})
    assert model_params.supports_extended_thinking('claude-opus-4-1') is False


def test_malformed_family_entries_are_skipped_without_breaking_others(
    monkeypatch: pytest.MonkeyPatch, clean_families: None,
) -> None:
    _stub_config(monkeypatch, {'modelParams': {'families': [
        {'id': 'good', 'tokens': ['goodm'], 'reasoningEffort': True},
        {'tokens': ['no-id']},                      # no id
        {'id': 'no-tokens'},                        # no matchers
        {'id': 'bad-effort', 'tokens': ['x'], 'defaultEffort': 'extreme'},
        'not json at all',
    ]}})
    assert model_params.accepts_reasoning_effort('goodm-7b') is True
    assert [family.id for family in model_params._from_config()] == ['good']


def test_broken_config_access_does_not_disable_requests(
    monkeypatch: pytest.MonkeyPatch, clean_families: None,
) -> None:
    class _Boom:
        @property
        def config(self) -> dict[str, object]:
            raise RuntimeError('config unreadable')

    import app.config

    monkeypatch.setattr(app.config, 'settings', _Boom())
    model_params.invalidate()
    assert model_params.accepts_reasoning_effort('gpt-5') is True


def test_memo_cannot_serve_a_stale_answer_after_a_reload(
    monkeypatch: pytest.MonkeyPatch, clean_families: None,
) -> None:
    from app.config import settings

    _stub_config(monkeypatch, {'modelParams': {'families': [
        {'id': 'brand', 'tokens': ['brand-new'], 'reasoningEffort': True},
    ]}})
    assert model_params.accepts_reasoning_effort('brand-new-model') is True

    # Simulate settings.reload(): a different config object, no invalidate()
    # call. A memo keyed on anything other than config identity would answer
    # True here from a generation that no longer exists.
    monkeypatch.setattr(settings, '_config', {'modelParams': {'families': []}}, raising=False)
    assert model_params.accepts_reasoning_effort('brand-new-model') is False
