"""Capabilities prompt — tool buckets, skills catalogue, invariants."""

from __future__ import annotations

import pytest

from app.services.memory.capabilities_prompt import (
    classify_tool,
    format_tools_by_bucket,
    format_skills_by_category,
    build_capabilities_block,
    unclassified_tools,
    is_bulk_tagged,
)
from app.services import tool_definitions as toolDefsModule
from app.services.tool_registry import listRaw, listTools


@pytest.fixture(scope='module', autouse=True)
def _ensure_tools_registered():
    if not listTools():
        toolDefsModule.registerAll()


class TestToolBucketClassifier:
    def test_every_registered_tool_has_non_other_bucket(self):
        """Invariant: new tools must be explicitly classified (fail-closed)."""
        names = [t['name'] for t in listRaw()]
        bad = unclassified_tools(names)
        assert bad == [], f'Tools missing primary bucket classification: {bad}'

    def test_bulk_is_tag_not_override(self):
        assert is_bulk_tagged('read_files')
        assert classify_tool('read_files') == 'tool_read'
        assert is_bulk_tagged('delete_sessions')
        assert classify_tool('delete_sessions') == 'tool_destructive'
        assert is_bulk_tagged('bulk')
        # Meta bulk stays in write; nested ops determine real caution (prompt note).
        assert classify_tool('bulk') == 'tool_write'

    def test_format_includes_bulk_note_and_destructive_caution(self):
        text = format_tools_by_bucket(['read_file', 'delete_session', 'run_command', 'load_skill'])
        assert 'tool_read' in text
        assert 'tool_destructive' in text
        assert 'tool_shell' in text
        assert 'tool_skill' in text
        assert 'tool_bulk is a tag' in text or 'Bulk note' in text
        assert 'read_file' in text
        assert 'delete_session' in text


class TestSkillsFormat:
    def test_evolving_label(self):
        cat = [
            {
                'name': 'prefer-tabs',
                'description': 'Prefer tabs',
                'trigger': 'format',
                'category': 'style',
                'created_by': 'agent',
            },
            {
                'name': 'bundled-ish',
                'description': 'Bundled',
                'trigger': '',
                'category': 'meta',
                'created_by': '',
            },
        ]
        text = format_skills_by_category(cat)
        assert 'prefer-tabs [evolving]' in text
        assert 'bundled-ish:' in text
        assert 'bundled-ish [evolving]' not in text
        assert 'load_skill' in text


class TestCapabilitiesBlock:
    def test_block_structure(self):
        block = build_capabilities_block(['read_file', 'write_file'], catalogue=[])
        assert '<capabilities>' in block
        assert '<tools>' in block
        assert '<skills>' in block
        assert '<agents>' in block
        assert 'tool_read' in block
