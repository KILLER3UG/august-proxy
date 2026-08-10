"""Tests for the user profile consolidation writer."""

from __future__ import annotations

import pytest


def test_consolidate_writes_profile(brain_ready):
    from app.services.memory import user_profile as up
    from app.services.memory_store import get_memory

    profile = up.consolidateUserProfile(
        ['User is a backend developer', 'Uses Python and FastAPI']
    )
    assert profile is not None
    stored = get_memory('userProfile')
    assert isinstance(stored, dict)
    assert stored['summary']
    fields = {f['field'] for f in stored['facts']}
    assert 'role' in fields or 'stack' in fields
    assert 'Python' in stored['summary']


def test_consolidate_returns_none_on_empty(brain_ready):
    from app.services.memory import user_profile as up

    assert up.consolidateUserProfile([]) is None
    assert up.consolidateUserProfile(['   ']) is None


def test_near_dup_refreshes_not_duplicates(brain_ready):
    from app.services.memory import user_profile as up
    from app.services.memory_store import get_memory

    up.consolidateUserProfile(['User prefers pnpm over npm'])
    up.consolidateUserProfile(['User prefers pnpm over npm'])
    stored = get_memory('userProfile')
    assert len(stored['facts']) == 1


def test_profile_capped(brain_ready):
    from app.services.memory import user_profile as up
    from app.services.memory_store import get_memory

    up.consolidateUserProfile([f'Stable fact number {i} for the profile' for i in range(30)])
    stored = get_memory('userProfile')
    assert len(stored['facts']) <= 25


def test_classification_buckets():
    from app.services.memory.user_profile import _classify_fact

    assert _classify_fact('My name is Alice') == 'name'
    assert _classify_fact('Uses Python and Docker') == 'stack'
    assert _classify_fact('Prefers tabs over spaces') == 'preference'
    assert _classify_fact('Works as a backend engineer') == 'role'
    assert _classify_fact('The project ships weekly') == 'other'
    # A project's name is not the user's name.
    assert _classify_fact('The project name is august-proxy') == 'other'


def test_consolidate_is_additive_to_core_memory(brain_ready):
    """The review path writes facts to coreMemory and the profile independently."""
    from app.services.memory import background_review as br
    from app.services.memory_store import get_memory

    br._saveFact('add', 'User is a backend developer')
    br._saveFact('add', 'User is a backend developer')
    core = get_memory('coreMemory')
    assert isinstance(core, list)
    assert len(core) == 1  # exact-duplicate suppressed


def test_save_fact_near_dup_refreshes(brain_ready):
    from app.services.memory import background_review as br
    from app.services.memory_store import get_memory

    br._saveFact('add', 'The user prefers pnpm over npm for installs')
    br._saveFact('add', 'User prefers pnpm over npm')
    core = get_memory('coreMemory')
    assert len(core) == 1
    # Near-dups refresh the timestamp but keep the existing (more specific)
    # fact text — never replace detail with a shorter paraphrase.
    assert core[0]['fact'] == 'The user prefers pnpm over npm for installs'


def test_capture_preferences_patterns(brain_ready):
    from app.services.memory.user_profile import capture_preferences

    assert capture_preferences('I prefer pnpm over npm') == ['prefers: pnpm over npm']
    assert capture_preferences('My favorite editor is VS Code') == ['favorite: VS Code']
    assert capture_preferences('please do not use emoji in commits') == [
        'avoid: use emoji in commits'
    ]
    assert capture_preferences('the weather is nice today') == []


def test_note_user_message_folds_into_profile(brain_ready):
    from app.services.memory.user_profile import get_user_profile, note_user_message

    note_user_message('I prefer short answers with code examples')
    profile = get_user_profile()
    assert profile['summary']
    assert 'prefers: short answers with code examples' in profile['summary']
    # Repeated message refreshes rather than duplicating.
    note_user_message('I prefer short answers with code examples')
    profile2 = get_user_profile()
    facts = profile2.get('facts') or []
    assert len(facts) == 1


def test_infer_communication_style(brain_ready):
    from app.services.memory.user_profile import infer_communication_style

    assert infer_communication_style([]) is None
    assert infer_communication_style(['ok', 'yes', 'go ahead']) == 'casual'
    long_msg = (
        'please explain the full architecture in detail step by step including how '
        'the proxy layer translates between openai and anthropic wire formats and '
        'how the workbench loop manages tool calls, streaming, compaction, and the '
        'verifier gate across multiple rounds of execution with sub agents'
    )
    assert len(long_msg.split()) > 40
    assert infer_communication_style([long_msg]) == 'detailed'


def test_profile_block_renders_structured_fields(brain_ready):
    from app.services.memory.context_builder import _buildUserProfileBlock
    from app.services.memory.user_profile import get_user_profile, note_user_message

    note_user_message('I prefer TypeScript')
    block = _buildUserProfileBlock(get_user_profile())
    assert block.startswith('<user_profile>')
    assert '</user_profile>' in block
    assert 'TypeScript' in block
    assert _buildUserProfileBlock(None) == ''
    assert _buildUserProfileBlock({}) == ''
