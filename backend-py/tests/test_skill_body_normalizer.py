"""
Tests for the learned-skill body normalizer (skill_service._ensure_canonical_body).

Learned skills (``created_by: agent`` / ``created_by: harness-proposal``) are
rewritten so they carry the canonical sections in the order:

  # <the skill's own title>   (its H1, or the humanised name)
  When to Use
  When NOT to Use
  Prerequisites
  How to Run
  Quick Reference
  Procedure
  Output format
  Examples
  Pitfalls
  Verification
  Reference files

The section set follows the Claude/Anthropic authoring standard (the description
is the trigger; Output format, Examples and Reference files carry progressive
detail) with the Hermes substance bar — When to Use / Procedure / Pitfalls /
Verification — as the four sections a draft cannot ship without.

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
# way to prove it. This is the shape the distiller is now asked for — the
# Claude-standard sections (Output format, Examples, Reference files) are here
# too, since a learned skill should show its shape, not just describe it.
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
    'output_format': ['Report the table as a markdown row per node.'],
    'examples': [
        {'input': 'simulate this rc filter', 'output': 'row per node plus the -3dB point'},
    ],
    'reference_files': [
        {'file': 'references/spice-dialects.md', 'when': 'the netlist uses a nonstandard directive'},
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
    expected = [
        'Title',
        'When to Use',
        'When NOT to Use',
        'Prerequisites',
        'How to Run',
        'Quick Reference',
        'Procedure',
        'Output format',
        'Examples',
        'Pitfalls',
        'Verification',
        'Reference files',
    ]
    assert _BODY_SECTION_KEYS == expected


# ── structured drafting + the substance bar ───────────────────────────────


def test_render_skill_body_puts_every_authored_section_in_order():
    out = renderSkillBody('ngspice-batch-sim', 'Run netlists headlessly.', SKILL_DRAFT)
    order = [
        '# ngspice batch simulation',
        '## When to Use',
        '## When NOT to Use',
        '## Prerequisites',
        '## How to Run',
        '## Procedure',
        '## Output format',
        '## Examples',
        '## Pitfalls',
        '## Verification',
        '## Reference files',
    ]
    positions = [out.index(head) for head in order]
    assert positions == sorted(positions)
    # The command survives verbatim, and the pitfall carries what fixed it.
    assert 'ngspice -b netlist.cir' in out
    assert 'Instead: pass -b' in out
    # when-NOT is its own section now, not a sub-list of When to Use.
    assert 'Do not use it when:' not in out
    # The Claude-standard sections carry their authored content verbatim.
    assert 'markdown row per node' in out
    assert 'Input: simulate this rc filter' in out
    assert 'Output: row per node plus the -3dB point' in out
    assert '`references/spice-dialects.md` — read when the netlist uses' in out
    assert bodySubstance('ngspice-batch-sim', 'Run netlists headlessly.', out) == ''


def test_render_skill_body_omits_what_was_not_authored_instead_of_padding_it():
    out = renderSkillBody('a-rule', 'Always pass -b.', {'intro': ['Always pass -b.']})
    for sec in (
        'When to Use',
        'Prerequisites',
        'Procedure',
        'Output format',
        'Examples',
        'Reference files',
        'Pitfalls',
        'Verification',
    ):
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


def test_new_sections_alias_casual_headings():
    """A casual heading lands on its canonical name — including the three
    Claude-standard sections and the split when-NOT list."""
    body = (
        'when to use\n- x\n'
        'when not to use this\n- y\n'
        '## Steps\n- a\n- b\n'
        '## Output\n- template\n'
        '## Example\n- pair\n'
        '## References\n- references/api.md\n'
        '## Common mistakes\n- z\n'
        '## Verify\n- check the receipt\n'
    )
    out = _ensure_canonical_body(body, name='aliased', description='d', is_learned=True)
    for sec in (
        '## When to Use',
        '## When NOT to Use',
        '## Procedure',
        '## Output format',
        '## Examples',
        '## Reference files',
        '## Pitfalls',
        '## Verification',
    ):
        assert sec in out
    # The aliased heading is rewritten, never kept alongside the canonical.
    assert '## Example\n' not in out
    assert '## References\n' not in out
    assert '## Output\n' not in out


def test_when_not_to_use_survives_a_second_normalization():
    """The split sections must be a normalizer fixed point too — a skill whose
    when-NOT list silently re-merged into When to Use would drift on every
    approved patch."""
    rendered = renderSkillBody('ngspice-batch-sim', 'Run netlists headlessly.', SKILL_DRAFT)
    once = _ensure_canonical_body(
        rendered, name='ngspice-batch-sim', description='Run netlists headlessly.', is_learned=True
    )
    twice = _ensure_canonical_body(
        once, name='ngspice-batch-sim', description='Run netlists headlessly.', is_learned=True
    )
    assert once.strip() == twice.strip()
    assert once.count('## When NOT to Use') == 1
    assert 'the user wants an FPGA build' in once


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
