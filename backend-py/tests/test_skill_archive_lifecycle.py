"""Skill lifecycle, second half: a retired skill is ARCHIVED (2026-10-10).

``retire`` (pinned in ``test_skill_versions_lifecycle.py``) writes a
frontmatter LABEL and leaves the file, its version history and its usage
counters exactly where they were. That is the right first step — one edit
restores it — and it is also why a skill nobody has wanted for months stays
on disk, still parsed by discovery, still listed in Settings.

This is the removal step, and it is a MOVE rather than a delete:

  * the consolidation pass files an ``archive`` proposal per agent-scope
    skill that is ``retired`` AND has stayed quiet — no usage inside
    ``skillArchiveDays`` (60) AND no write to its SKILL.md since, with no
    measured lift to argue for it;
  * approving it moves the directory into the delete trash — the SAME move
    ``deleteSkill`` performs — so the undo is the existing
    ``POST /api/skills/restore/{trashId}``;
  * nothing automatic can reach it: the kind is in ``HARD_KINDS``, held by
    the same rail that holds a delete.

Pinned here so the promise is testable rather than remembered: the archive is
reversible, the lifecycle order is enforced by the applier itself, and a
retired skill stops being OFFERED (catalogue) without becoming unreachable
(``list_all`` / ``get`` — the load door still opens, and opening it records a
use, which is what keeps a retired-but-wanted skill from ever looking stale).
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from app.main import app
from app.services import harness_rails as rails
from app.services import harness_self_improve as hsi
from app.services import skill_service
from httpx import ASGITransport, AsyncClient

_WINDOW_DAYS = 60


def _writeSkill(name: str, *, retired: bool = False, body: str = 'Do the thing.') -> Path:
    d = skill_service._agentSkillsDir() / name
    d.mkdir(parents=True, exist_ok=True)
    extra = 'status: retired\n' if retired else ''
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        'description: test skill for the archive lifecycle\n'
        'category: testing\n'
        'created_by: agent\n'
        f'{extra}'
        '---\n\n'
        f'{body}\n',
        'utf-8',
    )
    return d


def _backdate(path: Path, days: int) -> None:
    """Age a file by `days` — the archive clock is the file's own mtime."""
    when = time.time() - days * 86400
    os.utime(path, (when, when))


def _recordUse(name: str, *, days_ago: int = 0) -> None:
    sidecar = skill_service.usage_sidecar_path(name)
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    stamp = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    sidecar.write_text(f'{{"count": 3, "lastUsed": "{stamp}"}}', 'utf-8')


def _run(monkeypatch, *, enabled: bool = True, days: int = _WINDOW_DAYS) -> int:
    """The archive pass against a controlled config."""
    from app.services import brain_config_service
    from app.services.memory_store import consolidation

    monkeypatch.setattr(
        brain_config_service,
        'getRuntimeConfig',
        lambda: {'skillArchiveEnabled': enabled, 'skillArchiveDays': days},
    )
    filed, _notes = consolidation._skill_archive_pass()
    return filed


@pytest.fixture()
def skills(tmp_path, monkeypatch):
    """Sandboxed agent + bundled skill roots (the trash follows the data dir,
    which the autouse isolatedData fixture already points at tmp_path)."""
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True  # skip the repo-root flat scan
    agent_root = tmp_path / 'agent-skills'
    bundled_root = tmp_path / 'bundled-skills'
    agent_root.mkdir()
    bundled_root.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agent_root)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundled_root)
    yield agent_root
    skill_service._bust_prompt_skills_cache()


# ── the proposal kind, and who may act on it ─────────────────────────────


class TestTheKind:
    def test_archive_is_approvable_and_never_automatic(self):
        assert 'archive' in hsi.VALID_KINDS
        assert 'archive' in hsi.APPROVABLE_KINDS
        assert 'archive' in hsi._APPROVERS
        # The rails ceiling: the vocabulary minus the two auto-appliable skill
        # writes is exactly the human-only set. Adding a kind without adding it
        # to HARD_KINDS would fail this; a kind added only to HARD_KINDS could
        # not be filed at all.
        assert set(hsi.VALID_KINDS) - rails.AUTO_APPLIABLE_KINDS == rails.HARD_KINDS
        assert 'archive' in rails.HARD_KINDS
        assert 'archive' not in rails.AUTO_APPLIABLE_KINDS

    def test_autonomy_holds_an_archive_proposal_as_a_hard_kind(self, monkeypatch):
        from app.services import brain_config_service

        monkeypatch.setattr(
            brain_config_service,
            'getRuntimeConfig',
            lambda: {'skillAutonomy': True, 'autonomyBurnInCount': 0},
        )
        out = rails.auto_apply_allowed(
            {
                'kind': 'archive',
                'payload': {'name': 'any-skill'},
                'evidence': 'the user asked for this twice',
            }
        )
        assert out['allowed'] is False
        assert out['rule'] == 'hard-kind', out


