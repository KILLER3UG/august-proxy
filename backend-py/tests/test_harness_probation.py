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

    # Both ceiling kinds: these tests are about probation and the history, not
    # the per-kind gate, and one of them applies a skill_create.
    ok, err, _ = saveBrainConfig({
        'skillAutonomy': autonomy,
        'autonomyBurnInCount': 0,
        'autoApplyPerDay': 10,
        'autonomyKinds': 'skill_patch,skill_create',
    })
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
        # The same four arguments review_proposal passes on a real auto-apply.
        rails.record_auto_apply(pid, name, ts, rails.finding_key(row))
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


class TestTheAnnouncement:
    """Item 15's chip is fed by two things: the live event and the history read.
    Both must say the same thing, and the event must carry the version id — a
    chip that cannot name what to put back is an announcement without an undo."""

    def test_an_auto_apply_announces_itself_with_the_version_to_put_back(
        self, brain, monkeypatch
    ):
        _arm()
        events: list = []
        monkeypatch.setattr(
            'app.services.realtime_bus.emit_realtime',
            lambda t, **kw: events.append((t, kw)),
        )
        name = 'prob-announce'
        _skill(name, 'v1 body — the good one')
        row = hsi.save_proposal(
            problem=f'the {name} skill rebuilds when it should restart',
            evidence='the user corrected this twice, in their own words',
            proposal='amend the body to restart only',
            rollback='restore the previous version',
            kind='skill_patch',
            payload={
                'name': name,
                'description': 'container flow',
                'body': '# Prob announce\n\nRestart the container instead of rebuilding.\n',
                'trigger': 'container',
                'episodeIds': [_trustedEpisodeId()],
            },
        )
        pid = str(row['id'])
        _patchReviewer(monkeypatch, 'KEEP — durable and justified')

        out = hsi.run_reviewer_pass()
        assert out['applied'] == 1, out
        evolved = [kw for t, kw in events if t == 'skill-evolved']
        assert len(evolved) == 1, events
        assert evolved[0]['skill'] == name, evolved
        assert evolved[0]['proposalId'] == pid, evolved
        assert evolved[0]['versionTs'], 'the undo needs the id the snapshot took'
        # The bridge's forward-compatible default case invalidates these keys,
        # which is how a change made by the 6-hour job reaches an open window.
        assert evolved[0]['queryKeys'] == ['harness-auto-history'], evolved

    def test_a_human_approval_is_not_an_auto_change(self, brain, monkeypatch):
        """No event and no history row: a change the human made is not news the
        machine announces, and it must not consume the daily budget either."""
        _arm()
        events: list = []
        monkeypatch.setattr(
            'app.services.realtime_bus.emit_realtime',
            lambda t, **kw: events.append((t, kw)),
        )
        name = 'prob-human-only'
        _skill(name, 'v1 body — the good one')
        row = hsi.save_proposal(
            problem=f'the {name} skill needs a note',
            evidence='the user asked for it directly',
            proposal='amend the body',
            rollback='restore the previous version',
            kind='skill_patch',
            payload={'name': name, 'body': 'anything'},
        )
        pid = str(row['id'])
        hsi.decide_proposal(pid, 'approve', actor='human')
        assert [t for t, _kw in events if t == 'skill-evolved'] == []
        assert rails.auto_apply_history() == []


def _trustedEpisodeId() -> int:
    from app.services import episode_miner

    return episode_miner.save_episode(
        {
            'session_id': 'ses_announce',
            'kind': 'user_correction',
            'start_message_id': 1,
            'end_message_id': 3,
            'events': [{'role': 'user', 'text': "Don't rebuild, just restart the container."}],
            'outcome': 'resolved',
            'fingerprint_id': 'fp-announce',
        }
    )


def _patchReviewer(monkeypatch, reply: str) -> None:
    class _Client:
        async def __call__(self, prompt):
            return reply

    monkeypatch.setattr(
        'app.services.harness_self_improve.resolve_independent_reviewer',
        lambda producer, hint='': (_Client(), ''),
    )


