"""Canonical provider API format ids + UI/legacy aliases.

The desktop provider form historically sent kebab-case values
(``openai-chat``, ``anthropic``, …) while workbench checks only camelCase
(``openaiChat``, ``anthropicMessages``). Normalize at the boundary so users
never hit "Unsupported API format" after picking a dropdown option.
"""

from __future__ import annotations

# Formats understood by workbench / proxy clients (incl. specialized clients).
VALID_API_FORMATS = frozenset({
    'openaiChat',
    'anthropicMessages',
    'openaiResponses',
    'codexResponses',
    'geminiOpenai',
    'minimax',
    'bedrockConverse',
})

_FORMAT_ALIASES: dict[str, str] = {
    'openai': 'openaiChat',
    'openai-chat': 'openaiChat',
    'openai_chat': 'openaiChat',
    'openaichat': 'openaiChat',
    'chat': 'openaiChat',
    'anthropic': 'anthropicMessages',
    'anthropic-messages': 'anthropicMessages',
    'anthropic_messages': 'anthropicMessages',
    'anthropicmessages': 'anthropicMessages',
    'messages': 'anthropicMessages',
    'openai-responses': 'openaiResponses',
    'openai_responses': 'openaiResponses',
    'openairesponses': 'openaiResponses',
    'responses': 'openaiResponses',
    'codex': 'codexResponses',
    'codex-responses': 'codexResponses',
    'codex_responses': 'codexResponses',
    'codexresponses': 'codexResponses',
    'gemini': 'geminiOpenai',
    'gemini-openai': 'geminiOpenai',
    'gemini_openai': 'geminiOpenai',
    'geminiopenai': 'geminiOpenai',
    'bedrock': 'bedrockConverse',
    'bedrock-converse': 'bedrockConverse',
    'bedrock_converse': 'bedrockConverse',
    'bedrockconverse': 'bedrockConverse',
    'minimax-cn': 'minimax',
    'minimax_cn': 'minimax',
}


def normalize_api_format(api_format: object | None, *, default: str = 'openaiChat') -> str:
    """Map UI/legacy format strings to a canonical apiFormat/apiMode value."""
    raw = str(api_format or '').strip()
    if not raw:
        return default
    if raw in VALID_API_FORMATS:
        return raw
    mapped = _FORMAT_ALIASES.get(raw.lower())
    if mapped:
        return mapped
    # Unknown values: keep default rather than failing closed as "unsupported".
    return default


def is_openai_api_format(api_format: object | None) -> bool:
    return normalize_api_format(api_format) in ('openaiChat', 'openaiResponses', 'codexResponses')


def is_anthropic_api_format(api_format: object | None) -> bool:
    return normalize_api_format(api_format) == 'anthropicMessages'


# Leaf paths the client/format appends — never store these on baseUrl.
_ENDPOINT_SUFFIXES = (
    '/chat/completions',
    '/messages/count_tokens',
    '/messages',
    '/responses',
    '/models',
)


def normalize_provider_base_url(base_url: object | None) -> str:
    """Host + API prefix only (strip leaf endpoints users may paste).

    Examples kept as-is:
      ``https://opencode.ai/zen/v1``
      ``https://api.kilo.ai/api/gateway``
      ``https://api.openai.com/v1``

    Pasted full URLs lose the leaf:
      ``…/v1/chat/completions`` → ``…/v1``
    """
    base = str(base_url or '').strip().rstrip('/')
    if not base:
        return ''
    # Drop query/fragment if someone pasted a browser URL.
    for sep in ('?', '#'):
        if sep in base:
            base = base.split(sep, 1)[0].rstrip('/')
    changed = True
    while changed and base:
        changed = False
        for suffix in _ENDPOINT_SUFFIXES:
            if base.endswith(suffix):
                base = base[: -len(suffix)].rstrip('/')
                changed = True
                break
    return base


def join_provider_url(base_url: object | None, *path_parts: str) -> str:
    """``normalize(base) + /path/parts`` — works for any OpenAI-compatible host."""
    base = normalize_provider_base_url(base_url)
    parts: list[str] = []
    for part in path_parts:
        piece = str(part or '').strip().strip('/')
        if piece:
            parts.append(piece)
    if not base:
        return '/' + '/'.join(parts) if parts else ''
    if not parts:
        return base
    return f'{base}/{"/".join(parts)}'


def anthropic_v1_base(base_url: object | None) -> str:
    """Anthropic Messages base ending in ``/v1`` (never doubled)."""
    base = normalize_provider_base_url(base_url) or 'https://api.anthropic.com'
    if base.endswith('/v1'):
        return base
    return f'{base}/v1'


def provider_endpoint_url(
    base_url: object | None,
    api_format: object | None = None,
    *,
    kind: str = 'chat',
) -> str:
    """Build the request URL from baseUrl + API format.

    ``kind``: ``chat`` | ``responses`` | ``messages`` | ``models`` | ``count_tokens``

    OpenAI-compatible (chat):
      ``https://opencode.ai/zen/v1`` → ``…/v1/chat/completions``
      ``https://api.kilo.ai/api/gateway`` → ``…/gateway/chat/completions``

    Anthropic:
      ``https://api.anthropic.com`` → ``…/v1/messages``
    """
    fmt = normalize_api_format(api_format)
    anthropic_like = is_anthropic_api_format(fmt) or fmt == 'minimax'

    if kind == 'models':
        if anthropic_like:
            return join_provider_url(anthropic_v1_base(base_url), 'models')
        return join_provider_url(base_url, 'models')

    if kind == 'count_tokens' or (kind == 'messages') or (kind == 'chat' and anthropic_like):
        base = anthropic_v1_base(base_url)
        if kind == 'count_tokens':
            return join_provider_url(base, 'messages', 'count_tokens')
        return join_provider_url(base, 'messages')

    if kind == 'responses' or fmt in ('openaiResponses', 'codexResponses'):
        return join_provider_url(base_url, 'responses')

    return join_provider_url(base_url, 'chat', 'completions')
