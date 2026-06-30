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
logger = logging.getLogger(__name__)
_CHARSPerTokenHeuristic = 3.5
_CRITICALThresholdHeuristic = 0.85
_CRITICALThresholdDefault = 0.9

def estimateTokens(text: str, model: str | None=None, provider: str | None=None) -> int:
    """Estimate the number of tokens in ``text``.

    Uses the highest-accuracy tokenizer available for the given model/provider.
    Falls back to a 3.5-char-per-token heuristic when no model-specific
    tokenizer is available.
    """
    if not text:
        return 0
    if provider and provider.lower() in ('anthropic', 'anthropic-compatible'):
        return _anthropicTokens(text)
    if model and _isOpenaiModel(model):
        return _openaiTokens(text, model)
    if model and _isGeminiModel(model):
        return _geminiTokens(text, model)
    return _heuristicTokens(text)

def getCriticalThreshold(model: str | None=None, provider: str | None=None) -> float:
    """Return the critical attention-pressure threshold.

    Returns 90% when an accurate tokenizer is available (Anthropic/OpenAI),
    85% when using the heuristic fallback.
    """
    if provider and provider.lower() in ('anthropic', 'anthropic-compatible'):
        return _CRITICALThresholdDefault
    if model and (_isOpenaiModel(model) or _isGeminiModel(model)):
        return _CRITICALThresholdDefault
    return _CRITICALThresholdHeuristic

def computeBudget(messages: list[dict[str, object]] | str, model: str | None=None, provider: str | None=None, maxContext: int=200000) -> dict[str, object]:
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
        text = _flattenMessages(messages)
    total = estimateTokens(text, model, provider)
    remaining = max(0, maxContext - total)
    pct = total / maxContext * 100 if maxContext > 0 else 0
    threshold = getCriticalThreshold(model, provider)
    if pct >= threshold * 100:
        pressure = 'critical'
    elif pct >= 75:
        pressure = 'high'
    elif pct >= 50:
        pressure = 'medium'
    else:
        pressure = 'low'
    tokenizer = 'heuristic'
    if provider and provider.lower() in ('anthropic', 'anthropic-compatible'):
        tokenizer = 'anthropic_sdk'
    elif model and _isOpenaiModel(model):
        tokenizer = 'tiktoken'
    elif model and _isGeminiModel(model):
        tokenizer = 'gemini'
    return {'context_used_pct': round(pct, 1), 'remaining_tokens': remaining, 'attention_pressure': pressure, 'total_tokens': total, 'max_context': maxContext, 'tokenizer': tokenizer}

def _anthropicTokens(text: str) -> int:
    """Count tokens using the Anthropic SDK."""
    try:
        from anthropic import Anthropic
        client = Anthropic(api_key='dummy')
        return client.count_tokens(text)
    except ImportError:
        logger.debug('anthropic SDK not available, falling back to heuristic')
        return _heuristicTokens(text)
    except Exception as exc:
        logger.debug('anthropic count_tokens failed: %s', exc)
        return _heuristicTokens(text)

def _openaiTokens(text: str, model: str) -> int:
    """Count tokens using tiktoken."""
    try:
        import tiktoken
        encodingName = _getTiktokenEncoding(model)
        enc = tiktoken.get_encoding(encodingName)
        return len(enc.encode(text))
    except ImportError:
        logger.debug('tiktoken not available, falling back to heuristic')
        return _heuristicTokens(text)
    except Exception as exc:
        logger.debug('tiktoken failed for %s: %s', model, exc)
        return _heuristicTokens(text)

def _geminiTokens(text: str, model: str) -> int:
    """Count tokens for Gemini models."""
    try:
        from tokenizers import Tokenizer
        tokenizer = Tokenizer.from_pretrained('google/gemma-tokenizer')
        return len(tokenizer.encode(text))
    except ImportError:
        logger.debug('tokenizers library not available, falling back to heuristic')
        return _heuristicTokens(text)
    except Exception as exc:
        logger.debug('gemini tokenizer failed: %s', exc)
        return _heuristicTokens(text)

def _heuristicTokens(text: str) -> int:
    """Fallback: 3.5 characters per token."""
    return max(1, int(len(text) / _CHARSPerTokenHeuristic))

def _isOpenaiModel(model: str) -> bool:
    modelLower = model.lower()
    return any((modelLower.startswith(p) for p in ('gpt-', 'o1-', 'o3-', 'o4-')))

def _isGeminiModel(model: str) -> bool:
    modelLower = model.lower()
    return 'gemini' in modelLower or 'gemma' in modelLower

def _getTiktokenEncoding(model: str) -> str:
    """Return the tiktoken encoding name for a given model."""
    modelLower = model.lower()
    if 'gpt-4' in modelLower or 'gpt-3.5' in modelLower:
        return 'cl100k_base'
    if 'o1' in modelLower or 'o3' in modelLower or 'o4' in modelLower:
        return 'o200k_base'
    if 'gpt-4o' in modelLower:
        return 'o200k_base'
    return 'cl100k_base'

def _flattenMessages(messages: list[dict[str, object]]) -> str:
    """Flatten a list of chat messages into a single text string."""
    parts: list[str] = []
    for msg in messages:
        role = msg.get('role', '')
        content = msg.get('content', '')
        if isinstance(content, str):
            parts.append(f'{role}: {content}')
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    btype = block.get('type', '')
                    if btype == 'text':
                        parts.append(f"{role}: {block.get('text', '')}")
                    elif btype == 'tool_result':
                        parts.append(str(block.get('content', '')))
                    elif btype == 'tool_use':
                        parts.append(f"{role}: {block.get('name', '')}")
        else:
            parts.append(str(content))
    return '\n'.join(parts)