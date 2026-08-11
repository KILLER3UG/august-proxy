"""Session cost estimation (USD) from token totals + model pricing.

No provider-native pricing API is available; this module carries a
best-effort per-1M-token price table keyed by model-id prefix, with flat
env overrides (``AUGUST_PRICE_IN_PER_M`` / ``AUGUST_PRICE_OUT_PER_M``) that
win when set. Cache-hit input tokens are billed at 10% of the input rate
(the typical provider caching discount).

Used by BOTH the workbench spend-ceiling gate and the usage endpoint's
``totalCost`` — one source of truth so the composer chip, the ceiling, and
the Usage page agree.
"""

from __future__ import annotations

import os

# (model-id prefixes, input $/1M, output $/1M) — descending specificity so
# the first match wins. Rates are public list prices, best-effort.
_MODEL_PRICES: tuple[tuple[tuple[str, ...], float, float], ...] = (
    (('claude-opus', 'claude-4'), 15.0, 75.0),
    (('claude-sonnet', 'claude-3-5-sonnet'), 3.0, 15.0),
    (('claude-3-7-sonnet',), 3.0, 15.0),
    (('claude-haiku', 'claude-3-5-haiku', 'claude-3-haiku'), 1.0, 5.0),
    (('gpt-5',), 1.25, 10.0),
    (('gpt-4o', 'gpt-4.1', 'gpt-4-turbo'), 2.5, 10.0),
    (('gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4-mini'), 0.15, 0.6),
    (('o1', 'o3', 'o4'), 5.0, 20.0),
    (('deepseek-chat', 'deepseek-v3'), 0.27, 1.1),
    (('deepseek-reasoner', 'deepseek-r1'), 0.55, 2.19),
    (('gemini-2.5-pro',), 1.25, 10.0),
    (('gemini-2.5-flash', 'gemini-flash'), 0.3, 2.5),
    (('llama-3', 'llama-4'), 0.2, 0.8),
    (('qwen',), 0.2, 0.8),
    (('mistral', 'codestral'), 0.2, 0.6),
    (('grok',), 2.0, 10.0),
)

_DEFAULT_IN_PER_M = 3.0
_DEFAULT_OUT_PER_M = 15.0


def price_for_model(model_id: str) -> tuple[float, float]:
    """(input $/1M, output $/1M) for a model id — env overrides win."""
    try:
        env_in = os.environ.get('AUGUST_PRICE_IN_PER_M')
        env_out = os.environ.get('AUGUST_PRICE_OUT_PER_M')
        if env_in:
            return (float(env_in), float(env_out) if env_out else _DEFAULT_OUT_PER_M)
        if env_out:
            return (_DEFAULT_IN_PER_M, float(env_out))
    except (TypeError, ValueError):
        pass
    lower = (model_id or '').lower()
    for prefixes, in_rate, out_rate in _MODEL_PRICES:
        if any(p in lower for p in prefixes):
            return (in_rate, out_rate)
    return (_DEFAULT_IN_PER_M, _DEFAULT_OUT_PER_M)


def session_cost_usd(
    model_id: str,
    total_in: int,
    total_out: int,
    cache_hit: int = 0,
    cache_miss: int = 0,
) -> float:
    """Estimated cumulative spend (USD) for token totals.

    Cache-hit input tokens bill at 10% of the input rate when the cache
    split is known; otherwise all input bills at the full rate.
    """
    in_rate, out_rate = price_for_model(model_id)
    if cache_hit + cache_miss > 0:
        billed_in = cache_miss + cache_hit * 0.1
    else:
        billed_in = total_in
    return (billed_in / 1e6 * in_rate) + (total_out / 1e6 * out_rate)
