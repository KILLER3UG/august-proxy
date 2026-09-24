"""Durable structured transcript blocks for chat messages (migration 047).

A chat bubble is not a string. It is a block timeline — model reasoning, tool
calls, tool results, harness notices — plus sibling fields the UI reads
(attachments, todos, usage, stop reason…). All of that lived ONLY in the
desktop's localStorage transcript, so restoring a chat from the backend after
a localStorage loss rebuilt it from the flat `messages.content` text: the tool
``{content, tool_calls, tool_use_id, name}`` envelope was stringified into one
opaque bubble and every other structured field was simply gone.

This module is the bridge. ``messages.blocks_json`` holds ONE JSON object per
message with the UI-shaped structured fields, and ``content`` is left exactly
as it was so the ``messages_fts`` content-sync triggers keep indexing the same
text (session search / snippets are unaffected).

Two rules keep this backward compatible:

* ``blocks_json IS NULL`` means "legacy text-only message" — readers fall back
  to ``content`` exactly as before, and nothing claims a structured transcript
  that was never written.
* Block ids are derived from the message content (tool_use ids, block index),
  never from a clock or a random source: the workbench save rewrites the whole
  transcript on every debounce, and an unstable id would rewrite every row
  (and every FTS payload) for no reason.
"""

from __future__ import annotations

import json

# UI-shaped structured fields carried on a chat message. Persisted verbatim
# when the caller supplies them; derived from the model transcript when it
# does not (see derive_blocks).
STRUCTURED_FIELDS: tuple[str, ...] = (
    'blocks',
    'thinking',
    'thinkingDuration',
    'tools',
    'tool',
    'attachments',
    'todos',
    'usage',
    'turnEnd',
    'changedFiles',
    'clarify',
    'kind',
    'commandId',
    'context',
    'breakdown',
    'queued',
    'usedFallback',
    'editHistory',
    'toolCalls',
    'toolUseId',
    'interrupted',
)

# snake_case spellings the workbench transcript actually uses, mapped onto the
# camelCase keys the desktop expects. Both are accepted on decode so a row
# written by either spelling restores identically.
_FIELD_ALIASES: dict[str, str] = {
    'tool_calls': 'toolCalls',
    'tool_use_id': 'toolUseId',
    'tool_call_id': 'toolUseId',
    'thinking_duration': 'thinkingDuration',
    'command_id': 'commandId',
    'turn_end': 'turnEnd',
    'changed_files': 'changedFiles',
    'edit_history': 'editHistory',
    'used_fallback': 'usedFallback',
}

# Never persisted into blocks_json: the columns already carry these, and
# re-storing them would just make the envelope lie about its own row.
_IDENTITY_KEYS = frozenset({'id', 'role', 'content', 'sessionId', 'session_id', 'createdAt', 'created_at'})


def _text(value: object) -> str:
    """Best-effort text for a stored content value."""
    if isinstance(value, str):
        return value
    if value is None:
        return ''
    if isinstance(value, list):
        return ''.join(
            _text(b.get('text', b.get('content', '')))
            for b in value
            if isinstance(b, dict) and b.get('type', 'text') in ('text', 'output_text')
        )
    if isinstance(value, dict):
        return _text(value.get('text') or value.get('content'))
    return str(value)


def _block(block_id: str, block_type: str, **fields: object) -> dict[str, object]:
    return {'id': block_id, 'type': block_type, **fields}


def _tool_use_block(index: int, use: dict[str, object]) -> dict[str, object]:
    """An assistant tool call. `status` stays 'running' until a tool-result
    message fills the result in (same by-id merge the live reducer does)."""
    use_id = use.get('id')
    block_id = str(use_id) if use_id else f'b_tool_{index}'
    args = use.get('input', use.get('arguments'))
    if isinstance(args, str):
        args_text = args
    elif args is None:
        args_text = ''
    else:
        try:
            args_text = json.dumps(args, ensure_ascii=False)
        except (TypeError, ValueError):
            args_text = str(args)
    return _block(
        block_id,
        'toolCall',
        tool={
            'id': block_id,
            'name': str(use.get('name', '')),
            'args': args_text,
            'status': 'running',
        },
    )


