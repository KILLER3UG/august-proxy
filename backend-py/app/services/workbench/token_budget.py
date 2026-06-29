"""
Token estimation — measures context usage for cognitive budgeting (Phase 2).

Provides ``estimate_tokens()`` with a priority chain:
1. Anthropic models → ``anthropic`` SDK ``count_tokens()`` (authoritative)
2. OpenAI models → ``tiktoken``
3. Gemini models → ``tokenizers`` library if available, else 3.5-char heuristic
4. All other providers → 3.5-char-per-token heuristic

When using the heuristic fallback, the critical threshold is set to 85%
instead of the default 90% to provide a safety buffer.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ── Fallback heuristic ──────────────────────────────────────────────────

_CHARS_PER_TOKEN_HEURISTIC = 3.5
_CRITICAL_THRESHOLD_HEURISTIC = 0.85  # 85% when using heuristic
_CRITICAL_THRESHOLD_DEFAULT = 0.90     # 90% with accurate tokenizer


# ── Public API ──────────────────────────────────────────────────────────


def estimate_tokens(text: str, model: str | None = None, provider: str | None = None) -> int:
    """Estimate the number of tokens in ``text``.

    Uses the highest-accuracy tokenizer available for the given model/provider.
    Falls back to a 3.5-char-per-token heuristic when no model-specific
    tokenizer is available.
    """
    if not text:
        return 0

    # Priority 1: Anthropic models
    if provider and provider.lower() in ("anthropic", "anthropic-compatible"):
        return _anthropic_tokens(text)

    # Priority 2: OpenAI models (or any model name that starts with gpt/o)
    if model and _is_openai_model(model):
        return _openai_tokens(text, model)

    # Priority 3: Gemini models
    if model and _is_gemini_model(model):
        return _gemini_tokens(text, model)

    # Priority 4: fallback heuristic
    return _heuristic_tokens(text)


def get_critical_threshold(model: str | None = None, provider: str | None = None) -> float:
    """Return the critical attention-pressure threshold.

    Returns 90% when an accurate tokenizer is available (Anthropic/OpenAI),
    85% when using the heuristic fallback.
    """
    if provider and provider.lower() in ("anthropic", "anthropic-compatible"):
        return _CRITICAL_THRESHOLD_DEFAULT
    if model and (_is_openai_model(model) or _is_gemini_model(model)):
        return _CRITICAL_THRESHOLD_DEFAULT
    return _CRITICAL_THRESHOLD_HEURISTIC


def compute_budget(
    messages: list[dict[str, Any]] | str,
    model: str | None = None,
    provider: str | None = None,
    max_context: int = 200000,
) -> dict[str, Any]:
    """Compute a full cognitive budget dict for a conversation or text.

    Returns:
        {
            "context_used_pct": 45.0,
            "remaining_tokens": 110000,
            "attention_pressure": "low" | "medium" | "high" | "critical",
            "total_tokens": 90000,
            "max_context": 200000,
            "tokenizer": "anthropic_sdk" | "tiktoken" | "gemini" | "heuristic",
        }
    """
    if isinstance(messages, str):
        text = messages
    else:
        text = _flatten_messages(messages)

    total = estimate_tokens(text, model, provider)
    remaining = max(0, max_context - total)
    pct = (total / max_context) * 100 if max_context > 0 else 0
    threshold = get_critical_threshold(model, provider)

    if pct >= threshold * 100:
        pressure = "critical"
    elif pct >= 75:
        pressure = "high"
    elif pct >= 50:
        pressure = "medium"
    else:
        pressure = "low"

    # Detect tokenizer used
    tokenizer = "heuristic"
    if provider and provider.lower() in ("anthropic", "anthropic-compatible"):
        tokenizer = "anthropic_sdk"
    elif model and _is_openai_model(model):
        tokenizer = "tiktoken"
    elif model and _is_gemini_model(model):
        tokenizer = "gemini"

    return {
        "context_used_pct": round(pct, 1),
        "remaining_tokens": remaining,
        "attention_pressure": pressure,
        "total_tokens": total,
        "max_context": max_context,
        "tokenizer": tokenizer,
    }


# ── Tokenizer implementations ───────────────────────────────────────────


def _anthropic_tokens(text: str) -> int:
    """Count tokens using the Anthropic SDK."""
    try:
        from anthropic import Anthropic

        client = Anthropic(api_key="dummy")  # count_tokens doesn't need a real key
        return client.count_tokens(text)
    except ImportError:
        logger.debug("anthropic SDK not available, falling back to heuristic")
        return _heuristic_tokens(text)
    except Exception as exc:
        logger.debug("anthropic count_tokens failed: %s", exc)
        return _heuristic_tokens(text)


def _openai_tokens(text: str, model: str) -> int:
    """Count tokens using tiktoken."""
    try:
        import tiktoken

        encoding_name = _get_tiktoken_encoding(model)
        enc = tiktoken.get_encoding(encoding_name)
        return len(enc.encode(text))
    except ImportError:
        logger.debug("tiktoken not available, falling back to heuristic")
        return _heuristic_tokens(text)
    except Exception as exc:
        logger.debug("tiktoken failed for %s: %s", model, exc)
        return _heuristic_tokens(text)


def _gemini_tokens(text: str, model: str) -> int:
    """Count tokens for Gemini models."""
    try:
        from tokenizers import Tokenizer

        # Use a compatible tokenizer — Gemini shares tokenizer space with
        # multilingual models. If a specific Gemini tokenizer isn't installed,
        # fall through to heuristic.
        tokenizer = Tokenizer.from_pretrained("google/gemma-tokenizer")
        return len(tokenizer.encode(text))
    except ImportError:
        logger.debug("tokenizers library not available, falling back to heuristic")
        return _heuristic_tokens(text)
    except Exception as exc:
        logger.debug("gemini tokenizer failed: %s", exc)
        return _heuristic_tokens(text)


def _heuristic_tokens(text: str) -> int:
    """Fallback: 3.5 characters per token."""
    return max(1, int(len(text) / _CHARS_PER_TOKEN_HEURISTIC))


# ── Helpers ─────────────────────────────────────────────────────────────


def _is_openai_model(model: str) -> bool:
    model_lower = model.lower()
    return any(model_lower.startswith(p) for p in ("gpt-", "o1-", "o3-", "o4-"))


def _is_gemini_model(model: str) -> bool:
    model_lower = model.lower()
    return "gemini" in model_lower or "gemma" in model_lower


def _get_tiktoken_encoding(model: str) -> str:
    """Return the tiktoken encoding name for a given model."""
    model_lower = model.lower()
    if "gpt-4" in model_lower or "gpt-3.5" in model_lower:
        return "cl100k_base"
    if "o1" in model_lower or "o3" in model_lower or "o4" in model_lower:
        return "o200k_base"
    if "gpt-4o" in model_lower:
        return "o200k_base"
    return "cl100k_base"


def _flatten_messages(messages: list[dict[str, Any]]) -> str:
    """Flatten a list of chat messages into a single text string."""
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            parts.append(f"{role}: {content}")
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    btype = block.get("type", "")
                    if btype == "text":
                        parts.append(f"{role}: {block.get('text', '')}")
                    elif btype == "tool_result":
                        parts.append(str(block.get("content", "")))
                    elif btype == "tool_use":
                        parts.append(f"{role}: {block.get('name', '')}")
        else:
            parts.append(str(content))
    return "\n".join(parts)
