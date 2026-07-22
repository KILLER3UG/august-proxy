"""Characterization tests for adapters.anthropic_system helpers."""

from __future__ import annotations

from app.adapters import anthropic as anthropic_adapter
from app.adapters.anthropic_system import (
    AUGUST_REMINDER,
    CLAUDE_PUBLIC_MODEL_ALIAS,
    append_text_to_system_blocks,
    build_anthropic_system_blocks,
    build_openai_system_prompt,
    is_claude_family_model,
    normalize_system_blocks,
    resolve_claude_client_facing_model,
    resolve_claude_public_model_alias,
    should_inject_august_reminder,
    should_inject_reminder_message,
    system_blocks_to_text,
)

# ── Claude family / alias resolution ─────────────────────────────────────────


def test_is_claude_family_model_ids_and_aliases():
    assert is_claude_family_model('claude-sonnet-4-7') is True
    assert is_claude_family_model('claude-opus-4-6') is True
    assert is_claude_family_model('sonnet') is True
    assert is_claude_family_model('opus') is True
    assert is_claude_family_model('best') is True
    assert is_claude_family_model('opusplan') is True
    assert is_claude_family_model('gpt-4o') is False
    assert is_claude_family_model('') is False
    assert is_claude_family_model(None) is False
    assert is_claude_family_model('  ') is False


def test_resolve_claude_public_model_alias():
    assert resolve_claude_public_model_alias('sonnet') == 'claude-sonnet-4-6'
    assert resolve_claude_public_model_alias('opus') == 'claude-opus-4-6'
    assert resolve_claude_public_model_alias('best') == 'claude-opus-4-6'
    assert resolve_claude_public_model_alias('opusplan') == 'claude-opus-4-6'
    assert resolve_claude_public_model_alias('claude-sonnet-4-6') == 'claude-sonnet-4-6'
    assert resolve_claude_public_model_alias(None) == CLAUDE_PUBLIC_MODEL_ALIAS
    assert resolve_claude_public_model_alias('') == CLAUDE_PUBLIC_MODEL_ALIAS
    assert resolve_claude_public_model_alias('unknown-model') == CLAUDE_PUBLIC_MODEL_ALIAS


def test_resolve_claude_client_facing_model():
    assert resolve_claude_client_facing_model('sonnet') == 'claude-sonnet-4-6'
    assert resolve_claude_client_facing_model('opus') == 'claude-opus-4-6'
    assert resolve_claude_client_facing_model('claude-opus-4-6') == 'claude-opus-4-6'
    assert resolve_claude_client_facing_model(None) == CLAUDE_PUBLIC_MODEL_ALIAS


# ── System block normalize / flatten / append ────────────────────────────────


def test_normalize_system_blocks_string():
    blocks = normalize_system_blocks('You are helpful.')
    assert blocks == [{'type': 'text', 'text': 'You are helpful.'}]


def test_normalize_system_blocks_list_of_strings():
    blocks = normalize_system_blocks(['A', 'B'])
    assert blocks == [
        {'type': 'text', 'text': 'A'},
        {'type': 'text', 'text': 'B'},
    ]


def test_normalize_system_blocks_empty_and_falsy():
    assert normalize_system_blocks(None) == []
    assert normalize_system_blocks('') == []
    assert normalize_system_blocks([]) == []


def test_normalize_system_blocks_other_types():
    blocks = normalize_system_blocks(42)
    assert blocks == [{'type': 'text', 'text': '42'}]


def test_system_blocks_to_text_joins_text_blocks():
    text = system_blocks_to_text(
        [
            {'type': 'text', 'text': 'Hello'},
            {'type': 'text', 'text': 'World'},
        ]
    )
    assert text == 'Hello\nWorld'


def test_system_blocks_to_text_empty():
    assert system_blocks_to_text(None) == ''
    assert system_blocks_to_text([]) == ''


def test_system_blocks_to_text_tool_use_serializes_input():
    text = system_blocks_to_text(
        [{'type': 'tool_use', 'input': {'query': 'test'}}]
    )
    assert 'query' in text
    assert 'test' in text


