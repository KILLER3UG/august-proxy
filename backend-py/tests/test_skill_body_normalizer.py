"""
Tests for the learned-skill body normalizer (skill_service._ensure_canonical_body).

Learned skills (``created_by: agent`` / ``created_by: harness-proposal``) are
rewritten so they always carry the canonical sections in the order:

  What this skill is  (Title)
  When to Use
  How to Run
  Pitfalls
  Verification

Bundled (hand-written) skills pass through untouched so a human author can
keep whatever prose they shipped.
"""

from __future__ import annotations

from app.services.skill_service import (
    _BODY_SECTION_KEYS,
    _REQUIRED_BODY_SECTIONS,
    _ensure_canonical_body,
    _parse_body_sections,
)


def test_normalizer_keeps_bundled_skill_prose_untouched():
    body = "# Whatever I want\n\nA long human-written essay about the loop."
    assert _ensure_canonical_body(
        body,
        name='august-harness',
        description='desc',
        is_learned=False,
    ) == body


def test_normalizer_emits_title_when_missing_using_description():
    out = _ensure_canonical_body(
        'just some prose with no headings',
        name='lesson-x',
        description='Useful for X',
        is_learned=True,
    )
    assert '# What this skill is' in out
    assert 'Useful for X' in out
    for sec in _REQUIRED_BODY_SECTIONS:
        assert f'## {sec}' in out


def test_normalizer_preserves_existing_section_content():
    body = (
        "When to Use\n"
        "----------\n"
        "before\n"
        "## How to Run\n"
        "step 1\n"
        "## Pitfalls\n"
        "be careful\n"
    )
    out = _ensure_canonical_body(
        body,
        name='lesson-y',
        description='Lesson Y',
        is_learned=True,
    )
    assert 'before' in out
    assert 'step 1' in out
    assert 'be careful' in out
    # Sections are in canonical order.
    idx_use = out.index('## When to Use')
    idx_run = out.index('## How to Run')
    idx_pit = out.index('## Pitfalls')
    assert idx_use < idx_run < idx_pit


def test_normalizer_aliases_casual_headings():
    body = "what this skill is\n- short\nSteps:\n- a\n- b\nCommon mistakes:\n- x\nVerify:\n- y"
    out = _ensure_canonical_body(
        body,
        name='lesson-z',
        description='desc',
        is_learned=True,
    )
    assert '# What this skill is' in out
    assert '## Procedure' in out
    assert '## Pitfalls' in out
    assert '## Verification' in out


def test_normalizer_fills_missing_required_sections_with_placeholder():
    body = "## When to Use\n- only this section present"
    out = _ensure_canonical_body(
        body,
        name='thin-lesson',
        description='thin',
        is_learned=True,
    )
    assert '## How to Run' in out
    assert '## Pitfalls' in out
    assert '## Verification' in out
    # Placeholders make it clear what to fill in.
    assert 'load_skill' in out  # How-to-Run placeholder
    # Pitfalls placeholder invites the author to record a row.
    assert 'recorded' in out.lower() or 'add a row' in out.lower()


def test_normalizer_keeps_unrecognised_sections():
    body = (
        "When to Use\n- x\n## How to Run\n- y\n"
        "## Custom Notes\n- keep me\n## Pitfalls\n- p\n## Verification\n- v\n"
    )
    out = _ensure_canonical_body(
        body,
        name='with-extras',
        description='d',
        is_learned=True,
    )
    assert '## Custom Notes' in out
    assert 'keep me' in out


def test_parse_body_sections_groups_unknown_headings_under_previous_section():
    sections = _parse_body_sections("## When to Use\n- x\n## Notes\n- y\n## How to Run\n- z")
    section_map = {name: content for name, content in sections}
    # "Notes" is not canonical — it stays inside the previous section.
    assert 'Notes' not in section_map
    assert '## Notes' in section_map.get('When to Use', '') or 'Notes' in section_map.get(
        'When to Use', ''
    )


def test_normalizer_section_keys_match_declared_order():
    expected = ['Title', 'When to Use', 'Prerequisites', 'How to Run', 'Quick Reference', 'Procedure', 'Pitfalls', 'Verification']
    assert _BODY_SECTION_KEYS == expected
