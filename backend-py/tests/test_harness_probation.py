"""Item 14's probation: an auto-applied change that measures as a regression.

The undo is a version restore (item 13's `restoreVersion`), never a `revert`
proposal — `test_harness_revert_proposal.py` pins that the proposal applier must
not undo a learning write, and this is not that applier: it is the measurement
job putting back bytes it took, through the one route that knows how.

Four properties these tests hold it to:

  * only a change the rails themselves applied is eligible — a human approval is
    a human's to undo;
  * the kill switch stops this too. Turning autonomy off must not strand a
    regression in place, so it is handed to the human as the proposal instead;
  * if anything else touched the file since our apply, the restore is refused —
    a probation revert that clobbers a human edit is worse than the regression;
  * a version it cannot name is not restorable, so the proposal path stands.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from app.services import harness_outcome as ho
from app.services import harness_rails as rails
from app.services import harness_self_improve as hsi
from app.services import skill_service


@pytest.fixture
def brain(isolatedData):
    from app.services import memory_store

    memory_store.init()
    return isolatedData


def _ts(dt: datetime) -> str:
    return dt.strftime(ho._TS)


def _seed_episodes(rows: list[tuple[str, str]]) -> None:
    from app.services.memory_conn import conn

    c = conn()
    c.execute(
        'CREATE TABLE IF NOT EXISTS episodes ('
        '  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT,'
        '  outcome TEXT, fingerprint_id TEXT, created_at TEXT)'
    )
    for outcome, created_at in rows:
        c.execute('INSERT INTO episodes (outcome, created_at) VALUES (?, ?)', (outcome, created_at))
    c.commit()


def _skill(name: str, body: str) -> None:
    root = skill_service._agentSkillsDir()
    root.mkdir(parents=True, exist_ok=True)
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'SKILL.md').write_text(
        f'---\nname: {name}\ndescription: probation fixture\ncategory: testing\n'
        f'created_by: agent\n---\n\n{body}\n',
        'utf-8',
    )


def _live(name: str) -> str:
    return (skill_service._agentSkillsDir() / name / 'SKILL.md').read_text('utf-8')


def _ledger() -> list[dict]:
    path = hsi._proposals_dir() / 'ledger.jsonl'
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def _arm(*, autonomy: bool = True) -> None:
    from app.services.brain_config_service import bustRuntimeCache, saveBrainConfig

    ok, err, _ = saveBrainConfig(
        {'skillAutonomy': autonomy, 'autonomyBurnInCount': 0, 'autoApplyPerDay': 10}
    )
    assert ok, err
    bustRuntimeCache()


def _applied_change(name: str, *, versionTs: str | None = 'auto') -> tuple[str, str]:
    """One auto-applied skill change: the file moves, the snapshot is on disk,
    and the ledger carries the apply. Returns (proposal id, version ts)."""
    from app.services import skill_versions

    _skill(name, 'v1 body — the good one')
    d = skill_service._agentSkillDir(name)
    skill_versions.snapshot_before_write(
        d, '# changed\n\nv2 body — the regression', actor='distiller', rationale='approved apply'
    )
    (d / 'SKILL.md').write_text('---\nname: ' + name + '\n---\n\nv2 body — the regression\n', 'utf-8')
    versions = skill_versions.list_versions(d)
    ts = versions[0]['ts'] if versionTs == 'auto' else versionTs
    row = hsi.save_proposal(
        problem=f'probation: {name} needs the better flow',
        evidence='the user corrected this twice, in their own words',
        proposal='amend the body',
        rollback='restore the previous version',
        kind='skill_patch',
        payload={'name': name, 'body': 'v2 body'},
    )
    pid = str(row['id'])
    if ts is not None:
        rails.record_auto_apply(pid, name, ts)
    return pid, ts or ''


def _book_regression(pid: str, name: str) -> str:
    now = datetime.now(timezone.utc)
    _seed_episodes(
        [('resolved', _ts(now - timedelta(days=d))) for d in range(1, 11)]
        + [('unresolved', _ts(now - timedelta(days=40 - d))) for d in range(1, 11)]
    )
    key = f'proposal:{pid}'
    ho.record('proposal', key, 'skill_patch', name, 'fewer corrections', '')
    from app.services.memory_conn import conn

    conn().execute(
        'UPDATE harness_outcome SET applied_at = ? WHERE key = ?',
        (_ts(now - timedelta(days=40)), key),
    )
    conn().commit()
    return key


def _revert_proposals() -> list[dict]:
    return [
        json.loads(p.read_text(encoding='utf-8'))
        for p in hsi._proposals_dir().glob('prop_*.json')
    ]


class TestProbationRevert:
    def test_an_auto_applied_regression_puts_the_version_back(self, brain):
        _arm()
        name = 'prob-good'
        _skill(name, 'v1 body — the good one')
        original = _live(name)
        pid, ts = _applied_change(name)
        assert 'v2 body' in _live(name)
        _book_regression(pid, name)

        out = ho.measure_pending()
        assert out['v_regressed'] == 1, out
        assert _live(name) == original, 'the restore must put the file back'
        assert [p for p in _revert_proposals() if p['kind'] == 'revert'] == [], (
            'an undone change is not a question for the human'
        )
        reverts = [r for r in _ledger() if r['action'] == 'probation_revert']
        assert len(reverts) == 1 and reverts[0]['version_ts'] == ts, reverts

    def test_the_restore_is_itself_in_the_history(self, brain):
        """Undoing the undo has to stay possible, or probation quietly deletes
        the evidence the next decision needs."""
        _arm()
        name = 'prob-log'
        pid, _ts_ = _applied_change(name)
        _book_regression(pid, name)
        from app.services import skill_versions

        before = len(skill_versions.list_versions(skill_service._agentSkillDir(name)))
        ho.measure_pending()
        after = skill_versions.list_versions(skill_service._agentSkillDir(name))
        assert len(after) == before + 1, after
        assert 'restored' in after[0]['rationale'], after[0]

    def test_a_human_applied_change_is_left_to_the_human(self, brain):
        """No auto_apply row behind the outcome: nothing is written and the
        revert proposal is filed exactly as before."""
        _arm()
        name = 'prob-human'
        _skill(name, 'v1 body — the good one')
        from app.services import skill_versions

        d = skill_service._agentSkillDir(name)
        skill_versions.snapshot_before_write(
            d, 'anything', actor='user', rationale='a human edit'
        )
        (d / 'SKILL.md').write_text('---\nname: ' + name + '\n---\n\nv2 body — the regression\n', 'utf-8')
        row = hsi.save_proposal(
            problem=f'human applied {name}',
            evidence='the user corrected this twice, in their own words',
            proposal='amend the body',
            rollback='restore it',
            kind='skill_patch',
            payload={'name': name},
        )
        pid = str(row['id'])
        _book_regression(pid, name)
        out = ho.measure_pending()
        assert out['v_regressed'] == 1, out
        assert 'v2 body' in _live(name), 'the rails never touched a human change'
        assert len([p for p in _revert_proposals() if p['kind'] == 'revert']) == 1

    def test_the_kill_switch_hands_the_regression_to_the_human(self, brain):
        _arm(autonomy=False)
        name = 'prob-switch'
        pid, _ts_ = _applied_change(name)
        _book_regression(pid, name)
        assert 'v2 body' in _live(name)
        ho.measure_pending()
        assert 'v2 body' in _live(name), 'off means the machine does not write'
        assert len([p for p in _revert_proposals() if p['kind'] == 'revert']) == 1

    def test_a_file_someone_else_touched_is_not_reverted(self, brain):
        """Our snapshot must still be the newest version. If a human edited the
        skill afterwards, restoring our version would silently delete their
        work — the regression is the lesser harm."""
        _arm()
        name = 'prob-moved'
        pid, _ts_ = _applied_change(name)
        from app.services import skill_versions

        d = skill_service._agentSkillDir(name)
        skill_versions.snapshot_before_write(
            d, 'a later human edit', actor='user', rationale='edited by hand'
        )
        (d / 'SKILL.md').write_text('---\nname: ' + name + '\n---\n\na later human edit\n', 'utf-8')
        _book_regression(pid, name)
        ho.measure_pending()
        assert 'a later human edit' in _live(name)
        assert len([p for p in _revert_proposals() if p['kind'] == 'revert']) == 1

    def test_a_change_with_no_namable_version_files_instead(self, brain):
        _arm()
        name = 'prob-nots'
        _skill(name, 'v1 body — the good one')
        (skill_service._agentSkillsDir() / name / 'SKILL.md').write_text(
            '---\nname: ' + name + '\n---\n\nv2 body — the regression\n', 'utf-8'
        )
        row = hsi.save_proposal(
            problem=f'no snapshot behind {name}',
            evidence='the user corrected this twice, in their own words',
            proposal='amend the body',
            rollback='restore it',
            kind='skill_patch',
            payload={'name': name},
        )
        pid = str(row['id'])
        rails.record_auto_apply(pid, name, '')  # applied, but nothing to put back
        _book_regression(pid, name)
        ho.measure_pending()
        assert len([p for p in _revert_proposals() if p['kind'] == 'revert']) == 1


class TestTheHistory:
    def test_the_history_rows_are_readable_newest_first(self, brain):
        _arm()
        pid, ts = _applied_change('prob-hist')
        history = rails.auto_apply_history()
        assert history[0]['proposalId'] == pid, history[0]
        assert history[0]['versionTs'] == ts, history[0]
        assert history[0]['reverted'] is False, history[0]

    def test_the_history_endpoint_answers(self, brain):
        import asyncio

        _arm()
        _applied_change('prob-api')
        from app.main import app
        from httpx import ASGITransport, AsyncClient

        async def call():
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url='http://test'
            ) as ac:
                return await ac.get('/api/harness/proposals/auto-history')

        res = asyncio.run(call())
        assert res.status_code == 200, res.text
        body = res.json()
        assert body['autonomy'] is True, body
        assert body['changes'][0]['skill'] == 'prob-api', body
        assert {'at', 'skill', 'versionTs', 'reverted'} <= set(body['changes'][0]), body
