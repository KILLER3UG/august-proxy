"""
Model param families — one data table for per-model wire capabilities.

The workbench asks three questions about a model before it builds a request:
may I send ``reasoning_effort``, may I send Anthropic ``thinking.budget_tokens``,
and what effort level should this model get by default. Until now the first two
were answered by substring tuples buried in two different modules
(``effort.model_likely_accepts_reasoning_effort`` and
``providers._claude_supports_extended_thinking_by_id``) and the third was a
stub. Adding a gateway family meant editing code, which is exactly the
per-model manual-toggle dance the model-settings UI exists to avoid.

This module makes the answer data. A family is a name, the id substrings that
identify it, the wire capabilities it accepts, and optional effort defaults.
Built-in families reproduce the previous heuristics exactly (see
tests/test_model_params_parity.py); operators add or override families in
``config.json`` under ``modelParams.families`` without a code change.

Precedence, highest first:

1. the per-model setting from Model settings (``supportsReasoningEffort`` etc.)
2. a config-declared family
3. a built-in family
4. False — never guess an unsupported key onto the wire
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

__all__ = [
    'FAMILY_RULES',
    'FamilySpec',
    'accepts_reasoning_effort',
    'all_families',
    'family_for',
    'parse_family',
    'supports_extended_thinking',
    'to_public',
]

_VALID_EFFORT = re.compile(r'^(low|medium|high|max)$')


@dataclass(frozen=True)
class FamilySpec:
    """One model family and what its wire format accepts.

    ``tokens`` are matched as substrings against the lowercased model id, which
    is how the heuristics this replaces worked. ``excludes`` wins over
    ``tokens`` so a family can carve out generations that reject a feature.
    """

    id: str
    tokens: tuple[str, ...]
    reasoning_effort: bool = False
    extended_thinking: bool = False
    excludes: tuple[str, ...] = ()
    #: None means "no opinion" — the session/user choice still decides. Only a
    #  family that genuinely documents a default should set it, so the built-ins
    #  do not, and adopting this table cannot change an existing request.
    default_effort: str | None = None
    max_effort: str | None = None
    source: str = field(default='builtin', compare=False)

    def matches(self, model_id: str) -> bool:
        mid = (model_id or '').lower()
        if not mid:
            return False
        if any(x in mid for x in self.excludes):
            return False
        return any(token in mid for token in self.tokens)


# Faithful extraction of the two previous heuristics. Two ids that used to be
# decided by provider *name* (openai/deepseek/xai/grok) are also id families,
# so an id-only lookup still answers "yes" for them; provider-name handling
# stays where it is, because it is a property of the endpoint, not the model.
_BUILTIN_FAMILIES: tuple[FamilySpec, ...] = (
    FamilySpec(
        id='openai-reasoning',
        tokens=('o1', 'o3', 'o4', 'gpt-5', 'reasoning'),
        reasoning_effort=True,
    ),
    FamilySpec(
        # `deepseek-reasoner` and the V/R line; `thinking`/`reasoner` suffixes
        # show up across OpenAI-compatible hosts that mirror the parameter.
        id='deepseek',
        tokens=('deepseek', 'reasoner'),
        reasoning_effort=True,
    ),
    FamilySpec(
        id='qwen-thinking',
        tokens=('qwen3', 'qwq', 'thinking'),
        reasoning_effort=True,
    ),
    FamilySpec(id='glm', tokens=('glm-4', 'glm-5'), reasoning_effort=True),
    FamilySpec(id='kimi', tokens=('kimi-k2',), reasoning_effort=True),
    FamilySpec(id='grok', tokens=('grok-3', 'grok-4'), reasoning_effort=True),
    FamilySpec(id='nemotron', tokens=('nemotron',), reasoning_effort=True),
    FamilySpec(
        id='claude-extended-thinking',
        tokens=('claude',),
        extended_thinking=True,
        # Generations the Anthropic API rejects `thinking` on.
        excludes=(
            'claude-3-5', 'claude-3.5', 'claude-3-haiku', 'claude-3-opus',
            'claude-3-sonnet', 'claude-instant', 'claude-2',
        ),
    ),
)

#: (id(config-object), parsed families). One value carries both the parse and
#: the identity it was parsed from, so nothing can disagree with anything else.
_loaded_config: tuple[int, tuple[FamilySpec, ...]] | None = None
_cache: dict[str, tuple[int, FamilySpec | None]] = {}


def _from_config() -> tuple[FamilySpec, ...]:
    """Operator-declared families from config.json:modelParams.families.

    Cached against the identity of the settings dict, so `settings.reload()`
    (a different object) reparses without an explicit invalidate. A missing or
    non-dict config yields no families — the built-ins still answer, because a
    broken config file must not break every request.
    """
    global _loaded_config
    try:
        from app.config import settings

        raw = settings.config
    except Exception:
        logger.debug('model_params: config unavailable, using built-ins only', exc_info=True)
        return ()
    stamp = id(raw) if isinstance(raw, dict) else 0
    if _loaded_config is not None and _loaded_config[0] == stamp:
        return _loaded_config[1]
    section = raw.get('modelParams') if isinstance(raw, dict) else None
    entries = section.get('families') if isinstance(section, dict) else None
    # Malformed entries are skipped one at a time: a typo in one family must
    # not disable the others.
    parsed = tuple(spec for spec in map(parse_family, entries or []) if spec is not None)
    _loaded_config = (stamp, parsed)
    return parsed


def parse_family(entry: object) -> FamilySpec | None:
    if isinstance(entry, str):
        try:
            entry = json.loads(entry)
        except ValueError:
            return None
    if not isinstance(entry, dict):
        return None
    name = str(entry.get('id') or '').strip()
    tokens = entry.get('tokens') or entry.get('match')
    if not name or not isinstance(tokens, list) or not tokens:
        return None
    default_effort = str(entry.get('defaultEffort') or '').strip().lower() or None
    max_effort = str(entry.get('maxEffort') or '').strip().lower() or None
    for value in (default_effort, max_effort):
        if value and not _VALID_EFFORT.match(value):
            logger.warning('model_params: family %s has invalid effort %r', name, value)
            return None
    return FamilySpec(
        id=name,
        tokens=tuple(str(t).lower() for t in tokens if str(t).strip()),
        reasoning_effort=bool(entry.get('reasoningEffort')),
        extended_thinking=bool(entry.get('extendedThinking')),
        excludes=tuple(str(t).lower() for t in (entry.get('excludes') or []) if str(t).strip()),
        default_effort=default_effort,
        max_effort=max_effort,
        source='config',
    )


def all_families() -> tuple[FamilySpec, ...]:
    """Operator families first, and a same-id operator entry replaces the
    built-in rather than sitting in front of it.

    Ordering alone is not an override: with both in the list, a model that the
    operator entry deliberately excluded still fell through to the built-in and
    got the built-in's answer. Replacing by id is what lets an entry narrow a
    family (drop a generation, take away a capability), and the Settings editor
    copies the built-in row when you override it, so the tokens come along.
    """
    configured = _from_config()
    replaced = {spec.id for spec in configured}
    return configured + tuple(spec for spec in _BUILTIN_FAMILIES if spec.id not in replaced)


#: What a family entry has to look like. Used by the Settings API's 400 so the
#: operator sees the rule that failed rather than an index into nothing.
FAMILY_RULES = (
    'a family needs a non-empty "id", a non-empty "tokens" list of substrings to '
    'match in the model id, optional "excludes", and effort values of '
    'low|medium|high|max'
)


def to_public(spec: FamilySpec) -> dict[str, object]:
    """The JSON shape config.json takes (and the Settings UI edits)."""
    return {
        'id': spec.id,
        'tokens': list(spec.tokens),
        'excludes': list(spec.excludes),
        'reasoningEffort': spec.reasoning_effort,
        'extendedThinking': spec.extended_thinking,
        'defaultEffort': spec.default_effort,
        'maxEffort': spec.max_effort,
        'source': spec.source,
    }


def invalidate() -> None:
    """Drop memos. Call after editing modelParams so a running app picks it up."""
    global _loaded_config
    _cache.clear()
    _loaded_config = None


def family_for(model_id: str) -> FamilySpec | None:
    """The first family whose tokens match `model_id`, or None."""
    key = (model_id or '').lower()
    if not key:
        return None
    stamp = _stamp()
    cached = _cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    # The lookup stamp is read live (see _stamp), and the stored one is read
    # again after resolving families, so a config that changed mid-call cannot
    # be pinned under the old key.
    match = next((family for family in all_families() if family.matches(key)), None)
    _cache[key] = (_stamp(), match)
    return match


def _stamp() -> int:
    """Identity of the config the memos must be validated against.

    Read live from settings rather than from what this module last parsed: a
    stamp taken from the previous parse can only ever agree with itself, so it
    cannot detect the reload it exists to notice. Cheap — one property read,
    no reparse (that is what `_loaded_config` is for).
    """
    try:
        from app.config import settings

        raw = settings.config
    except Exception:
        return 0
    return id(raw) if isinstance(raw, dict) else 0


def accepts_reasoning_effort(model_id: str) -> bool:
    family = family_for(model_id)
    return bool(family and family.reasoning_effort)


def supports_extended_thinking(model_id: str) -> bool:
    family = family_for(model_id)
    return bool(family and family.extended_thinking)
