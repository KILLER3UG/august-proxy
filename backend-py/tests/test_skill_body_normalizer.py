"""
Tests for the learned-skill body normalizer (skill_service._ensure_canonical_body).

Learned skills (``created_by: agent`` / ``created_by: harness-proposal``) are
rewritten so they carry the canonical sections in the order:

  # <the skill's own title>   (its H1, or the humanised name)
  When to Use
  How to Run
  Pitfalls
  Verification

Bundled (hand-written) skills pass through untouched so a human author can
keep whatever prose they shipped.

The renderer and the substance bar live here too: a draft is measured on what
its author wrote, never on the padded result.
"""

from __future__ import annotations

from app.services.skill_service import (
    _BODY_SECTION_KEYS,
    _REQUIRED_BODY_SECTIONS,
    _ensure_canonical_body,
    _parse_body_sections,
    _placeholder_for,
    bodySubstance,
    renderSkillBody,
)

# A draft that clears the substance bar: two steps, a pitfall that happened, a
# way to prove it. This is the shape the distiller is now asked for.
SKILL_DRAFT = {
    'title': 'ngspice batch simulation',
    'intro': ['Runs a netlist headlessly.', 'It does not flash hardware.'],
    'when_to_use': ['the user asks to simulate a circuit'],
    'when_not_to_use': ['the user wants an FPGA build'],
    'prerequisites': ['ngspice on PATH'],
    'steps': [
        {'do': 'Run in batch mode', 'command': 'ngspice -b netlist.cir'},
        {'do': 'Read the print table from the receipt'},
    ],
    'pitfalls': [{'seen': 'ngspice opened the GUI and hung', 'instead': 'pass -b'}],
    'verification': ['the receipt has a numeric row'],
    'keywords': ['simulate', 'netlist'],
}


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
    # The H1 is the skill's title, not a literal label: an author who wrote
    # `# Receipt gate` used to get it buried under `# What this skill is`.
    assert out.startswith('# Lesson x\n\njust some prose with no headings')
    for sec in _REQUIRED_BODY_SECTIONS:
        assert f'## {sec}' in out
    assert 'Useful for X' in out


def test_normalizer_keeps_the_authors_own_h1():
    out = _ensure_canonical_body(
        '# Receipt gate\n\nRead the receipt, not the prose.\n\n## Pitfalls\n\n- x',
        name='receipt-gate',
        description='Read receipts.',
        is_learned=True,
    )
    assert out.startswith('# Receipt gate\n\nRead the receipt, not the prose.')
    # Exactly one H1 — the author's. The old shape wrapped it in a second one.
    assert not any(
        line.startswith('# ') and line != '# Receipt gate' for line in out.splitlines()
    )


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
    # The intent is the ALIASING, not one literal H1: every casual heading lands
    # on its canonical name, and the file has exactly one title line.
    assert out.startswith('# Lesson z')
    assert '## Procedure' in out
    assert '## Pitfalls' in out
    assert '## Verification' in out
    assert not any(
        line.startswith('# ') and line != '# Lesson z' for line in out.splitlines()
    )


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


# ── structured drafting + the substance bar ───────────────────────────────


def test_render_skill_body_puts_every_authored_section_in_order():
    out = renderSkillBody('ngspice-batch-sim', 'Run netlists headlessly.', SKILL_DRAFT)
    order = ['# ngspice batch simulation', '## When to Use', '## Prerequisites', '## How to Run',
             '## Procedure', '## Pitfalls', '## Verification']
    positions = [out.index(head) for head in order]
    assert positions == sorted(positions)
    # The command survives verbatim, and the pitfall carries what fixed it.
    assert 'ngspice -b netlist.cir' in out
    assert 'Instead: pass -b' in out
    assert 'Do not use it when:' in out
    assert bodySubstance('ngspice-batch-sim', 'Run netlists headlessly.', out) == ''


def test_render_skill_body_omits_what_was_not_authored_instead_of_padding_it():
    out = renderSkillBody('a-rule', 'Always pass -b.', {'intro': ['Always pass -b.']})
    for sec in ('When to Use', 'Prerequisites', 'Procedure', 'Pitfalls', 'Verification'):
        assert f'## {sec}' not in out
    assert 'Always pass -b.' in out


def test_render_skill_body_survives_the_normalizer_unchanged():
    """Approval re-normalizes the stored body, so rendering must be a fixed point
    of it — otherwise the skill a human approved is not the one on disk."""
    rendered = renderSkillBody('ngspice-batch-sim', 'Run netlists headlessly.', SKILL_DRAFT)
    again = _ensure_canonical_body(
        rendered, name='ngspice-batch-sim', description='Run netlists headlessly.', is_learned=True
    )
    assert again.strip() == rendered.strip()


def test_body_substance_refuses_a_rule_wearing_skill_headings():
    rule = '## When to Use\n\n- when simulating\n\n## Pitfalls\n\n- be careful'
    assert bodySubstance('x', 'Always pass -b.', rule) == 'procedure has fewer than 2 steps'


def test_body_substance_counts_a_placeholder_as_missing_not_as_content():
    name, desc = 'thin-lesson', 'thin'
    padded = _ensure_canonical_body(
        '## When to Use\n\n- only this section present', name=name, description=desc, is_learned=True
    )
    assert _placeholder_for('Pitfalls', name, desc).strip() in padded
    assert bodySubstance(name, desc, padded) == 'procedure has fewer than 2 steps'
    # A pitfall the normalizer INVENTED is not evidence: with every other section
    # real, the template row alone still fails the bar.
    filler = _placeholder_for('Pitfalls', name, desc).strip()
    body = (
        f'# T\n\nintro\n\n## When to Use\n\n- a real situation\n\n'
        f'## Procedure\n\n1. one\n2. two\n\n## Pitfalls\n\n{filler}\n\n'
        f'## Verification\n\n- the receipt has a numeric row\n'
    )
    assert bodySubstance(name, desc, body) == 'no pitfall observed in the episode'


def test_body_substance_needs_a_pitfall_and_a_verification():
    base = ('# T\n\nintro\n\n## When to Use\n\n- a\n\n## Procedure\n\n'
            '1. one\n2. two\n\n## Pitfalls\n\n- x\n\n## Verification\n\n- y\n')
    assert bodySubstance('t', 'd', base) == ''
    assert bodySubstance('t', 'd', base.replace('## Pitfalls\n\n- x\n\n', '')) == 'no pitfall observed in the episode'
    assert bodySubstance('t', 'd', base.replace('## Verification\n\n- y\n', '')) == 'no way to tell it worked'
