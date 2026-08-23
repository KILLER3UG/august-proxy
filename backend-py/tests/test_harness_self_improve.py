"""Regression tests: harness self-improvement loop (introspect + propose + gate).

The model can inspect its own harness and FILE proposals, but nothing applies
without an explicit human decision; approval runs the deterministic applier;
every decision lands in the curation ledger.
"""

from __future__ import annotations

import json

import pytest
from app.services.harness_self_improve import (
    APPROVABLE_KINDS,
    build_introspection,
    decide_proposal,
    format_introspection,
    save_proposal,
)


@pytest.fixture()
def proposals_dir(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', str(tmp_path), raising=False)
    return tmp_path


def _sample(kind: str = 'observation', **kw) -> dict[str, object]:
    base: dict[str, object] = {
        'problem': 'web_search descriptions exceed 300 chars and bloat every prompt',
        'evidence': 'registry audit shows web_search at 254ch but remember at 717ch',
        'proposal': 'Trim remember description to under 300 chars, move examples to docs',
        'rollback': 'Re-add the trimmed text from git history',
        'kind': kind,
    }
    base.update(kw)
    return base


def test_save_and_get_proposal_roundtrip(proposals_dir):
    row = save_proposal(**_sample())  # type: ignore[arg-type]
    assert row['status'] == 'open'
    assert row['id'].startswith('prop_')
    from app.services.harness_self_improve import get_proposal

    again = get_proposal(row['id'])
    assert again is not None
    assert again['problem'] == row['problem']


def test_proposal_requires_rollback(proposals_dir):
    bad = _sample()
    del bad['rollback']
    with pytest.raises(TypeError, match='rollback'):
        save_proposal(**bad)  # type: ignore[arg-type]


def test_proposal_rejects_unknown_kind(proposals_dir):
    with pytest.raises(ValueError, match='unknown kind'):
        save_proposal(**_sample(kind='rewrite_the_core_loop'))  # type: ignore[arg-type]


def test_decide_approve_runs_applier_for_brain_config(proposals_dir, monkeypatch):
    applied: dict[str, object] = {}

    def fake_apply(row):
        applied['kind'] = row['kind']
        return {'ok': True}

    import app.services.harness_self_improve as hsi

    monkeypatch.setattr(hsi, '_apply_approved', fake_apply)
    row = save_proposal(**_sample(kind='brain_config'))  # type: ignore[arg-type]
    out = decide_proposal(row['id'], 'approve', note='looks safe')
    assert out['status'] == 'applied'
    assert applied['kind'] == 'brain_config'
    assert out['decisionNote'] == 'looks safe'


def test_decide_reject_never_applies(proposals_dir, monkeypatch):
    import app.services.harness_self_improve as hsi

    def boom(_row):  # pragma: no cover — must never be called
        raise AssertionError('applier ran on reject')

    monkeypatch.setattr(hsi, '_apply_approved', boom)
    row = save_proposal(**_sample())
    out = decide_proposal(row['id'], 'reject')
    assert out['status'] == 'rejected'


def test_decide_twice_refused(proposals_dir):
    row = save_proposal(**_sample())
    decide_proposal(row['id'], 'dismiss')
    with pytest.raises(ValueError, match='already'):
        decide_proposal(row['id'], 'approve')


def test_human_only_kinds_rejected_by_applier(proposals_dir):
    row = save_proposal(
        problem='loop stalls after 20 rounds',
        evidence='stall telemetry in evals',
        proposal='change the reflection window',
        rollback='git revert',
        kind='observation',
    )
    out = decide_proposal(row['id'], 'approve')
    assert out['status'] == 'apply_failed'
    assert 'human-only' in str(out.get('applyResult', {}).get('error'))


def test_approved_decision_lands_in_curation_ledger(proposals_dir, monkeypatch):
    import app.services.harness_self_improve as hsi

    monkeypatch.setattr(hsi, '_apply_approved', lambda _r: {'ok': True})
    row = save_proposal(**_sample(kind='skill_patch'))
    decide_proposal(row['id'], 'approve')
    from app.services.memory import curation_ledger

    rows = curation_ledger.recent(limit=10)
    assert any(r['action'] == 'approve_proposal' and r['actor'] == 'harness_self_improve' for r in rows)


def test_introspection_reports_tools_and_open_proposals(proposals_dir):
    # The registry is empty in a bare test process — boot the real
    # registrations exactly like scripts/_audit_tool_registry does.
    from app.services.tool_definitions import registerAll

    registerAll()
    save_proposal(**_sample())
    data = build_introspection()
    assert data['tools']['total'] > 0
    assert isinstance(data['tools']['buckets'], dict)
    assert len(data['open_proposals']) == 1
    text = format_introspection(data)
    assert '<harness_introspection>' in text
    assert 'harness_propose' in text


def test_introspection_hides_secrets_from_brain_config(proposals_dir):
    data = build_introspection()
    cfg = json.dumps(data.get('brain_config', {}))
    assert 'apiKey' not in cfg
