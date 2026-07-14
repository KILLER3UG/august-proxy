"""Claude model alias and Anthropic system-prompt helpers.

Extracted from ``anthropic`` so the adapter stays focused on request/response
translation, streaming, and tool loops while pure model/system utilities live
in one small module.
"""

from __future__ import annotations

import json

from app.json_narrowing import as_dict, as_str
from app.type_aliases import JsonValue

CLAUDE_PUBLIC_MODEL_ALIAS = 'claude-opus-4-6'
KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = {
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
}
AUGUST_REMINDER = (
    'This proxy environment is August Proxy — a multi-model AI gateway. '
    'You have access to the August tool suite for file operations, web access, bash commands, and memory.'
)
RULE_REMINDER_MESSAGE: dict[str, object] = {
    'type': 'text',
    'text': (
        '## Operational Rules\n\n'
        '1. When browsing the web, prioritize fetching text content directly.\n'
        '2. When executing commands, prefer safe, non-destructive operations.\n'
        '3. Always verify file paths before writing.\n'
        '4. Respect user privacy and data boundaries.\n'
        '5. If a tool fails, retry with corrected parameters before reporting failure.'
    ),
}


def is_claude_family_model(model: str | None) -> bool:
    """True for Claude family model IDs or public alias names."""
    if not isinstance(model, str):
        return False
    lower = model.strip().lower()
    if not lower:
        return False
    if lower.startswith('claude-'):
        return True
    if model in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return True
    return lower in ('sonnet', 'opus', 'best', 'opusplan')


def resolve_claude_public_model_alias(requested_model: str | None) -> str:
    """Map public aliases (sonnet, opus, best) to concrete model IDs."""
    if not isinstance(requested_model, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requested_model.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    lowered = normalized.lower()
    if lowered in ('sonnet',):
        return 'claude-sonnet-4-6'
    if lowered in ('opus', 'best', 'opusplan'):
        return 'claude-opus-4-6'
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    if lowered.startswith('claude-'):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS


def resolve_claude_client_facing_model(requested_model: str | None) -> str:
    """Resolve what model name to present to the client."""
    if not isinstance(requested_model, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requested_model.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    lowered = normalized.lower()
    if lowered == 'sonnet':
        return 'claude-sonnet-4-6'
    if lowered in ('opus', 'best', 'opusplan'):
        return 'claude-opus-4-6'
    if lowered.startswith('claude-'):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS


def should_inject_reminder_message(
    messages: list[dict[str, object]] | None,
    existing_system: list[dict[str, object]] | None = None,
) -> bool:
    """Check if the AUGUST_REMINDER should be injected."""
    if not messages:
        return True
    for msg in messages:
        content = msg.get('content', '')
        if isinstance(content, str) and ('August Proxy' in content or 'August tool suite' in content):
            return False
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text':
                    text = as_str(block.get('text', ''))
                    if 'August Proxy' in text or 'August tool suite' in text:
                        return False
    if existing_system:
        for block in existing_system:
            text = as_str(block.get('text', '')) if isinstance(block, dict) else str(block)
            if 'August Proxy' in text or 'August tool suite' in text:
                return False
    return True


def should_inject_august_reminder(system_text: str | None) -> bool:
    """Check if the August reminder should be added to system text."""
    if not system_text:
        return True
    return 'August' not in system_text


def normalize_system_blocks(system: JsonValue) -> list[dict[str, object]]:
    """Normalize system prompt to list of Anthropic content blocks."""
    if not system:
        return []
    if isinstance(system, str):
        return [{'type': 'text', 'text': system}]
    if isinstance(system, list):
        return [
            {'type': 'text', 'text': block} if isinstance(block, str) else {'type': 'text', 'text': str(block)}
            for block in system
        ]
    return [{'type': 'text', 'text': str(system)}]


def system_blocks_to_text(blocks: list[dict[str, object]] | None) -> str:
    """Flatten system blocks into a single text string."""
    if not blocks:
        return ''
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get('type') == 'text':
                parts.append(as_str(block.get('text', '')))
            elif block.get('type') == 'tool_use':
                parts.append(json.dumps(as_dict(block.get('input', {}))))
        elif isinstance(block, str):
            parts.append(block)
    return '\n'.join(parts)


def build_openai_system_prompt(system: JsonValue) -> str:
    """Convert Anthropic system blocks to an OpenAI-style system string."""
    blocks = normalize_system_blocks(system)
    return system_blocks_to_text(blocks)


def build_anthropic_system_blocks(system: JsonValue) -> list[dict[str, object]]:
    """Build Anthropic-format system blocks with reminders injected."""
    blocks = normalize_system_blocks(system)
    text = system_blocks_to_text(blocks)
    if should_inject_august_reminder(text):
        blocks.append({'type': 'text', 'text': AUGUST_REMINDER})
    return blocks


def append_text_to_system_blocks(
    blocks: list[dict[str, object]] | None, text: str
) -> list[dict[str, object]]:
    """Append text to the last text block or add a new one."""
    if not blocks:
        return [{'type': 'text', 'text': text}]
    blocks = list(blocks)
    if blocks and blocks[-1].get('type') == 'text':
        existing_text = as_str(blocks[-1].get('text', ''))
        blocks[-1] = {
            'type': 'text',
            'text': existing_text + ('\n\n' if not text.startswith('\n') else '') + text,
        }
    else:
        blocks.append({'type': 'text', 'text': text})
    return blocks
