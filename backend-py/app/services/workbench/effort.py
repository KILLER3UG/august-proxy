"""
Effort / thinking-budget helpers for workbench chat.

Maps August's 4-level effort (low | medium | high | max) to:
- Anthropic thinking budget tokens
- System-prompt instructions
- OpenAI reasoning_effort values

Extracted from workbench.py for Phase 3 modularization.
"""

from __future__ import annotations

from typing import Protocol

from app.json_narrowing import as_str

_VALID_EFFORTS = frozenset({'low', 'medium', 'high', 'max'})


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


def effort_to_thinking_budget(effort: str, model_max: int = 32000, max_tokens: int = 8192) -> int:
    """Map effort to Anthropic thinking budget tokens."""
    mapping = {
        'low': min(4096, max_tokens),
        'medium': min(8192, max_tokens),
        'high': min(16000, max_tokens),
        'max': min(model_max, max_tokens * 2),
    }
    return mapping.get(effort, 8192)


def effort_to_prompt_instruction(effort: str) -> str:
    """Map effort to a system-prompt instruction."""
    instructions = {
        'low': 'Provide quick, concise responses. Minimize analysis.',
        'medium': 'Provide balanced responses with moderate analysis.',
        'high': 'Provide thorough, detailed analysis. Take your time.',
        'max': 'Provide exhaustive, comprehensive analysis. Leave nothing out.',
    }
    return instructions.get(effort, instructions['medium'])


def effort_to_openai_reasoning_effort(effort: str) -> str:
    """Map August's 4-level effort to OpenAI's 3-level reasoning_effort."""
    mapping = {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'high'}
    return mapping.get(effort, 'medium')
