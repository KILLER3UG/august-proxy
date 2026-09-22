"""Multi-file skills: sidecar documents must be discoverable from SKILL.md.

A skill directory can hold reference documents, but nothing told the model they
existed, so in practice every skill stayed a single file. `load_skill` now ends
with a bounded listing; the body remains the entry point and the model opens
only the file it needs.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services.tool_registrations import skill_tools


@pytest.fixture()
def skill_dir(tmp_path: Path) -> Path:
    root = tmp_path / 'acme-skill'
    (root / 'references').mkdir(parents=True)
    (root / 'templates').mkdir()
    (root / 'SKILL.md').write_text('# Acme\n\nbody\n', encoding='utf-8')
    (root / 'references' / 'auth.md').write_text('# Auth\n', encoding='utf-8')
    (root / 'references' / 'proxy.md').write_text('# Proxy\n\nlonger content here\n', encoding='utf-8')
    (root / 'templates' / 'login.sh').write_text('#!/sh\n', encoding='utf-8')
    (root / '.hidden').write_text('ignored\n', encoding='utf-8')
    return root


def test_sibling_files_are_listed_with_paths_and_sizes(skill_dir: Path) -> None:
    out = skill_tools._siblingFiles(str(skill_dir / 'SKILL.md'))
    assert '## Files in this skill' in out
    assert 'references/auth.md' in out
    assert 'references/proxy.md' in out
    assert 'templates/login.sh' in out
    # Sizes let the model judge a read before paying for it. Derived, not
    # hardcoded: write_text() translates \n to \r\n on Windows.
    expected = (skill_dir / 'references' / 'auth.md').stat().st_size
    assert f'references/auth.md ({expected} bytes)' in out


def test_skill_md_itself_is_not_listed(skill_dir: Path) -> None:
    out = skill_tools._siblingFiles(str(skill_dir / 'SKILL.md'))
    assert '- SKILL.md' not in out


def test_dot_entries_are_skipped(skill_dir: Path) -> None:
    out = skill_tools._siblingFiles(str(skill_dir / 'SKILL.md'))
    assert '.hidden' not in out


def test_listing_is_capped_and_says_so(tmp_path: Path) -> None:
    root = tmp_path / 'many'
    root.mkdir()
    (root / 'SKILL.md').write_text('x', encoding='utf-8')
    for i in range(40):
        (root / f'note-{i:02d}.md').write_text('y', encoding='utf-8')
    out = skill_tools._siblingFiles(str(root / 'SKILL.md'))
    assert out.count('\n- ') == skill_tools._MAX_SKILL_FILES
    assert 'more not listed' in out


@pytest.mark.parametrize('path', ['', '/nonexistent/SKILL.md'])
def test_missing_paths_return_empty(path: str) -> None:
    assert skill_tools._siblingFiles(path) == ''


async def test_load_skill_appends_the_listing(monkeypatch: pytest.MonkeyPatch, skill_dir: Path) -> None:
    from app.services import skill_service

    calls: list[object] = []
    # record_skill_use is synchronous in production; a coroutine stub would
    # only warn, never prove the call happened.
    monkeypatch.setattr(skill_service, 'record_skill_use', calls.append)

    monkeypatch.setattr(
        skill_service, 'get',
        lambda *a, **k: {
            'name': 'acme', 'description': 'does acme', 'enabled': True,
            'instructions': 'Do the thing.', 'path': str(skill_dir / 'SKILL.md'),
        },
    )

    out = await skill_tools._loadSkill('acme')
    assert 'Do the thing.' in out
    assert '## Files in this skill' in out
    assert 'references/auth.md' in out
    # Usage telemetry must survive the refactor — it drives skill ranking.
    assert calls == [str(skill_dir / 'SKILL.md')]


async def test_load_skill_is_unchanged_for_single_file_skills(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from app.services import skill_service

    calls: list[object] = []
    # record_skill_use is synchronous in production; a coroutine stub would
    # only warn, never prove the call happened.
    monkeypatch.setattr(skill_service, 'record_skill_use', calls.append)

    lonely = tmp_path / 'solo'
    lonely.mkdir()
    (lonely / 'SKILL.md').write_text('only body', encoding='utf-8')
    monkeypatch.setattr(
        skill_service, 'get',
        lambda *a, **k: {
            'name': 'solo', 'description': 'd', 'enabled': True,
            'instructions': 'body only', 'path': str(lonely / 'SKILL.md'),
        },
    )
    out = await skill_tools._loadSkill('solo')
    assert out.strip().endswith('body only')
    assert '## Files in this skill' not in out
    assert calls == [str(lonely / 'SKILL.md')]


def test_module_context_is_offered_to_read_only_subagents() -> None:
    """The read-only tier is an explicit allowlist, so a new surveying tool
    that is not added there is unusable by exactly the children that need it."""
    from app.services.workbench.subagent import (
        SUBAGENT_CAPABILITY_READ_ONLY,
        _blocked_tools,
        _capability_filter,
    )

    assert 'module_context' in SUBAGENT_CAPABILITY_READ_ONLY
    allowed = _capability_filter('read_only')
    assert allowed is not None and 'module_context' in allowed
    assert 'module_context' not in _blocked_tools(depth=1)