def derive_blocks(message: dict[str, object]) -> list[dict[str, object]]:
    """MessageBlock-shaped timeline for one stored workbench message.

    Used when the writer has no UI blocks (the normal case: the backend owns
    the model transcript, the desktop owns the rendering). Anthropic content
    blocks, OpenAI ``tool_calls`` and standalone tool-result messages are all
    understood, so a restored chat shows its tool cards and reasoning again
    instead of one flattened string.
    """
    role = str(message.get('role', ''))
    content = message.get('content')
    blocks: list[dict[str, object]] = []

    if isinstance(content, list):
        for index, raw in enumerate(content):
            if not isinstance(raw, dict):
                continue
            kind = str(raw.get('type', 'text'))
            if kind == 'thinking':
                blocks.append(_block(f'b_think_{index}', 'thinking', content=_text(raw.get('thinking'))))
            elif kind == 'text' or kind == 'output_text':
                blocks.append(_block(f'b_text_{index}', 'finalOutput', content=_text(raw.get('text'))))
            elif kind == 'tool_use':
                blocks.append(_tool_use_block(index, raw))
            elif kind == 'tool_result':
                result = _text(raw.get('content'))
                tool_id = str(raw.get('tool_use_id') or f'b_tool_{index}')
                blocks.append(
                    _block(
                        tool_id,
                        'toolCall',
                        content=result,
                        tool={
                            'id': tool_id,
                            'name': str(raw.get('name', '')),
                            'status': 'done',
                            'result': result,
                        },
                    )
                )
    elif role == 'assistant':
        # Only an assistant turn gains a derived block: for a user message the
        # text IS the message, so a derived block would just duplicate
        # `content` (and make an ordinary user row claim a structured
        # transcript it never had).
        text = _text(content)
        if text:
            blocks.append(_block('b_text_0', 'finalOutput', content=text))

    tool_calls = message.get('tool_calls')
    if isinstance(tool_calls, list):
        for index, call in enumerate(tool_calls):
            if not isinstance(call, dict):
                continue
            function = call.get('function')
            function = function if isinstance(function, dict) else {}
            blocks.append(
                _tool_use_block(
                    index,
                    {
                        'id': call.get('id'),
                        'name': function.get('name', call.get('name', '')),
                        'input': function.get('arguments', call.get('arguments')),
                    },
                )
            )

    if role == 'tool':
        # A standalone tool-result message. `name` rides along so the desktop
        # can render a labelled tool card instead of raw result text.
        result = _text(content)
        tool_id = str(message.get('tool_use_id') or message.get('toolUseId') or '')
        name = str(message.get('name') or '')
        blocks.append(
            _block(
                tool_id or 'b_tool_result',
                'toolCall',
                content=result,
                tool={
                    'id': tool_id or 'b_tool_result',
                    'name': name,
                    'status': 'done',
                    'result': result,
                },
            )
        )

    return blocks


def structured_fields(message: dict[str, object]) -> dict[str, object]:
    """The structured payload to persist for one message (empty = legacy row)."""
    fields: dict[str, object] = {}
    for key, value in message.items():
        if key in _IDENTITY_KEYS or value is None:
            continue
        if key in STRUCTURED_FIELDS:
            fields[key] = value
        elif key in _FIELD_ALIASES:
            fields.setdefault(_FIELD_ALIASES[key], value)
    blocks = fields.get('blocks')
    if not isinstance(blocks, list) or not blocks:
        derived = derive_blocks(message)
        if derived:
            fields['blocks'] = derived
    tool = fields.get('tool')
    if not isinstance(tool, dict) and str(message.get('role', '')) == 'tool':
        fields['tool'] = {
            'name': str(message.get('name') or ''),
            'result': _text(message.get('content')),
            'status': 'done',
        }
    return fields


def encode_blocks(message: dict[str, object]) -> str | None:
    """JSON for ``messages.blocks_json``; None when nothing structured exists."""
    fields = structured_fields(message)
    if not fields:
        return None
    try:
        return json.dumps(fields, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None


def decode_blocks(raw: object) -> dict[str, object]:
    """Parse a stored ``blocks_json`` cell. Never raises — a corrupt row falls
    back to the legacy text-only shape instead of failing the whole restore."""
    if not raw or not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict[str, object] = {}
    for key, value in parsed.items():
        if key in STRUCTURED_FIELDS:
            out[key] = value
        elif key in _FIELD_ALIASES:
            out.setdefault(_FIELD_ALIASES[key], value)
    blocks = out.get('blocks')
    if blocks is not None and not isinstance(blocks, list):
        out.pop('blocks', None)
    return out
