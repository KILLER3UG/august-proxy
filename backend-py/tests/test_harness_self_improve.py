"""Tests for the harness self-improvement loop (0.17.0 rebuild)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture()
def hsi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated harness_self_improve with a temp data dir."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path / 'data'))
    from app.services import harness_self_improve as mod

    # Reset any cached settings-dependent paths.
    yield mod


def test_proposal_roundtrip_and_ledger(hsi):
    row = hsi.save_proposal(
        problem='tool descriptions too long',
        evidence='3 tools over 300ch',
        proposal='trim them',
        rollback='restore from git',
        kind='observation',
        expected_metric='audit shows 0 over 300ch',
    )
    assert row['status'] == 'open'
    assert hsi.get_proposal(row['id']) is not None
    listed = hsi.list_proposals(status='open')
    assert any(p['id'] == row['id'] for p in listed)
    ledger = hsi.read_ledger()
    assert any(r.get('action') == 'file_proposal' for r in ledger)


def test_proposal_validation_and_duplicate_guard(hsi):
    with pytest.raises(ValueError):
        hsi.save_proposal(problem='', evidence='e', proposal='p', rollback='r', kind='observation')
    with pytest.raises(ValueError):
        hsi.save_proposal(problem='p', evidence='e', proposal='p', rollback='', kind='observation')
    with pytest.raises(ValueError):
        hsi.save_proposal(problem='p', evidence='e', proposal='p', rollback='r', kind='bogus_kind')
    hsi.save_proposal(problem='same problem here', evidence='e', proposal='x', rollback='r', kind='observation')
    with pytest.raises(ValueError, match='already exists'):
        hsi.save_proposal(
            problem='same problem here ' + 'x' * 50,
            evidence='different evidence',
            proposal='y',
            rollback='r',
            kind='observation',
        )


def test_decide_reject_records_status(hsi):
    row = hsi.save_proposal(
        problem='p', evidence='e', proposal='x', rollback='r', kind='observation'
    )
    decided = hsi.decide_proposal(row['id'], 'reject', note='not now')
    assert decided['status'] == 'rejected'
    assert decided['decisionNote'] == 'not now'
    with pytest.raises(ValueError, match='already'):
        hsi.decide_proposal(row['id'], 'approve')


def test_skill_create_applier_is_visible_to_skill_service(hsi):
    from app.services import skill_service

    row = hsi.save_proposal(
        problem='need a new skill',
        evidence='missing coverage for X',
        proposal='create it',
        rollback='delete it',
        kind='skill_create',
        payload={
            'name': 'harness-loop-test-skill',
            'description': 'Created by the harness loop test.',
            'body': '# Body\ndo things',
            'trigger': 'when testing',
        },
    )
    res = hsi.decide_proposal(row['id'], 'approve')
    assert res['status'] == 'applied'
    assert res['applyResult']['ok'] is True

    skill = skill_service.get('harness-loop-test-skill')
    assert skill is not None
    assert skill.get('created_by') == 'harness-proposal'
    assert 'do things' in str(skill.get('instructions'))


def test_skill_proposals_reject_traversal_names_at_save_time(hsi):
    # §9 F-2: the queue must never hold a live weapon — skill-kind proposals
    # whose payload.name fails _validateName are rejected at file time.
    for kind in ('skill_create', 'skill_patch', 'skill_delete'):
        with pytest.raises(ValueError, match='name'):
            hsi.save_proposal(
                problem=f'traversal {kind}', evidence='e', proposal='p',
                rollback='r', kind=kind, payload={'name': '..'},
            )
        with pytest.raises(ValueError, match='name'):
            hsi.save_proposal(
                problem=f'separator {kind}', evidence='e', proposal='p',
                rollback='r', kind=kind, payload={'name': 'a/b\\c'},
            )


def test_skill_delete_applier_refuses_traversal_and_deletes_normally(hsi, tmp_path, monkeypatch):
    victim = tmp_path / 'victim-dir' / 'keep'
    victim.mkdir(parents=True)
    agent_root = tmp_path / 'agent-skills'
    skill_dir = agent_root / 'del-me'
    skill_dir.mkdir(parents=True)
    (skill_dir / 'SKILL.md').write_text('---\nname: del-me\ndescription: d\n---\nbody\n', 'utf-8')
    monkeypatch.setattr('app.services.skill_service._agentSkillsDir', lambda: agent_root)

    # Direct applier defense-in-depth: a row that bypassed save_proposal.
    res = hsi._apply_approved({'kind': 'skill_delete', 'payload': {'name': '..'}})
    assert res['ok'] is False
    assert victim.exists()

    res = hsi._apply_approved({'kind': 'skill_delete', 'payload': {'name': 'del-me'}})
    assert res['ok'] is True
    assert not skill_dir.exists()
    assert victim.exists()


def test_brain_config_requires_payload(hsi):
    row = hsi.save_proposal(
        problem='tweak loops', evidence='e', proposal='set 20 rounds',
        rollback='reset', kind='brain_config', payload={},
    )
    res = hsi.decide_proposal(row['id'], 'approve')
    assert res['status'] == 'apply_failed'
    assert 'payload.patch' in res['applyResult']['error']


def test_observation_kinds_never_apply(hsi):
    row = hsi.save_proposal(
        problem='flow map gap', evidence='e', proposal='document it',
        rollback='n/a', kind='flow_map',
    )
    res = hsi.decide_proposal(row['id'], 'approve')
    assert res['status'] == 'apply_failed'


def test_introspection_includes_flow_map_and_registry(hsi):
    from app.services import tool_registrations

    tool_registrations.register_all()
    data = hsi.build_introspection()
    assert 'broken_registrations' in data['tools']
    flow = data['flow_map']
    assert flow['max_tool_rounds_per_turn'] >= 1
    assert 'research' in flow['phases']
    text = hsi.format_introspection(data)
    assert '<harness_introspection>' in text
    assert 'flow:' in text


def test_scheduled_pass_files_once_then_dedupes(hsi, monkeypatch: pytest.MonkeyPatch):
    fake = {
        'tools': {
            'total': 5,
            'buckets': {},
            'descriptions_over_300ch': ['big(500ch)'],
            'broken_registrations': ['ghost'],
        },
        'skills': {'total': 1, 'evolving': 0, 'descriptions_over_300ch': ['sk(400ch)']},
    }
    monkeypatch.setattr(hsi, 'build_introspection', lambda: fake)
    assert hsi._run_scheduled_pass() == 1
    assert hsi._run_scheduled_pass() == 0  # deduped against the open one
    open_rows = hsi.list_proposals(status='open')
    assert len(open_rows) == 1
    assert open_rows[0]['kind'] == 'observation'


def test_open_proposals_are_never_pruned(hsi, monkeypatch: pytest.MonkeyPatch):
    ids: list[str] = []
    for i in range(4):
        row = hsi.save_proposal(
            problem=f'problem {i}', evidence='e', proposal='x', rollback='r', kind='observation'
        )
        ids.append(row['id'])
        # age the file so pruning order is deterministic
        p = hsi._proposals_dir() / f"{row['id']}.json"
        old = p.stat().st_mtime - (i + 1) * 100
        import os

        os.utime(p, (old, old))
    # decide two → they become prunable; keep cap tiny via direct call
    hsi.decide_proposal(ids[0], 'dismiss')
    hsi.decide_proposal(ids[1], 'reject')
    hsi._prune_old_proposals(keep=2)
    remaining = {p['id'] for p in hsi.list_proposals()}
    # The two OPEN proposals must survive even though they are oldest.
    assert ids[2] in remaining and ids[3] in remaining