# ── the applier: a move with an undo ─────────────────────────────────────


class TestTheApplier:
    def test_approving_moves_the_skill_into_the_trash(self, skills):
        from app.services.memory_store import consolidation

        name = 'arc-approved'
        _writeSkill(name, retired=True)
        _backdate(skills / name / 'SKILL.md', 90)
        assert consolidation._skill_archive_pass()[0] == 1
        row = next(p for p in hsi.list_proposals() if p['kind'] == 'archive')
        assert row['status'] == 'open'

        decided = hsi.decide_proposal(row['id'], 'approve')

        assert decided['status'] == 'applied'
        applied = decided['applyResult']
        assert applied['ok'] is True
        assert applied['action'] == 'archived'
        assert applied['trashId']
        # Gone from the skills root — not deleted, moved.
        assert not (skills / name).exists()
        trashed = skill_service._trashRoot() / str(applied['trashId']) / 'skill' / 'SKILL.md'
        assert trashed.is_file()
        assert 'status: retired' in trashed.read_text('utf-8')

    async def test_the_trash_restore_route_brings_it_back(self, skills):
        """The undo is the route a delete already uses — archive adds no new
        endpoint and no second restore path to keep in step with it."""
        from app.services.memory_store import consolidation

        name = 'arc-restored'
        _writeSkill(name, retired=True)
        _backdate(skills / name / 'SKILL.md', 90)
        consolidation._skill_archive_pass()
        row = next(p for p in hsi.list_proposals() if p['kind'] == 'archive')
        trashId = hsi.decide_proposal(row['id'], 'approve')['applyResult']['trashId']
        assert skill_service.get(name) is None

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as ac:
            resp = await ac.post(f'/api/skills/restore/{trashId}')
        assert resp.status_code == 200, resp.text
        assert resp.json()['restored'] == name
        back = skill_service.get(name)
        assert back is not None
        # It came back the way it left: still retired, still in the agent root.
        assert skill_service.skill_status(back.get('status')) == 'retired'
        assert 'Do the thing.' in str(back.get('instructions'))

    def test_a_live_skill_is_not_archivable(self, skills):
        """The lifecycle has an order. An active skill reaches archive through
        the retire proposal first, and a proposal that outlived its own
        evidence fails here rather than removing live work."""
        name = 'arc-live'
        _writeSkill(name)
        out = hsi._apply_approved({'kind': 'archive', 'id': 'prop_x', 'payload': {'name': name}})
        assert out['ok'] is False
        assert 'not retired' in out['error']
        assert (skills / name / 'SKILL.md').is_file()

    def test_a_name_outside_the_agent_root_is_refused(self, skills):
        name = 'arc-bundled'
        bundled = skill_service.SKILLS_DIR / name
        bundled.mkdir(parents=True, exist_ok=True)
        (bundled / 'SKILL.md').write_text(
            '---\nname: arc-bundled\ndescription: a bundled one\n---\n\nbody\n', 'utf-8'
        )
        out = hsi._apply_approved({'kind': 'archive', 'id': 'prop_x', 'payload': {'name': name}})
        assert out['ok'] is False
        assert 'not found in agent skills' in out['error']
        assert (bundled / 'SKILL.md').is_file()

    def test_a_proposal_without_a_name_fails_closed(self, skills):
        out = hsi._apply_approved({'kind': 'archive', 'id': 'prop_x', 'payload': {}})
        assert out['ok'] is False
        assert 'need payload.name' in out['error']


# ── the scan: quiet, not merely old ──────────────────────────────────────


