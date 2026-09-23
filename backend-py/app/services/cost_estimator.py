"""Session cost estimation (USD) from token totals + model pricing.

Pricing resolves in a fixed order, and the answer reports how sure it is:

1. ``AUGUST_PRICE_IN_PER_M`` / ``AUGUST_PRICE_OUT_PER_M`` — flat override.
2. The model's own configured ``priceInPerM`` / ``priceOutPerM`` (Model
   settings → edit model). Exact: somebody typed this number.
3. The model's ``free`` flag → $0. Exact. A self-hosted model costs the
   electricity bill, and ``free`` was already stored, badged in the model
   list and used to rank the picker while nothing priced from it.
4. The family table below — public list prices matched by id substring.
   Approximate, and now labelled as such.
5. No match at all: the default pair, also labelled approximate.

``estimated`` is the difference between rendering "$0.41" and "~$0.41".
Steps 4 and 5 are guesses about somebody else's price sheet; a display that
cannot tell them apart from steps 2 and 3 presents a guess as a bill.

Used by BOTH the workbench spend-ceiling gate and the usage endpoint's
``totalCost`` — one source of truth so the composer chip, the ceiling, and
the Usage page agree.

Known approximation kept deliberately: cache-hit input bills at 10% of the
input rate, which is Anthropic's discount shape. OpenAI-family cached input
is discounted far less, so a cache-heavy GPT session reads cheap here.
Fixing that means a per-model cache rate, which is a wider change than a
pricing readout deserves — and it lands inside the ``estimated`` flag.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass

# (model-id substrings, input $/1M, output $/1M) — descending specificity so
# the first match wins. Rates are public list prices, best-effort: anything
# resolved from this table is reported as `estimated`.
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


@dataclass(frozen=True)
class ModelPrice:
    """A resolved price plus a statement of where it came from."""

    in_per_m: float
    out_per_m: float
    estimated: bool
    source: str  # env | model | free | table | unknown


# providers.json is read once per change, not once per priced token: the usage
# endpoint sums cost across up to 500 events and config_service.getProvidersStore()
# re-reads the file on every call. The stamp is (mtime_ns, size) validated the
# way getConfig() does it, so an external edit propagates immediately instead of
# serving a TTL of stale prices.
_index: dict[str, tuple[float | None, float | None, bool]] = {}
_indexStamp: tuple[int, int] | None = None


def invalidate_price_cache() -> None:
    """Drop the parsed price index. Called on provider-store saves so a
    just-saved price is visible on the next read without waiting for the
    filesystem stamp to move."""
    global _index, _indexStamp
    _index = {}
    _indexStamp = None


def parse_stored_price(raw: object) -> float | None:
    """A usable stored price, or None for 'not set'.

    0.0 is a value, not an absence — it means the host charges nothing, which
    is exactly what a local model does, and coercing it through `or None`
    would turn every free model back into a table guess. Negative, NaN,
    infinite and non-numeric values are refused rather than billed.

    Public because the provider read path rebuilds ``ModelConfig`` field by
    field and must agree with this module on what "a price" means.
    """
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        try:
            value = float(raw)
        except (TypeError, ValueError, OverflowError):
            return None
        return value if math.isfinite(value) and value >= 0 else None
    return None


def _configuredPrices() -> dict[str, tuple[float | None, float | None, bool]]:
    from app.lib.paths import dataPath

    path = dataPath('providers.json')
    try:
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return {}
    global _index, _indexStamp
    if _indexStamp == stamp:
        return _index

    built: dict[str, tuple[float | None, float | None, bool]] = {}
    try:
        raw = json.loads(path.read_text('utf-8'))
    except Exception:
        raw = None  # a missing or corrupt store simply means no configured prices
    if isinstance(raw, dict):
        providers = raw.get('providers')
        if isinstance(providers, list):
            for prov in providers:
                if not isinstance(prov, dict):
                    continue
                models = prov.get('models')
                if not isinstance(models, list):
                    continue
                for m in models:
                    if not isinstance(m, dict):
                        continue
                    mid = str(m.get('id') or '').strip()
                    if not mid:
                        continue
                    entry = (
                        parse_stored_price(m.get('priceInPerM')),
                        parse_stored_price(m.get('priceOutPerM')),
                        bool(m.get('free')),
                    )
                    prev = built.get(mid)
                    # One id can legitimately sit under two providers. Keep the
                    # informative entry rather than whichever one file order
                    # happens to reach first.
                    if prev is None or _specificity(entry) > _specificity(prev):
                        built[mid] = entry
    _index, _indexStamp = built, stamp
    return built


def _specificity(entry: tuple[float | None, float | None, bool]) -> int:
    if entry[0] is not None or entry[1] is not None:
        return 2
    return 1 if entry[2] else 0


def _tableRates(model_id: str) -> tuple[float, float, str]:
    lower = (model_id or '').lower()
    for prefixes, in_rate, out_rate in _MODEL_PRICES:
        if any(p in lower for p in prefixes):
            return (in_rate, out_rate, 'table')
    return (_DEFAULT_IN_PER_M, _DEFAULT_OUT_PER_M, 'unknown')


def price_for_model(model_id: str) -> ModelPrice:
    """The price to bill ``model_id`` at, and whether it is a guess."""
    try:
        env_in = os.environ.get('AUGUST_PRICE_IN_PER_M')
        env_out = os.environ.get('AUGUST_PRICE_OUT_PER_M')
        if env_in or env_out:
            in_rate = float(env_in) if env_in else _DEFAULT_IN_PER_M
            out_rate = float(env_out) if env_out else _DEFAULT_OUT_PER_M
            return ModelPrice(in_rate, out_rate, False, 'env')
    except (TypeError, ValueError):
        pass  # a malformed override falls through to the real sources

    configured = _configuredPrices().get(str(model_id or '').strip())
    if configured is not None:
        conf_in, conf_out, free = configured
        if conf_in is None and conf_out is None and free:
            return ModelPrice(0.0, 0.0, False, 'free')
        if conf_in is not None or conf_out is not None:
            table_in, table_out, _src = _tableRates(model_id)
            return ModelPrice(
                conf_in if conf_in is not None else table_in,
                conf_out if conf_out is not None else table_out,
                # Half-set is still half-guessed.
                conf_in is None or conf_out is None,
                'model',
            )

    in_rate, out_rate, source = _tableRates(model_id)
    return ModelPrice(in_rate, out_rate, True, source)


def session_cost_estimate(
    model_id: str,
    total_in: int,
    total_out: int,
    cache_hit: int = 0,
    cache_miss: int = 0,
) -> tuple[float, bool]:
    """``(usd, estimated)`` — the spend for these tokens and how sure we are."""
    price = price_for_model(model_id)
    if cache_hit + cache_miss > 0:
        billed_in = cache_miss + cache_hit * 0.1
    else:
        billed_in = total_in
    usd = (billed_in / 1e6 * price.in_per_m) + (total_out / 1e6 * price.out_per_m)
    return usd, price.estimated


def session_cost_usd(
    model_id: str,
    total_in: int,
    total_out: int,
    cache_hit: int = 0,
    cache_miss: int = 0,
) -> float:
    """Estimated cumulative spend (USD) for token totals.

    Cache-hit input tokens bill at 10% of the input rate when the cache split
    is known; otherwise all input bills at the full rate.
    """
    return session_cost_estimate(model_id, total_in, total_out, cache_hit, cache_miss)[0]
