"""M6 skill hygiene tests (plan 2026-08-27 §3.7).

Covers: setEnabled round-trip incl. unknown-frontmatter preservation (items
3+7), catalogue disabled-filtering (item 1), invalid-name discovery skip
(item 5), load_skill/list_skills disabled handling (item 1), single-write
PATCH semantics (item 4) and the Tier-3 <relevant_skills> block (item 6).
"""

from __future__ import annotations

import pytest
from app.services import skill_service


def _writeAgentSkill(name: str, frontmatterExtra: str = '', body: str = 'Do the thing.') -> None:
    root = skill_service._agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        'description: test skill for hygiene checks\n'
        'category: testing\n'
        'created_by: agent\n'
        f'{frontmatterExtra}'
        '---\n\n'
        f'{body}\n',
        'utf-8',
    )


@pytest.fixture()
def freshSkillState():
    """Reset module-level caches + migration flag between tests."""
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True  # skip repo-root flat migration scan
    yield
    skill_service._bust_prompt_skills_cache()


def test_setEnabled_roundtrip_preserves_unknown_frontmatter(freshSkillState):
    _writeAgentSkill('hy-roundtrip', frontmatterExtra='version: 2\ncustom_flag: keep-me\n')
    skill = skill_service.get('hy-roundtrip')
    assert skill is not None and skill['enabled'] is True
    assert skill['meta'] == {'version': '2', 'custom_flag': 'keep-me'}

    # Disable → excluded from catalogue, still discoverable via list_all.
    skill_service.setEnabled('hy-roundtrip', enabled=False)
    disabled = skill_service.get('hy-roundtrip')
    assert disabled is not None and disabled['enabled'] is False
    assert all(e['name'] != 'hy-roundtrip' for e in skill_service.catalogue())
    assert any(s['name'] == 'hy-roundtrip' for s in skill_service.list_all())

    # Re-enable → back in catalogue; unknown keys + body survived both writes.
    skill_service.setEnabled('hy-roundtrip', enabled=True)
    revived = skill_service.get('hy-roundtrip')
    assert revived is not None and revived['enabled'] is True
    assert revived['meta'] == {'version': '2', 'custom_flag': 'keep-me'}
    assert revived['instructions'] == 'Do the thing.'
    assert any(e['name'] == 'hy-roundtrip' for e in skill_service.catalogue())


def test_catalogue_entries_carry_enabled_field(freshSkillState):
    _writeAgentSkill('hy-enabled-field')
    entry = next(e for e in skill_service.catalogue() if e['name'] == 'hy-enabled-field')
    assert entry['enabled'] is True


def test_invalid_names_skipped_at_discovery(freshSkillState):
    _writeAgentSkill('pending-approval-junk')
    # 'pending-approval-junk' is a valid kebab name — invalidate it via the
    # frontmatter name instead (discovery validates the parsed name).
    bad = skill_service._agentSkillsDir() / 'pending-approval-junk' / 'SKILL.md'
    bad.write_text(
        '---\nname: Pending Approval Junk\ndescription: bad name\n---\n\nbody\n', 'utf-8'
    )
    skill_service._bust_prompt_skills_cache()
    names = [s['name'] for s in skill_service.list_all()]
    assert 'Pending Approval Junk' not in names
    assert all(e['name'] != 'Pending Approval Junk' for e in skill_service.catalogue())


def test_patch_single_write_disabled_and_content(freshSkillState):
    _writeAgentSkill('hy-single-write')
    skill_service.patchSkill(
        'hy-single-write', description='updated description here', enabled=False
    )
    patched = skill_service.get('hy-single-write')
    assert patched is not None
    assert patched['enabled'] is False
    assert patched['description'] == 'updated description here'


async def test_load_skill_refuses_disabled(freshSkillState):
    from app.services.tool_registrations.skill_tools import _listSkills, _loadSkill

    _writeAgentSkill('hy-load-disabled')
    skill_service.setEnabled('hy-load-disabled', enabled=False)
    result = await _loadSkill('hy-load-disabled')
    assert 'disabled' in result.lower()
    listing = await _listSkills()
    assert 'hy-load-disabled' not in listing


def test_relevant_skills_block_matches_query(freshSkillState, monkeypatch):
    from app.services.capabilities_prompt import build_relevant_skills_block

    _writeAgentSkill('hy-quartus-vhdl', body='FPGA synthesis steps.')
    # 'quartus'/'vhdl' only appear in this skill's name → rare terms, top rank.
    block = build_relevant_skills_block('please run the quartus vhdl synthesis flow')
    assert block.startswith('<relevant_skills>')
    assert 'hy-quartus-vhdl' in block
    assert block.rstrip().endswith('</relevant_skills>')


def test_relevant_skills_block_short_query_empty(freshSkillState):
    from app.services.capabilities_prompt import build_relevant_skills_block

    assert build_relevant_skills_block('hi') == ''


def test_relevant_skills_env_gate(freshSkillState, monkeypatch):
    from app.services.capabilities_prompt import build_relevant_skills_block

    _writeAgentSkill('hy-gated-skill')
    monkeypatch.setenv('AUGUST_SKILL_RELEVANCE', '0')
    assert build_relevant_skills_block('run the hy gated skill now please') == ''


def test_parse_frontmatter_strips_surrounding_quotes(freshSkillState):
    # Part 16 Phase C quote-strip: _skill_frontmatter (and the bundled
    # august-harness/august-tools SKILL.md files) write quoted values, but
    # the parser kept the literal quotes — they rode into every prompt's
    # skills index and GET /api/skills.
    fm = skill_service._parse_frontmatter_block(
        'description: "How the loop works"\ntrigger: \'when testing\'\ncategory: plain\n'
    )
    assert fm['description'] == 'How the loop works'
    assert fm['trigger'] == 'when testing'
    assert fm['category'] == 'plain'
    # Inner/unbalanced quotes stay untouched.
    fm2 = skill_service._parse_frontmatter_block('description: say "hello" aloud\n')
    assert fm2['description'] == 'say "hello" aloud'


def test_bundled_skills_no_literal_quotes_in_descriptions(freshSkillState):
    # Live-bug regression (Part 16 §9 confirmed by execution): the two
    # bundled quoted frontmatters must parse clean.
    quoted = [
        s['name']
        for s in skill_service.list_all()
        if str(s.get('description', '')).startswith(('"', "'"))
        or str(s.get('description', '')).endswith(('"', "'"))
    ]
    assert quoted == []


def test_bundled_tutor_skill_present(freshSkillState):
    """The built-in ``tutor`` skill ships in the bundled root and stays loadable.

    Guard so a cleanup/reorg cannot silently drop the learning skill: it must
    be bundled (no ``created_by``), enabled, categorized ``learning``, and keep
    its four teaching sections (learn the user / study / line-by-line / think).
    """
    skill = skill_service.get('tutor')
    assert skill is not None, 'bundled tutor skill missing from discovery'
    assert skill['enabled'] is True
    assert skill['created_by'] == ''  # bundled, not agent-authored
    assert skill['category'] == 'learning'
    assert any(e['name'] == 'tutor' for e in skill_service.catalogue())
    body = str(skill['instructions'])
    for section in ('Learn the user', 'Explain line by line', 'Teach how to think', 'Verification'):
        assert section in body, f'tutor skill lost section: {section}'