def test_append_text_to_system_blocks_empty():
    blocks = append_text_to_system_blocks(None, 'new text')
    assert blocks == [{'type': 'text', 'text': 'new text'}]


def test_append_text_to_system_blocks_appends_to_last_text():
    base = [{'type': 'text', 'text': 'first'}]
    blocks = append_text_to_system_blocks(base, 'second')
    assert len(blocks) == 1
    assert blocks[0]['text'] == 'first\n\nsecond'
    # original list not mutated
    assert base[0]['text'] == 'first'


def test_append_text_to_system_blocks_new_block_when_last_not_text():
    base = [{'type': 'image', 'source': {}}]
    blocks = append_text_to_system_blocks(base, 'extra')
    assert len(blocks) == 2
    assert blocks[-1] == {'type': 'text', 'text': 'extra'}


def test_append_text_preserves_leading_newline():
    blocks = append_text_to_system_blocks([{'type': 'text', 'text': 'a'}], '\nkeep')
    assert blocks[0]['text'] == 'a\nkeep'


# ── Reminder injection ───────────────────────────────────────────────────────


def test_should_inject_august_reminder():
    assert should_inject_august_reminder(None) is True
    assert should_inject_august_reminder('') is True
    assert should_inject_august_reminder('plain system') is True
    assert should_inject_august_reminder('August is great') is False


def test_should_inject_reminder_message_detects_existing():
    assert should_inject_reminder_message(None) is True
    assert should_inject_reminder_message([]) is True
    assert (
        should_inject_reminder_message(
            [{'role': 'user', 'content': 'hi'}]
        )
        is True
    )
    assert (
        should_inject_reminder_message(
            [{'role': 'user', 'content': 'Welcome to August Proxy gateway'}]
        )
        is False
    )
    assert (
        should_inject_reminder_message(
            [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'Uses August tool suite here'},
                    ],
                }
            ]
        )
        is False
    )
    assert (
        should_inject_reminder_message(
            [{'role': 'user', 'content': 'hi'}],
            existing_system=[{'type': 'text', 'text': 'August Proxy rules'}],
        )
        is False
    )


def test_build_anthropic_system_blocks_injects_reminder():
    enriched = build_anthropic_system_blocks('You are helpful.')
    assert len(enriched) >= 2
    assert enriched[0]['text'] == 'You are helpful.'
    assert any('August' in str(b.get('text', '')) for b in enriched)
    assert any(AUGUST_REMINDER == b.get('text') for b in enriched)


def test_build_anthropic_system_blocks_skips_when_already_present():
    existing = 'You work in August already.'
    blocks = build_anthropic_system_blocks(existing)
    assert len(blocks) == 1
    assert blocks[0]['text'] == existing


def test_build_openai_system_prompt():
    prompt = build_openai_system_prompt(['Line one', 'Line two'])
    assert 'Line one' in prompt
    assert 'Line two' in prompt


# ── Back-compat re-exports on anthropic module ───────────────────────────────


def test_anthropic_module_reexports_compat_aliases():
    assert anthropic_adapter.isClaudeFamilyModel is is_claude_family_model
    assert anthropic_adapter.resolveClaudePublicModelAlias is resolve_claude_public_model_alias
    assert anthropic_adapter.resolveClaudeClientFacingModel is resolve_claude_client_facing_model
    assert anthropic_adapter.shouldInjectReminderMessage is should_inject_reminder_message
    assert anthropic_adapter.shouldInjectAugustReminder is should_inject_august_reminder
    assert anthropic_adapter.normalizeSystemBlocks is normalize_system_blocks
    assert anthropic_adapter.systemBlocksToText is system_blocks_to_text
    assert anthropic_adapter.buildOpenaiSystemPrompt is build_openai_system_prompt
    assert anthropic_adapter.buildAnthropicSystemBlocks is build_anthropic_system_blocks
    assert anthropic_adapter.appendTextToSystemBlocks is append_text_to_system_blocks
    assert anthropic_adapter.CLAUDE_PUBLIC_MODEL_ALIAS == CLAUDE_PUBLIC_MODEL_ALIAS
    assert anthropic_adapter.AUGUST_REMINDER == AUGUST_REMINDER
