"""The anatomy bundled skill — the port's load-bearing promises (Stage 2).

`test_skill_service_hygiene.py` deliberately does not validate bundled-skill
format (it covers frontmatter round-trip, disabled-skill refusal, the
relevant_skills block, the description denylist and tutor presence). This is
the small test that was actually missing: it pins the three things a reader
of the port depends on —

- anatomy is DISCOVERED from the bundled root (`<repo>/skills/`),
- its description clears the service's own validator (≤ 500 chars, marketing
  denylist) when run against the shipped file — the exact gate a live
  `skill_create` would apply,
- the load_skill door's file listing shows the reference entries a reader
  needs to see up front (the two examples + craft/verify + the kit), and the
  payload stays inside `_MAX_SKILL_FILES` so nothing is hidden behind
  "_N more not listed_".
"""

from __future__ import annotations

from app.services import skill_service
from app.services.tool_registrations.skill_tools import _loadSkill, _siblingFiles


def _anatomy() -> dict:
    for entry in skill_service.list_all():
        if entry.get('name') == 'anatomy':
            return entry
    raise AssertionError('anatomy was not discovered from the bundled skills root')


def test_anatomy_is_discovered_from_the_bundled_root() -> None:
    entry = _anatomy()
    assert entry.get('enabled') is not False
    # The shipped description is non-trivial — a one-liner would be a stub.
    desc = str(entry.get('description') or '')
    assert len(desc) > 200


def test_anatomy_description_clears_the_validator() -> None:
    # The same validation a live skill_create applies, run on the real file:
    # raises SkillValidationError on >500 chars or a marketing word.
    entry = _anatomy()
    desc = str(entry.get('description') or '')
    assert len(desc) <= skill_service._DESCRIPTIONMax
    skill_service._validateDescription(desc)


def test_anatomy_reference_files_are_listed_and_bounded() -> None:
    entry = _anatomy()
    skill_path = str(entry.get('path') or '')
    assert skill_path.endswith('SKILL.md')
    listing = _siblingFiles(skill_path)
    for rel in (
        'references/dial-indicator/build.mjs',
        'references/desk-computer/build.mjs',
        'references/craft.md',
        'references/verify.md',
        'kit/iso-kit.mjs',
        'scripts/inline-kit.mjs',
        'LICENSE',
    ):
        assert f'- {rel} (' in listing, f'{rel} missing from the load_skill listing'
    # 8 files ship; the 25-entry cap would hide the rest behind a note.
    assert 'more not listed' not in listing


async def test_load_skill_returns_the_body_and_the_file_listing() -> None:
    text = await _loadSkill('anatomy')
    assert 'not found' not in text.lower()
    # The body arrives (frontmatter description line + the one idea).
    assert 'the object is the explanation' in text
    # …and the file listing rides along, which is what makes the references
    # discoverable instead of invisible.
    assert '## Files in this skill' in text
    assert 'references/dial-indicator/build.mjs' in text


def test_anatomy_payload_is_the_small_framework_free_set() -> None:
    # raptor-engine (3.2 MB) and the 3D/webgl/pipes kit modules stay out of
    # the payload — the port is the two smallest examples plus the core.
    import re
    from pathlib import Path

    skill_dir = Path(str(_anatomy()['path'])).parent
    names = sorted(
        str(p.relative_to(skill_dir)).replace('\\', '/')
        for p in skill_dir.rglob('*')
        if p.is_file()
    )
    assert 'raptor-engine' not in ' '.join(names)
    assert 'kit/lathe.mjs' not in names
    assert 'kit/gl.mjs' not in names
    # SKILL.md + LICENSE + 2 examples + 2 references + kit + scripts.
    assert len(names) == 8, names
    assert re.search(r'wheresryan22/anatomy', (skill_dir / 'SKILL.md').read_text('utf-8'))
