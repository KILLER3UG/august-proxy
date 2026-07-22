"""Canonical provider API format ids + UI/legacy aliases.

The desktop provider form historically sent kebab-case values
(``openai-chat``, ``anthropic``, …) while workbench checks only camelCase
(``openaiChat``, ``anthropicMessages``). Normalize at the boundary so users
never hit "Unsupported API format" after picking a dropdown option.
"""

from __future__ import annotations

# Formats understood by workbench / proxy clients.
# Users paste baseUrl + choose one of these; no first-class Gemini/MiniMax/Bedrock.
VALID_API_FORMATS = frozenset({
    'openaiChat',
    'anthropicMessages',
    'openaiResponses',
    'codexResponses',
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
    # Legacy ids → nearest user-configurable wire format
    'gemini': 'openaiChat',
    'gemini-openai': 'openaiChat',
    'gemini_openai': 'openaiChat',
    'geminiopenai': 'openaiChat',
    'geminiOpenai': 'openaiChat',
    'bedrock': 'openaiChat',
    'bedrock-converse': 'openaiChat',
    'bedrock_converse': 'openaiChat',
    'bedrockconverse': 'openaiChat',
    'bedrockConverse': 'openaiChat',
    'minimax': 'anthropicMessages',
    'minimax-cn': 'anthropicMessages',
    'minimax_cn': 'anthropicMessages',
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
# Longer Anthropic leaves first so ``…/v1/messages`` strips cleanly.
_ENDPOINT_SUFFIXES = (
    '/v1/messages/count_tokens',
    '/v1/messages',
    '/v1/models',
    '/chat/completions',
    '/messages/count_tokens',
    '/messages',
    '/responses',
    '/models',
)


def normalize_provider_base_url(base_url: object | None) -> str:
    """Keep the user's pasted host+prefix; strip only leaf endpoints.

    Never invent ``/v1`` on the base. OpenAI-compatible users include ``/v1``
    in baseUrl when that host needs it. Anthropic format appends ``v1/messages``
    itself — if the paste ends with ``/v1``, that is stripped when building
    Anthropic leaves so it is not doubled.

    Examples kept as-is:
      ``https://opencode.ai/zen/v1``
      ``https://api.kilo.ai/api/gateway``
      ``https://api.openai.com/v1``
      ``https://api.anthropic.com``

    Pasted full URLs lose the leaf only:
      ``…/v1/chat/completions`` → ``…/v1``
      ``…/v1/messages`` → host (``…/v1`` stripped as part of the leaf)
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


def anthropic_host_base(base_url: object | None) -> str:
    """Anthropic/MiniMax host without a trailing ``/v1`` (format adds ``v1/…``)."""
    base = normalize_provider_base_url(base_url) or 'https://api.anthropic.com'
    if base.endswith('/v1'):
        base = base[: -len('/v1')].rstrip('/')
    return base or 'https://api.anthropic.com'


def anthropic_v1_base(base_url: object | None) -> str:
    """Back-compat alias — Anthropic host only (no auto ``/v1``)."""
    return anthropic_host_base(base_url)


def provider_endpoint_url(
    base_url: object | None,
    api_format: object | None = None,
    *,
    kind: str = 'chat',
) -> str:
    """Build the request URL from exactly ``baseUrl`` + API format leaf.

    OpenAI-compatible leaves: ``chat/completions``, ``responses``, ``models``.
    Anthropic leaf includes ``v1``: ``v1/messages``, ``v1/models``, etc.
    Never invents ``/v1`` on the stored base.

    ``kind``: ``chat`` | ``responses`` | ``messages`` | ``models`` | ``count_tokens``
    """
    fmt = normalize_api_format(api_format)
    anthropic_like = is_anthropic_api_format(fmt)

    if anthropic_like:
        host = anthropic_host_base(base_url)
        if kind == 'models':
            return join_provider_url(host, 'v1', 'models')
        if kind == 'count_tokens':
            return join_provider_url(host, 'v1', 'messages', 'count_tokens')
        # messages / chat on anthropic format
        return join_provider_url(host, 'v1', 'messages')

    base = normalize_provider_base_url(base_url)

    if kind == 'models':
        return join_provider_url(base, 'models')

    if kind == 'responses' or fmt in ('openaiResponses', 'codexResponses'):
        return join_provider_url(base, 'responses')

    return join_provider_url(base, 'chat', 'completions')
