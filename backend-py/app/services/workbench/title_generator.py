"""LLM session title generation after the first user→assistant exchange.

The sidebar used to stamp the raw first user message as the title. That
reads poorly for long prompts. Instead we:

1. Leave the placeholder title ("Chat YYYY-MM-DD …") while the first turn runs
2. After the first assistant reply lands, ask a cheap LLM for a 3–7 word title
3. Fall back to a truncated first-message snippet if the LLM call fails
4. Never overwrite a title the user already set (or a prior auto-title)
"""

from __future__ import annotations

import asyncio
import logging
import re

from app.json_narrowing import as_dict, as_list, as_str

logger = logging.getLogger(__name__)

_TITLE_SYSTEM = (
    'Generate a short, descriptive title (3-7 words) for a conversation that '
    'starts with the following exchange. Capture the main topic or intent. '
    'Write the title in the same language the user is writing in. '
    'Return ONLY the title text — no quotes, no trailing punctuation, '
    'no "Title:" prefix, no markdown.'
)

_THINK_RE = re.compile(
    r'<think(?:ing)?\b[^>]*>.*?</think(?:ing)?>',
    re.IGNORECASE | re.DOTALL,
)


def message_plain_text(msg: dict[str, object] | None) -> str:
    """Flatten a chat message's content to plain text."""
    if not msg:
        return ''
    content = msg.get('content', '')
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = as_str(block.get('type'))
            if btype in ('text', 'finalOutput', ''):
                text = as_str(block.get('text') or block.get('content'))
                if text:
                    parts.append(text)
        return '\n'.join(parts).strip()
    return ''


def first_exchange_texts(
    messages: list[dict[str, object]],
) -> tuple[str, str] | None:
    """Return (user_text, assistant_text) for the first exchange, or None."""
    user_text = ''
    assistant_text = ''
    for msg in messages:
        role = as_str(msg.get('role'))
        if role == 'user' and not user_text:
            user_text = message_plain_text(msg)
        elif role == 'assistant' and user_text and not assistant_text:
            assistant_text = message_plain_text(msg)
            break
    if not user_text or not assistant_text:
        return None
    return user_text, assistant_text


def count_user_messages(messages: list[dict[str, object]]) -> int:
    return sum(1 for m in messages if as_str(m.get('role')) == 'user')


def sanitize_generated_title(raw: str, *, max_len: int = 60) -> str:
    """Clean LLM output into a sidebar-safe title."""
    title = (raw or '').strip()
    if not title:
        return ''
    title = _THINK_RE.sub('', title).strip()
    # Keep the first non-empty line only
    for line in title.splitlines():
        line = line.strip()
        if line:
            title = line
            break
    if title.lower().startswith('title:'):
        title = title[6:].strip()
    title = title.strip().strip('"\'“”‘’`').strip()
    # Drop trailing sentence punctuation the model sometimes adds
    title = re.sub(r'[.!?…]+$', '', title).strip()
    title = title.strip('"\'“”‘’`').strip()
    title = re.sub(r'\s+', ' ', title)
    if len(title) < 2:
        return ''
    if len(title) > max_len:
        title = title[: max_len - 1].rstrip() + '…'
    return title


async def _llm_title(
    user_message: str,
    assistant_response: str,
    *,
    provider: dict[str, object] | None,
    model: str,
) -> str:
    """Ask the provider for a short title. Returns '' on any failure."""
    if not provider or not model:
        return ''
    try:
        from app.providers.clients import getClient

        client = getClient(provider)
        if not client:
            return ''
        api_key = client.resolveApiKey()
        if not api_key:
            return ''

        user_snippet = (user_message or '')[:500]
        asst_snippet = (assistant_response or '')[:500]
        body: dict[str, object] = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': _TITLE_SYSTEM},
                {
                    'role': 'user',
                    'content': f'User: {user_snippet}\n\nAssistant: {asst_snippet}',
                },
            ],
            'max_tokens': 48,
            'temperature': 0.3,
        }
        # Prefer non-streaming chat completions when available.
        if hasattr(client, 'chat_completions'):
            resp = await client.chat_completions(body)
            body_json = getattr(resp, 'body_json', None) or getattr(resp, 'body', None) or {}
            if not isinstance(body_json, dict):
                return ''
            if getattr(resp, 'is_error', False) or body_json.get('error') is not None:
                return ''
            choices = as_list(body_json.get('choices'), [])
            if not choices:
                return ''
            content = as_dict(as_dict(choices[0]).get('message')).get('content', '')
            if isinstance(content, list):
                content = ' '.join(
                    as_str(b.get('text')) for b in content if isinstance(b, dict)
                )
            return sanitize_generated_title(as_str(content))
    except Exception:
        logger.debug('LLM title call failed', exc_info=True)
    return ''


async def generate_session_title(
    user_message: str,
    assistant_response: str,
    *,
    provider: dict[str, object] | None = None,
    model: str = '',
) -> str:
    """Generate a title; fall back to truncated first-user-message snippet."""
    from app.services.workbench.sessions import derive_title_from_message

    title = await _llm_title(
        user_message,
        assistant_response,
        provider=provider,
        model=model,
    )
    if title:
        return title
    return derive_title_from_message(user_message) or ''


async def maybe_auto_title_after_turn(
    session_id: str,
    messages: list[dict[str, object]],
    *,
    provider: dict[str, object] | None = None,
    model: str = '',
) -> str | None:
    """Generate + apply a title after the first exchange. Returns new title or None.

    Safe to call fire-and-forget. Skips when:
    - not the first user turn
    - title is no longer a placeholder (user renamed / already titled)
    - exchange texts are missing
    """
    from app.services.workbench.sessions import (
        get_workbench_session,
        is_placeholder_title,
        rename_workbench_session,
    )

    sid = (session_id or '').strip()
    if not sid:
        return None

    # First exchange only (allow a tiny bit of slack for steer/queue edge cases).
    if count_user_messages(messages) > 2:
        return None

    exchange = first_exchange_texts(messages)
    if not exchange:
        return None
    user_text, assistant_text = exchange

    session = get_workbench_session(sid)
    if not session or not is_placeholder_title(getattr(session, 'title', None)):
        return None

    title = await generate_session_title(
        user_text,
        assistant_text,
        provider=provider,
        model=model,
    )
    if not title:
        return None

    # Re-check before write so a mid-flight manual rename wins.
    session = get_workbench_session(sid)
    if not session or not is_placeholder_title(getattr(session, 'title', None)):
        return None

    renamed = rename_workbench_session(sid, title)
    if renamed:
        logger.info('auto-titled session %s → %r', sid, title)
        return title
    return None


def schedule_auto_title_after_turn(
    session_id: str,
    messages: list[dict[str, object]],
    *,
    provider: dict[str, object] | None = None,
    model: str = '',
) -> None:
    """Fire-and-forget wrapper around ``maybe_auto_title_after_turn``."""

    async def _run() -> None:
        try:
            await maybe_auto_title_after_turn(
                session_id,
                messages,
                provider=provider,
                model=model,
            )
        except Exception:
            logger.debug('auto-title task failed for %s', session_id, exc_info=True)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        # No running loop (sync tests / odd call sites) — run inline best-effort.
        try:
            asyncio.run(_run())
        except Exception:
            logger.debug('auto-title inline failed for %s', session_id, exc_info=True)