class TestTheCooldownEndToEnd:
    """The cooldown only works if the revert row carries the same key the next
    filing computes. That is an end-to-end property, so it is tested through the
    measurement job rather than by hand-writing a ledger row."""

    def test_a_reverted_finding_cannot_re_apply_the_next_morning(self, brain, monkeypatch):
        _arm()
        name = 'prob-cooldown'
        pid, _ts_ = _applied_change(name)
        _book_regression(pid, name)
        out = ho.measure_pending()
        assert out['v_regressed'] == 1, out

        reverts = [r for r in _ledger() if r['action'] == 'probation_revert']
        assert len(reverts) == 1, reverts
        assert reverts[0]['finding_key'], 'a revert with no key bars nothing'

        # The same finding, re-filed after the daily rail would have reset. The
        # identity is skill + problem text (this fixture has no fingerprint), so
        # the re-filing says exactly what the reverted one said.
        _mark_applied(pid)
        again = hsi.save_proposal(
            problem=f'probation: {name} needs the better flow',
            evidence='the user corrected this twice, in their own words',
            proposal='amend the body to restart only',
            rollback='restore the previous version',
            kind='skill_patch',
            payload={
                'name': name,
                'description': 'container flow',
                'body': '# Prob cooldown\n\nRestart instead of rebuilding.\n',
                'trigger': 'container',
                'episodeIds': [_trustedEpisodeId()],
            },
        )
        verdict = rails.auto_apply_allowed(hsi.get_proposal(str(again['id'])))
        assert verdict['allowed'] is False, verdict
        assert verdict['rule'] == 'probation-cooldown', verdict


def _mark_applied(pid: str) -> None:
    row = hsi.get_proposal(pid)
    row['status'] = 'applied'
    (hsi._proposals_dir() / f"{row['id']}.json").write_text(
        json.dumps(row, ensure_ascii=False), encoding='utf-8'
    )


class TestACreateIsAnnouncedWithItsOwnUndo:
    """Item 4: a created skill has no earlier version to restore, so its undo is
    a soft disable through the same enable/disable path the Skills page uses —
    never a delete, which would take the user's file with it."""

    def test_the_history_names_a_create_as_a_create(self, brain, monkeypatch):
        _arm()
        name = 'created-undo'
        row = hsi.save_proposal(
            problem=f'the {name} flow deserves a skill',
            evidence='the user corrected this twice, in their own words',
            proposal='create the skill',
            rollback='disable it again',
            kind='skill_create',
            payload={
                'name': name,
                'description': 'container flow',
                'body': f'# {name}\n\nRestart instead of rebuilding.\n',
                'trigger': 'container',
                'episodeIds': [_trustedEpisodeId()],
            },
        )
        pid = str(row['id'])

        class _Client:
            async def __call__(self, prompt):
                return 'KEEP — durable and justified'

        monkeypatch.setattr(
            'app.services.harness_self_improve.resolve_independent_reviewer',
            lambda producer, hint='': (_Client(), ''),
        )
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 1, out
        history = rails.auto_apply_history()
        mine = [h for h in history if h['proposalId'] == pid]
        assert len(mine) == 1, history
        assert mine[0]['created'] is True, mine[0]
        # A create takes no snapshot, so there is genuinely nothing to restore.
        assert mine[0]['versionTs'] == '', mine[0]

    def test_a_patch_is_named_as_a_patch(self, brain, monkeypatch):
        _arm()
        name = 'patched-undo'
        # The live file exists, so the applier's own snapshot gives this change a
        # version to put back — which is exactly what distinguishes it from a
        # create in the history.
        _skill(name, 'v1 body — the good one')
        row = hsi.save_proposal(
            problem=f'the {name} skill rebuilds too often',
            evidence='the user corrected this twice, in their own words',
            proposal='amend the body',
            rollback='restore the previous version',
            kind='skill_patch',
            payload={
                'name': name,
                'description': 'container flow',
                'body': f'# {name}\n\nRestart instead of rebuilding.\n',
                'trigger': 'container',
                'episodeIds': [_trustedEpisodeId()],
            },
        )
        pid = str(row['id'])

        class _Client:
            async def __call__(self, prompt):
                return 'KEEP — durable and justified'

        monkeypatch.setattr(
            'app.services.harness_self_improve.resolve_independent_reviewer',
            lambda producer, hint='': (_Client(), ''),
        )
        out = hsi.run_reviewer_pass()
        assert out['applied'] == 1, out
        mine = [h for h in rails.auto_apply_history() if h['proposalId'] == pid]
        assert mine[0]['created'] is False, mine[0]
        assert mine[0]['versionTs'], 'a patch has a version to put back'
