"""
Effort / thinking-budget helpers for workbench chat.

Maps August's 4-level effort (low | medium | high | max) to:
- Anthropic thinking budget tokens (a *fraction* of the model's max output)
- System-prompt instructions
- OpenAI reasoning_effort values

``max_tokens`` on the completion request always comes from the **model**
via :func:`app.services.model_service.get_max_output_tokens`. The workbench
does not invent an output ceiling — effort only chooses how much of that
model ceiling may be spent on thinking, always leaving headroom for the
final answer / tool calls.
"""

from __future__ import annotations

from typing import Protocol

from app.json_narrowing import as_bool, as_dict, as_str

_VALID_EFFORTS = frozenset({'low', 'medium', 'high', 'max'})

# Fraction of the *model's* max_output reserved for thinking by effort level.
# Remainder is available for the visible answer + tool_use.
_EFFORT_THINKING_FRACTION: dict[str, float] = {
    'low': 0.05,
    'medium': 0.15,
    'high': 0.35,
    'max': 0.75,
}
# Always keep at least this fraction of model max_output for the answer.
_ANSWER_HEADROOM_FRACTION = 0.25


class EffortSession(Protocol):
    """Minimal session surface needed for effort resolution."""

    metadata: dict[str, object]


def resolve_effective_effort(
    incoming: str | None,
    session: EffortSession,
    model_entry: dict[str, object] | None = None,
) -> str:
    """Resolve the effort level from incoming param, session, or model default."""
    _ = model_entry  # reserved for future model-default overrides
    if incoming and incoming in _VALID_EFFORTS:
        return incoming
    if session.metadata.get('effort') in _VALID_EFFORTS:
        return as_str(session.metadata.get('effort'))
    return 'medium'


def lookup_model_profile(
    provider: dict[str, object] | None,
    model: str,
) -> dict[str, object]:
    """Resolve the best matching modelProfiles entry for ``model``."""
    if not provider:
        return {}
    profiles = as_dict(provider.get('modelProfiles') or provider.get('model_profiles'), {})
    if not profiles:
        return {}
    if model in profiles:
        return as_dict(profiles.get(model))
    model_l = (model or '').lower()
    best_key = ''
    best: dict[str, object] = {}
    for key, val in profiles.items():
        if key == '*' or not isinstance(key, str):
            continue
        if model_l.startswith(str(key).lower()) and len(str(key)) > len(best_key):
            best_key = str(key)
            best = as_dict(val)
    if best_key:
        return best
    return as_dict(profiles.get('*'))


def model_max_output_tokens(
    provider: dict[str, object] | None,
    model: str,
) -> int:
    """Delegate to model_service — output limits live on the model, not workbench."""
    from app.services.model_service import get_max_output_tokens

    return get_max_output_tokens(model, provider)


def effort_to_thinking_budget(
    effort: str,
    model_max: int,
    max_tokens: int | None = None,
) -> int:
    """Map effort to a thinking budget as a fraction of ``model_max``.

    ``model_max`` must be the model's max output tokens. Optional ``max_tokens``
    is a legacy extra cap used by older call sites/tests.
    """
    budget, _ = resolve_completion_limits(effort, max_output_tokens=model_max)
    if max_tokens is not None and max_tokens > 0:
        return min(budget, int(max_tokens))
    return budget


def resolve_completion_limits(
    effort: str,
    *,
    max_output_tokens: int,
) -> tuple[int, int]:
    """Return ``(thinking_budget, max_tokens)`` from the **model** ceiling.

    - ``max_tokens`` = the model's max output (sent upstream unchanged)
    - ``thinking_budget`` = effort fraction of that ceiling, never exceeding
      the reserved answer headroom
    """
    max_tokens = max(1, int(max_output_tokens))
    headroom = max(1, int(max_tokens * _ANSWER_HEADROOM_FRACTION))
    thinking_cap = max(1, max_tokens - headroom)
    frac = _EFFORT_THINKING_FRACTION.get(effort, _EFFORT_THINKING_FRACTION['medium'])
    budget = max(1, min(thinking_cap, int(max_tokens * frac)))
    # Anthropic requires max_tokens > budget_tokens
    if max_tokens <= budget:
        max_tokens = budget + headroom
    return budget, max_tokens


def effort_to_prompt_instruction(effort: str) -> str:
    """Map effort to a system-prompt instruction that scales thinking depth."""
    instructions = {
        'low': (
            'Keep internal reasoning extremely short (a few sentences at most). '
            'Prefer acting or answering quickly. Do not narrate long plans, '
            'restate tool results, or expand chain-of-thought.'
        ),
        'medium': (
            'Use moderate reasoning. Balance speed with enough analysis to be correct; '
            'avoid long thinking digressions and do not restate large tool outputs.'
        ),
        'high': (
            'Think carefully and thoroughly before answering. Prefer deeper analysis '
            'over speed; allow longer internal reasoning when it improves correctness.'
        ),
        'max': (
            'Use maximum reasoning depth. Exhaustive analysis; do not cut thinking short. '
            'Prefer completeness over brevity in internal reasoning.'
        ),
    }
    return instructions.get(effort, instructions['medium'])


def effort_to_openai_reasoning_effort(effort: str) -> str:
    """Map August's 4-level effort to OpenAI's 3-level reasoning_effort."""
    mapping = {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'high'}
    return mapping.get(effort, 'medium')


def provider_accepts_reasoning_effort(
    provider: dict[str, object] | None,
    model: str = '',
) -> bool:
    """Whether attaching ``reasoning_effort`` is likely to be understood.

    Official OpenAI/Codex, DeepSeek, and common reasoner model ids accept it.
    Unknown OpenAI-compatible gateways often reject unknown fields — skip those.
    """
    if not provider:
        return False
    pname = as_str(provider.get('name') or provider.get('id')).lower()
    mid = (model or '').lower()
    api_mode = as_str(provider.get('apiMode') or provider.get('api_mode'))
    if api_mode == 'codexResponses':
        return True
    if any(token in pname for token in ('openai', 'codex', 'deepseek', 'xai', 'grok')):
        return True
    return any(
        token in mid
        for token in (
            'o1',
            'o3',
            'o4',
            'reasoner',
            'deepseek',
            'gpt-5',
            'grok-3',
            'grok-4',
        )
    )


def profile_supports_reasoning(profile: dict[str, object]) -> bool:
    return as_bool(profile.get('supportsThinking')) or as_bool(profile.get('supportsReasoning'))