class TestTheScan:
    def test_a_long_retired_skill_is_proposed(self, skills, monkeypatch):
        name = 'arc-quiet'
        _writeSkill(name, retired=True)
        _backdate(skills / name / 'SKILL.md', 90)
        assert _run(monkeypatch) == 1
        row = next(p for p in hsi.list_proposals() if p['kind'] == 'archive')
        assert name in row['problem']
        assert row['rollback'].startswith('Reject the proposal')

    def test_a_retired_skill_inside_the_window_is_not_proposed(self, skills, monkeypatch):
        _writeSkill('arc-recent', retired=True)
        _backdate(skills / 'arc-recent' / 'SKILL.md', 10)
        assert _run(monkeypatch) == 0

    def test_a_recently_loaded_retired_skill_is_not_proposed(self, skills, monkeypatch):
        """The file has been retired for a year, but it was LOADED last week —
        someone is using it, and usage is the one signal that outranks the
        label."""
        name = 'arc-used'
        _writeSkill(name, retired=True)
        _backdate(skills / name / 'SKILL.md', 400)
        _recordUse(name, days_ago=3)
        assert _run(monkeypatch) == 0

    def test_a_retired_skill_with_measured_lift_is_not_proposed(self, skills, monkeypatch):
        from app.services import turn_outcomes

        monkeypatch.setattr(turn_outcomes, 'skill_lift', lambda days=60: {'arc-lifted': 0.4})
        _writeSkill('arc-lifted', retired=True)
        _backdate(skills / 'arc-lifted' / 'SKILL.md', 200)
        assert _run(monkeypatch) == 0

    def test_a_live_skill_is_the_retire_pass_business(self, skills, monkeypatch):
        _writeSkill('arc-active')
        _backdate(skills / 'arc-active' / 'SKILL.md', 400)
        assert _run(monkeypatch) == 0

    def test_no_second_proposal_while_one_is_open(self, skills, monkeypatch):
        _writeSkill('arc-dup', retired=True)
        _backdate(skills / 'arc-dup' / 'SKILL.md', 90)
        assert _run(monkeypatch) == 1
        assert _run(monkeypatch) == 0

    def test_disabled_by_config(self, skills, monkeypatch):
        _writeSkill('arc-off', retired=True)
        _backdate(skills / 'arc-off' / 'SKILL.md', 400)
        assert _run(monkeypatch, enabled=False) == 0

    def test_the_window_is_configurable(self, skills, monkeypatch):
        _writeSkill('arc-window', retired=True)
        _backdate(skills / 'arc-window' / 'SKILL.md', 45)
        assert _run(monkeypatch, days=30) == 1
        assert _run(monkeypatch, days=90) == 0

    def test_an_unparseable_sidecar_is_not_evidence_of_staleness(self, skills, monkeypatch):
        """A recorded load with a broken timestamp is not a never-used skill;
        the retire pass skips it, and so does this one."""
        name = 'arc-garbage'
        _writeSkill(name, retired=True)
        _backdate(skills / name / 'SKILL.md', 400)
        sidecar = skill_service.usage_sidecar_path(name)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text('{"count": 3, "lastUsed": "not-a-date"}', 'utf-8')
        assert _run(monkeypatch) == 0


# ── egress: the offer is withdrawn, the skill is not ─────────────────────


class TestEgress:
    def test_a_retired_skill_leaves_the_catalogue(self, skills):
        _writeSkill('arc-egress', retired=True)
        assert all(e['name'] != 'arc-egress' for e in skill_service.catalogue())

    def test_a_retired_skill_stays_reachable(self, skills):
        """Everything that acts on the skill still sees it: the Settings list,
        the version routes, the skill tools, and the approve path that would
        set it back to active."""
        name = 'arc-reachable'
        _writeSkill(name, retired=True)
        assert any(s['name'] == name for s in skill_service.list_all())
        assert any(s['name'] == name for s in skill_service.search(enabledOnly=False))
        assert skill_service.get(name) is not None

    def test_an_active_skill_is_still_offered(self, skills):
        _writeSkill('arc-active-egress')
        assert any(e['name'] == 'arc-active-egress' for e in skill_service.catalogue())

    def test_unretiring_puts_it_back_in_front_of_the_model(self, skills):
        """Closing the loop: the egress filter follows the LABEL, so the same
        door that stopped offering it restores the offer."""
        name = 'arc-loop'
        _writeSkill(name, retired=True)
        assert all(e['name'] != name for e in skill_service.catalogue())
        skill_service.setStatus(name, 'active', actor='user', rationale='wanted it after all')
        assert any(e['name'] == name for e in skill_service.catalogue())


# ── the two config keys ──────────────────────────────────────────────────


class TestTheConfigKeys:
    def test_defaults_are_present_and_sane(self):
        from app.services.brain_config_service import _defaultsCamel, allowedKeys

        assert {'skillArchiveEnabled', 'skillArchiveDays'} <= set(allowedKeys)
        defaults = _defaultsCamel()
        assert defaults['skillArchiveEnabled'] is True
        assert defaults['skillArchiveDays'] == _WINDOW_DAYS

    def test_both_keys_are_settable_through_the_api_door(self, isolatedData):
        from app.services import memory_store
        from app.services.brain_config_service import getRuntimeConfig, saveBrainConfig

        memory_store.init()
        ok, err, merged = saveBrainConfig({'skillArchiveEnabled': False, 'skillArchiveDays': 14})
        assert ok, err
        runtime = getRuntimeConfig()
        assert runtime['skillArchiveEnabled'] is False
        assert runtime['skillArchiveDays'] == 14
        assert merged['skillArchiveEnabled'] is False
