"""The math-animation bundled skill — the port's load-bearing promises.

Same shape as the anatomy port's gate (nothing else validates bundled-skill
format): the skill is discovered from the bundled root, its description
clears skill_service's own validator, and the load_skill door lists the
skill's files. The SKILL.md additionally carries the two facts the plan made
load-bearing — the venv interpreter version floor (>= 3.13, abi3) and the
per-user licensing posture — and both are asserted here so a later edit
cannot quietly drop them.
"""

from __future__ import annotations

from app.services import skill_service
from app.services.tool_registrations.skill_tools import _loadSkill, _siblingFiles


def _math() -> dict:
    for entry in skill_service.list_all():
        if entry.get('name') == 'math-animation':
            return entry
    raise AssertionError('math-animation was not discovered from the bundled skills root')


def test_math_animation_is_discovered() -> None:
    assert _math().get('enabled') is not False


def test_description_clears_the_validator() -> None:
    entry = _math()
    desc = str(entry.get('description') or '')
    assert len(desc) <= skill_service._DESCRIPTIONMax
    skill_service._validateDescription(desc)


def test_the_body_carries_the_environment_facts() -> None:
    text = open(str(_math()['path']), encoding='utf-8').read()
    # The interpreter floor and why it exists (bundled 3.12.9 < 3.13).
    assert '>= 3.13' in text or '3.13+' in text
    assert '3.12' in text
    # The path-form invocation the run_command tier admits.
    assert '.aug/kernel/venv' in text
    # Per-user licensing: never staged into a release.
    assert 'per-user' in text
    # The render → inspect → fix loop the plan named.
    assert 'manimgx inspect' in text


async def test_load_skill_returns_the_body() -> None:
    text = await _loadSkill('math-animation')
    assert 'not found' not in text.lower()
    assert 'construct' in text  # the Manim-CE scene API the skill teaches
    assert 'Typst' in text
