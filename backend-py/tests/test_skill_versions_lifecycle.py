"""Skill version history + lifecycle (audit P2#13, and C4's applier registry).

Pinned here:
  * ``snapshot_before_write`` records the PREVIOUS content, is a no-op on a
    create or an identical write, and caps history at 20 with the snapshot
    FILE pruned alongside its record;
  * both version endpoints answer with exactly the documented shapes, and 404
    for an unknown skill or an unknown version;
  * ``status:`` reads active when absent, rides list_all, and only
    ``setStatus`` writes it;
  * retirement is PROPOSAL-ONLY: the consolidation pass files, the file is
    untouched, and approving is what writes ``status: retired``;
  * ``_apply_approved`` is a dispatcher: unknown kinds name the appliable
    ones, human-only kinds keep their refusal, and every approvable kind has
    a registry entry.
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services import skill_service, skill_versions
from httpx import ASGITransport, AsyncClient


def _writeAgentSkill(name: str, body: str = 'Do the thing.', extra: str = '') -> None:
    root = skill_service._agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        '---\n'
        f'name: {name}\n'
        'description: test skill for version history\n'
        'category: testing\n'
        'created_by: agent\n'
        f'{extra}'
        '---\n\n'
        f'{body}\n',
        'utf-8',
    )


@pytest.fixture()
def skills():
    skill_service._bust_prompt_skills_cache()
    skill_service._flat_migrate_done = True  # skip the repo-root flat scan
    yield
    skill_service._bust_prompt_skills_cache()


# ── snapshot_before_write ────────────────────────────────────────────────


def test_snapshot_stores_the_previous_content(skills):
    _writeAgentSkill('ver-snap', body='first body')
    d = skill_service._agentSkillDir('ver-snap')
    original = (d / 'SKILL.md').read_text('utf-8')

    skill_versions.snapshot_before_write(
        d, '---\nname: ver-snap\n---\n\nsecond body\n', actor='user', rationale='edit'
    )
    versions = skill_versions.list_versions(d)
    assert len(versions) == 1
    entry = versions[0]
    assert entry['actor'] == 'user'
    assert entry['rationale'] == 'edit'
    assert len(entry['sha']) == 64
    assert skill_versions.read_version(d, entry['ts']) == original


def test_snapshot_is_a_noop_for_a_create(skills):
    d = skill_service._agentSkillsDir() / 'ver-create'
    d.mkdir(parents=True, exist_ok=True)
    skill_versions.snapshot_before_write(d, 'brand new', actor='user', rationale='create')
    assert skill_versions.list_versions(d) == []


def test_snapshot_is_a_noop_for_an_identical_write(skills):
    _writeAgentSkill('ver-identical', body='same')
    d = skill_service._agentSkillDir('ver-identical')
    same = (d / 'SKILL.md').read_text('utf-8')
    skill_versions.snapshot_before_write(d, same, actor='user', rationale='no-op')
    assert skill_versions.list_versions(d) == []


def test_history_is_capped_and_prunes_the_oldest(skills):
    _writeAgentSkill('ver-cap')
    d = skill_service._agentSkillDir('ver-cap')
    for i in range(skill_versions.MAX_VERSIONS + 5):
        skill_versions.snapshot_before_write(
            d, f'revision {i}', actor='user', rationale=f'edit {i}'
        )
    versions = skill_versions.list_versions(d)
    assert len(versions) == skill_versions.MAX_VERSIONS
    # Newest first, and every record still has its file.
    stamps = [v['ts'] for v in versions]
    assert stamps == sorted(stamps, reverse=True)
    assert all(skill_versions.read_version(d, ts) is not None for ts in stamps)
    # The pruned snapshot is GONE, not just unlisted.
    files = sorted(p.stem for p in (d / '.versions').glob('*.md'))
    assert len(files) == skill_versions.MAX_VERSIONS


def test_read_version_refuses_a_non_timestamp(skills):
    _writeAgentSkill('ver-traversal')
    d = skill_service._agentSkillDir('ver-traversal')
    assert skill_versions.read_version(d, '../../etc/passwd') is None
    assert skill_versions.read_version(d, 'abc') is None


def test_patchSkill_snapshots_before_it_writes(skills):
    _writeAgentSkill('ver-patch', body='original body')
    d = skill_service._agentSkillDir('ver-patch')
    before = (d / 'SKILL.md').read_text('utf-8')

    skill_service.patchSkill('ver-patch', body='rewritten body')
    versions = skill_versions.list_versions(d)
    assert len(versions) == 1
    assert versions[0]['actor'] == 'user'
    assert skill_versions.read_version(d, versions[0]['ts']) == before
    assert 'rewritten body' in (d / 'SKILL.md').read_text('utf-8')


# ── endpoints ────────────────────────────────────────────────────────────


async def test_versions_endpoint_shape(skills):
    _writeAgentSkill('ver-api', body='v1 body')
    d = skill_service._agentSkillDir('ver-api')
    skill_service.patchSkill('ver-api', body='v2 body')

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        res = await ac.get('/api/skills/ver-api/versions')
    assert res.status_code == 200
    body = res.json()
    assert list(body.keys()) == ['versions']
    entry = body['versions'][0]
    assert set(entry.keys()) == {'ts', 'actor', 'rationale', 'sha'}
    assert all(isinstance(entry[k], str) for k in entry)
    assert entry['ts'] == skill_versions.list_versions(d)[0]['ts']


async def test_versions_endpoint_404_for_unknown_skill(skills):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        res = await ac.get('/api/skills/no-such-skill-anywhere/versions')
    assert res.status_code == 404


async def test_diff_endpoint_returns_a_unified_diff(skills):
    _writeAgentSkill('ver-diff', body='alpha line')
    skill_service.patchSkill('ver-diff', body='beta line')
    ts = skill_versions.list_versions(skill_service._agentSkillDir('ver-diff'))[0]['ts']

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        res = await ac.get(f'/api/skills/ver-diff/versions/{ts}/diff')
    assert res.status_code == 200
    body = res.json()
    assert list(body.keys()) == ['diff']
    diff = body['diff']
    assert isinstance(diff, str) and diff
    assert diff.startswith('--- ')
    assert '+++ ' in diff
    assert '@@' in diff
    assert '-alpha line' in diff
    assert '+beta line' in diff


async def test_diff_endpoint_404_for_unknown_version(skills):
    _writeAgentSkill('ver-diff-404')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        res = await ac.get('/api/skills/ver-diff-404/versions/1/diff')
    assert res.status_code == 404


async def test_diff_endpoint_404_for_unknown_skill(skills):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        res = await ac.get('/api/skills/nope-nope/versions/1/diff')
    assert res.status_code == 404


# ── lifecycle ────────────────────────────────────────────────────────────


def test_absent_status_reads_active(skills):
    _writeAgentSkill('lc-absent')
    entry = next(s for s in skill_service.list_all() if s['name'] == 'lc-absent')
    # The parse hands the raw value through (the curator report has its own
    # vocabulary on this key); skill_status is what narrows it, and absent
    # narrows to active — a skill written before the field existed is not a
    # draft.
    assert entry['status'] == ''
    assert skill_service.skill_status(entry['status']) == 'active'
    # Still in the parse bag: the frontmatter round-trip needs it there.
    assert 'status' not in (entry['meta'] or {})
    cat = next(e for e in skill_service.catalogue() if e['name'] == 'lc-absent')
    assert cat['status'] == 'active'


def test_status_is_surfaced_in_list_all(skills):
    _writeAgentSkill('lc-retired', extra='status: retired\n')
    entry = next(s for s in skill_service.list_all() if s['name'] == 'lc-retired')
    assert entry['status'] == 'retired'
    assert entry['meta']['status'] == 'retired'


def test_unknown_status_falls_back_to_active(skills):
    _writeAgentSkill('lc-bogus', extra='status: banana\n')
    entry = next(s for s in skill_service.list_all() if s['name'] == 'lc-bogus')
    assert skill_service.skill_status(entry['status']) == 'active'


async def test_api_status_is_the_lifecycle_vocabulary(skills):
    _writeAgentSkill('lc-api-status', extra='status: superseded\n')
    _writeAgentSkill('lc-api-status-2', extra='status: banana\n')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        listed = (await ac.get('/api/skills')).json()['skills']
        one = (await ac.get('/api/skills/lc-api-status')).json()
    by_name = {s['name']: s for s in listed}
    assert by_name['lc-api-status']['status'] == 'superseded'
    # Unrecognised and absent both read 'active' on the wire.
    assert by_name['lc-api-status-2']['status'] == 'active'
    assert one['status'] == 'superseded'


def test_setStatus_writes_the_label_and_snapshots(skills):
    _writeAgentSkill('lc-set', body='body text')
    d = skill_service._agentSkillDir('lc-set')
    before = (d / 'SKILL.md').read_text('utf-8')

    skill_service.setStatus('lc-set', 'retired', actor='curator', rationale='no loads')
    assert 'status: retired' in (d / 'SKILL.md').read_text('utf-8')
    assert 'body text' in (d / 'SKILL.md').read_text('utf-8')  # body untouched
    versions = skill_versions.list_versions(d)
    assert len(versions) == 1
    assert versions[0]['actor'] == 'curator'
    assert skill_versions.read_version(d, versions[0]['ts']) == before

    # Reversible: the file was never deleted, so re-activating is a label flip.
    skill_service.setStatus('lc-set', 'active')
    assert 'status: active' in (d / 'SKILL.md').read_text('utf-8')
    assert (d / 'SKILL.md').exists()


def test_setStatus_rejects_a_value_outside_the_vocabulary(skills):
    _writeAgentSkill('lc-bad-set')
    with pytest.raises(skill_service.SkillValidationError):
        skill_service.setStatus('lc-bad-set', 'deleted-forever')


def test_patch_does_not_invent_a_status(skills):
    _writeAgentSkill('lc-noinvent')
    skill_service.patchSkill('lc-noinvent', description='a different description')
    text = (skill_service._agentSkillDir('lc-noinvent') / 'SKILL.md').read_text('utf-8')
    assert 'status:' not in text


# ── retirement is proposal-only ──────────────────────────────────────────


def test_retire_pass_files_and_changes_nothing(skills):
    from app.services.harness_self_improve import list_proposals
    from app.services.memory_store import consolidation

    _writeAgentSkill('lc-never-loaded', body='nobody loads me')
    d = skill_service._agentSkillDir('lc-never-loaded')
    before = (d / 'SKILL.md').read_text('utf-8')

    filed, notes = consolidation._skill_retire_pass()
    assert filed == 1
    assert any('lc-never-loaded' in n for n in notes)
    # THE point: the file is byte-identical after the pass ran.
    assert (d / 'SKILL.md').read_text('utf-8') == before
    assert 'status: retired' not in before

    rows = [p for p in list_proposals() if p['kind'] == 'retire']
    assert [p['payload']['name'] for p in rows] == ['lc-never-loaded']


def test_retire_pass_skips_a_skill_with_measured_lift(skills, monkeypatch):
    from app.services.memory_store import consolidation
    from app.services.turn_outcomes import skill_lift

    _writeAgentSkill('lc-has-lift')
    monkeypatch.setattr('app.services.turn_outcomes.skill_lift', lambda days=30: {'lc-has-lift': 0.4})
    assert consolidation._skill_retire_candidates() == []


def test_retire_pass_skips_a_recently_loaded_skill(skills):
    from datetime import datetime, timezone

    from app.services.memory_store import consolidation

    _writeAgentSkill('lc-used')
    usage = skill_service.usage_sidecar_path('lc-used')
    usage.parent.mkdir(parents=True, exist_ok=True)
    usage.write_text(
        '{"count": 3, "lastUsed": "%s"}' % datetime.now(timezone.utc).isoformat(), 'utf-8'
    )
    names = [c['name'] for c in consolidation._skill_retire_candidates()]
    assert 'lc-used' not in names


def test_approving_a_retire_proposal_sets_the_status(skills):
    from app.services.harness_self_improve import decide_proposal, list_proposals
    from app.services.memory_store import consolidation

    _writeAgentSkill('lc-approve', body='still here')
    consolidation._skill_retire_pass()
    row = next(p for p in list_proposals() if p['kind'] == 'retire')
    assert row['status'] == 'open'

    decided = decide_proposal(row['id'], 'approve')
    assert decided['status'] == 'applied'
    text = (skill_service._agentSkillDir('lc-approve') / 'SKILL.md').read_text('utf-8')
    assert 'status: retired' in text
    assert 'still here' in text  # retirement is a label, not a delete
    assert next(s for s in skill_service.list_all() if s['name'] == 'lc-approve')['status'] == 'retired'


def test_retire_is_appliable_but_never_automatic(skills):
    from app.services import harness_self_improve as hsi

    assert 'retire' in hsi.VALID_KINDS
    assert 'retire' in hsi.APPROVABLE_KINDS
    assert 'retire' in hsi._APPROVERS


# ── C4: the applier registry ─────────────────────────────────────────────


def test_registry_covers_every_approvable_and_promotion_kind(skills):
    from app.services import harness_self_improve as hsi

    for kind in sorted(hsi.APPROVABLE_KINDS | hsi.PROMOTION_KINDS):
        assert kind in hsi._APPROVERS, f'{kind} has no applier'


def test_unknown_kind_names_the_appliable_ones(skills):
    from app.services import harness_self_improve as hsi

    out = hsi._apply_approved({'kind': 'skill_rewrite_everything', 'payload': {}})
    assert out['ok'] is False
    assert 'no applier' in out['error']
    assert 'skill_patch' in out['error']


def test_human_only_kinds_keep_their_refusal(skills):
    from app.services import harness_self_improve as hsi

    for kind in ('revert', 'observation'):
        out = hsi._apply_approved({'kind': kind, 'payload': {}})
        assert out['ok'] is False
        assert 'human-only' in out['error']


def test_dispatcher_passes_the_whole_row_to_the_handler(skills):
    from app.services import harness_self_improve as hsi

    seen: list[dict] = []

    def _spy(row):
        seen.append(row)
        return {'ok': True}

    hsi._APPROVERS['brain_config'] = _spy
    try:
        row = {'kind': 'brain_config', 'id': 'prop_x', 'payload': {'patch': {}}}
        assert hsi._apply_approved(row) == {'ok': True}
        assert seen == [row]
    finally:
        hsi._APPROVERS['brain_config'] = hsi._apply_brain_config


# ── the learned-skill write path ─────────────────────────────────────────


def test_approved_skill_patch_snapshots_and_keeps_provenance(skills):
    from app.services import harness_self_improve as hsi

    created = hsi._apply_approved(
        {
            'kind': 'skill_create',
            'payload': {
                'name': 'lc-learned',
                'description': 'a learned skill for the applier test',
                'body': 'Do the learned thing.',
                'trigger': 'learned thing',
            },
        }
    )
    assert created['ok'] is True
    d = skill_service._agentSkillDir('lc-learned')
    v1 = (d / 'SKILL.md').read_text('utf-8')
    assert 'version: 1' in v1
    assert 'status: active' in v1

    patched = hsi._apply_approved(
        {
            'kind': 'skill_patch',
            'payload': {
                'name': 'lc-learned',
                'description': 'a learned skill for the applier test',
                'body': 'Do the learned thing, revised.',
            },
        }
    )
    assert patched['ok'] is True
    assert patched['version'] == 2
    text = (d / 'SKILL.md').read_text('utf-8')
    # The frontmatter this write replaced is on disk...
    versions = skill_versions.list_versions(d)
    assert len(versions) == 1
    assert versions[0]['actor'] == 'distiller'
    assert skill_versions.read_version(d, versions[0]['ts']) == v1
    # ...and the fields the proposal was silent about survived the rewrite.
    assert 'version: 2' in text
    assert 'trigger: learned thing' in text
    assert 'status: active' in text


def test_approved_patch_revives_a_retired_skill(skills):
    from app.services import harness_self_improve as hsi

    hsi._apply_approved(
        {'kind': 'skill_create', 'payload': {'name': 'lc-revive', 'body': 'Body.'}}
    )
    d = skill_service._agentSkillDir('lc-revive')
    skill_service.setStatus('lc-revive', 'retired')
    out = hsi._apply_approved(
        {'kind': 'skill_patch', 'payload': {'name': 'lc-revive', 'body': 'Fresh body.'}}
    )
    assert out['ok'] is True
    text = (d / 'SKILL.md').read_text('utf-8')
    assert 'status: retired' in text  # a patch is not a resurrection
    assert 'Fresh body.' in text


def test_retire_applier_refuses_a_skill_it_cannot_edit(skills):
    from app.services import harness_self_improve as hsi

    out = hsi._apply_approved({'kind': 'retire', 'payload': {'name': 'no-such-skill'}})
    assert out['ok'] is False
    assert 'not found' in out['error']
    assert hsi._apply_approved({'kind': 'retire', 'payload': {}})['ok'] is False
