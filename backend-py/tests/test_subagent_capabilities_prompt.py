"""Subagent system prompt includes tool buckets + skills when allowed."""

from __future__ import annotations

from app.services.memory.capabilities_prompt import (
    build_capabilities_block,
    skills_tools_allowed,
)


def test_subagent_capabilities_with_skill_tools():
    allowed = ['read_file', 'write_file', 'load_skill', 'list_skills', 'run_command']
    assert skills_tools_allowed(allowed)
    text = build_capabilities_block(allowed, include_skills=True)
    assert 'tool_read' in text
    assert 'tool_skill' in text
    assert 'load_skill' in text
    assert '<skills>' in text
    assert 'Do not spawn' not in text  # that lives outside capabilities


def test_subagent_capabilities_without_skill_tools():
    allowed = ['read_file', 'web_search']
    assert not skills_tools_allowed(allowed)
    text = build_capabilities_block(allowed, include_skills=False)
    assert 'Skills are unavailable' in text
    assert 'tool_read' in text
