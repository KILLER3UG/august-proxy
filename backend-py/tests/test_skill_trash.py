"""Skill delete trash — manifest-based undo (2026-10-04).

Two defects were found live while reviewing the trash feature, and both are
pinned here:

  * a dotted skill name was mis-split out of the trash id
    (``chart.js.helper.<stamp>`` restored as ``chart``), and
  * a project override came back to the global agent root instead of the
    project it was deleted from.

Plus the safety rails: name collision, tampered/missing entries, unknown ids,
retention prune, and a project whose workspace is gone.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from app.services import skill_service
from app.services.skill_service import SkillValidationError


def _mkSkillDir(root: Path, name: str, description: str = 'probe', body: str = 'Do work.') -> None:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        f'description: {description}\n'
        'category: testing\n'
        'created_by: agent\n'
        '---\n\n'
        f'{body}\n',
        'utf-8',
    )


@pytest.fixture()
def isolated(monkeypatch, tmp_path):
    """Fresh catalogue state + a sandboxed AGENT root (trash follows dataDir)."""
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True  # skip repo-root flat migration scan
    agent_root = tmp_path / 'agent-skills'
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agent_root)
    yield agent_root
    skill_service._bust_prompt_skills_cache()


def test_dotted_skill_name_round_trips(isolated):
    """A legal dotted name must come back with its name intact."""
    _mkSkillDir(isolated, 'chart.js.helper')
    out = skill_service.deleteSkill('chart.js.helper')
    assert out['scope'] == 'global'
    assert not (isolated / 'chart.js.helper').exists()
    assert skill_service.get('chart.js.helper') is None

    restored = skill_service.restoreSkill(str(out['trashId']))
    assert restored == {'restored': 'chart.js.helper', 'scope': 'agent'}
    assert (isolated / 'chart.js.helper' / 'SKILL.md').exists()
    assert skill_service.get('chart.js.helper') is not None


def test_project_override_restores_into_its_project(isolated, tmp_path):
    """Undo must return an override to the project, not to the global root."""
    ws = tmp_path / 'ws-restore'
    _mkSkillDir(ws / '.aug' / 'skills', 'proj-only')
    out = skill_service.deleteSkill('proj-only', str(ws))
    assert out['scope'] == 'project'
    assert out['override_removed'] is True

    restored = skill_service.restoreSkill(str(out['trashId']))
    assert restored == {'restored': 'proj-only', 'scope': 'project'}
    assert (ws / '.aug' / 'skills' / 'proj-only' / 'SKILL.md').exists()
    # The global root must stay untouched: the override is not promoted.
    assert not (isolated / 'proj-only').exists()


def test_restore_refuses_when_the_name_came_back(isolated):
    _mkSkillDir(isolated, 'reappears')
    out = skill_service.deleteSkill('reappears')
    _mkSkillDir(isolated, 'reappears', description='the new one')

    with pytest.raises(SkillValidationError, match='already exists'):
        skill_service.restoreSkill(str(out['trashId']))
    # The live copy is untouched and the trashed copy is still recoverable.
    assert skill_service.get('reappears') is not None
    assert (skill_service._trashRoot() / str(out['trashId']) / 'skill' / 'SKILL.md').exists()


def test_restore_rejects_unknown_and_unsafe_ids(isolated):
    for bad in ('', 'nope', '../../etc', 'a.b', '2026-10-04T12:00:00'):
        with pytest.raises(SkillValidationError, match='Invalid trash id'):
            skill_service.restoreSkill(bad)
    # A well-formed id that never existed is a distinct, honest error.
    with pytest.raises(SkillValidationError, match='not found'):
        skill_service.restoreSkill('20260101T000000000000')


def test_restore_rejects_a_tampered_manifest(isolated, tmp_path):
    _mkSkillDir(isolated, 'tampered')
    out = skill_service.deleteSkill('tampered')
    entry = skill_service._trashRoot() / str(out['trashId'])
    manifest = json.loads((entry / 'manifest.json').read_text('utf-8'))
    manifest['restoreTo'] = str(tmp_path / 'outside')
    (entry / 'manifest.json').write_text(json.dumps(manifest), 'utf-8')

    with pytest.raises(SkillValidationError, match='invalid restore target'):
        skill_service.restoreSkill(str(out['trashId']))
    assert not (tmp_path / 'outside').exists()


def test_project_restore_refuses_when_the_workspace_is_gone(isolated, tmp_path):
    import shutil

    ws = tmp_path / 'ws-deleted'
    _mkSkillDir(ws / '.aug' / 'skills', 'orphan')
    out = skill_service.deleteSkill('orphan', str(ws))
    shutil.rmtree(ws)

    with pytest.raises(SkillValidationError, match='no longer exists'):
        skill_service.restoreSkill(str(out['trashId']))


def test_prune_drops_entries_past_retention(isolated):
    _mkSkillDir(isolated, 'old-one')
    _mkSkillDir(isolated, 'new-one')
    old = skill_service.deleteSkill('old-one')
    new = skill_service.deleteSkill('new-one')
    root = skill_service._trashRoot()
    stale = root / str(old['trashId'])
    # Age the entry past the window instead of sleeping 24h.
    two_days_ago = time.time() - (2 * 24 * 60 * 60)
    os.utime(stale, (two_days_ago, two_days_ago))

    skill_service._pruneTrash()

    assert not stale.exists()
    assert (root / str(new['trashId'])).exists()


def test_trash_entry_keeps_original_bytes(isolated):
    """Undo restores content, not a re-render of the skill."""
    _mkSkillDir(isolated, 'byte-check', body='Keep this exact body.\n\n- line two')
    original = (isolated / 'byte-check' / 'SKILL.md').read_text('utf-8')
    out = skill_service.deleteSkill('byte-check')
    skill_service.restoreSkill(str(out['trashId']))
    assert (isolated / 'byte-check' / 'SKILL.md').read_text('utf-8') == original
