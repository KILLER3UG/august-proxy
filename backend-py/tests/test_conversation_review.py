"""The conversation-review pass — the loop's only POSITIVE trigger.

Every other learning pass is triggered by something going wrong: a flagged
episode, an filed observation, a failing automation. Nothing read a session that
went *well*, which is mechanically why the fact store stayed empty while
hundreds of real turns passed. These tests pin the four things that make that
safe to run on a cadence: it is off until armed, it reads one session and
advances past it, the verdicts land in that session's own scope, and a memory
still has to clear the write bar.

No model calls: `_run_judge_sync` is patched at the seam the pass actually uses.
"""

from __future__ import annotations

import json

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture()
def noProposals(monkeypatch, tmp_path):
    from app.services import skill_service

    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
    yield


def _seed(sessionId: str, rows: list[tuple[str, str]]) -> list[int]:
    """One session and its transcript; returns the message ids in order."""
    conn = sd._conn()
    conn.execute('INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)', (sessionId, 't'))
    ids: list[int] = []
    for role, content in rows:
        cur = conn.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (sessionId, role, content),
        )
        ids.append(int(cur.lastrowid))
    return ids


def _arm(monkeypatch, on: bool = True) -> None:
    from app.services import brain_config_service as bcs

    values = {'memoryReview': on, 'skillLearning': 'propose'}
    monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: dict(values))


class TestDefaultOff:
    """A rule that ends nothing but spends a model call on a schedule is opt-in,
    the same way `runawayNudgeRounds` is. An absent key means OFF."""

    def test_an_absent_config_key_means_off_not_the_shipped_default(self, brain, monkeypatch):
        from app.services import brain_config_service as bcs

        monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {})
        assert sd.run_review_pass()['status'] == 'disabled'

    def test_the_shipped_brain_config_default_is_off(self):
        from app.services.brain_config_service import fieldTable

        entry = next((row for row in fieldTable if row[0] == 'memoryReview'), None)
        assert entry is not None, 'memoryReview has no fieldTable row, so the API cannot set it'
        assert entry[2] is False, entry
        assert entry[3] == 'bool'

    def test_skill_learning_off_stops_the_review_too(self, brain, monkeypatch):
        from app.services import brain_config_service as bcs

        monkeypatch.setattr(bcs, 'getRuntimeConfig', lambda: {'memoryReview': True, 'skillLearning': 'off'})
        assert sd.run_review_pass()['status'] == 'skillLearning-off'

    def test_disabled_means_no_judge_call(self, brain, monkeypatch):
        _arm(monkeypatch, on=False)
        called: list[str] = []
        monkeypatch.setattr(sd, '_run_judge_sync', lambda *a, **k: called.append('x') or {})
        _seed('s-off', [('user', 'I always want the terse answer.')])
        sd.run_review_pass()
        assert called == []


class TestWhatItReads:
    def test_one_session_per_pass_starting_from_the_cursor(self, brain, monkeypatch):
        _arm(monkeypatch)
        _seed('s-old', [('user', 'oldest turn')])
        prompts: list[str] = []

        def fakeJudge(prompt: str, system: str = '') -> dict:
            prompts.append(prompt)
            return {'verdicts': [{'episode': 1, 'action': 'none'}]}

        monkeypatch.setattr(sd, '_run_judge_sync', fakeJudge)
        _seed('s-new', [('user', 'newest turn')])
        out = sd.run_review_pass()
        assert out['session'] == 's-new'
        assert 'newest turn' in prompts[0]
        assert 'oldest turn' not in prompts[0]

    def test_the_rendered_window_carries_role_and_message_id(self, brain, monkeypatch):
        _arm(monkeypatch)
        ids = _seed(
            's-win',
            [('user', 'use pytest -n auto always'), ('assistant', 'noted'), ('tool', 'ran the suite')],
        )
        window, newest = sd._reviewWindow('s-win', 0)
        assert newest == ids[-1]
        assert f"[{ids[0]}] user: use pytest -n auto always" in window
        assert '[2]' in window or f"[{ids[1]}] assistant: noted" in window

    def test_the_cursor_advances_so_a_session_is_not_reread(self, brain, monkeypatch):
        _arm(monkeypatch)
        seen: list[str] = []

        def fakeJudge(prompt: str, system: str = '') -> dict:
            seen.append(prompt)
            return {'verdicts': [{'episode': 1, 'action': 'none'}]}

        monkeypatch.setattr(sd, '_run_judge_sync', fakeJudge)
        _seed('s-once', [('user', 'a preference stated once')])
        first = sd.run_review_pass()
        second = sd.run_review_pass()
        assert len(seen) == 1, 'the second pass spent a second model call on the same window'
        assert second['status'] == 'idle'
        assert first['upToMessage'] > 0

    def test_an_empty_window_still_moves_the_cursor(self, brain, monkeypatch):
        """Rows with no text at all (tool acks) must not be re-read forever."""
        _arm(monkeypatch)
        called: list[str] = []
        monkeypatch.setattr(sd, '_run_judge_sync', lambda *a, **k: called.append('x') or {})
        ids = _seed('s-blank', [('tool', '   '), ('tool', '')])
        out = sd.run_review_pass()
        assert out['status'] == 'idle'
        assert called == []
        assert sd._reviewCursors().get('s-blank') == ids[-1]

    def test_a_second_session_is_not_skipped_when_the_first_resumes(self, brain, monkeypatch):
        """The cursor is PER SESSION, and this is the shape that proves why.

        One global high-water id reads B (the newest session) and then jumps past
        every A message below it, so the return to A — and A itself, once B is
        newer — is never learned from. Interleave the rows the way a real
        multitask session produces them and require both to be read.
        """
        _arm(monkeypatch)
        read: list[str] = []
        monkeypatch.setattr(
            sd,
            '_reviewWindow',
            lambda session_id, cursor: read.append(session_id) or (f'window for {session_id}', 999),
        )
        monkeypatch.setattr(
            sd,
            'apply_verdict',
            lambda verdict, fingerprint, mode='propose', scope='': 'ok',
        )
        for sid in ('A', 'B'):
            _seed(sid, [('user', f'{sid} turn')])
        monkeypatch.setattr(
            sd,
            '_run_judge_sync',
            lambda prompt, system='': {'verdicts': [{'episode': 1, 'action': 'none'}]},
        )
        sd.run_review_pass()  # the most recently active session
        sd.run_review_pass()
        assert sorted(read) == ['A', 'B'], f'only {read} was ever read'

    def test_a_session_past_its_own_cursor_is_not_read_again(self, brain, monkeypatch):
        _arm(monkeypatch)
        read: list[str] = []
        monkeypatch.setattr(sd, '_reviewWindow', lambda s, c: read.append(s) or ('x', 5))
        monkeypatch.setattr(
            sd,
            '_run_judge_sync',
            lambda prompt, system='': {'verdicts': [{'episode': 1, 'action': 'none'}]},
        )
        _seed('s-once2', [('user', 'turn')])
        sd.run_review_pass()
        sd.run_review_pass()
        assert read == ['s-once2']

    def test_a_json_content_block_is_flattened_not_dropped(self):
        """Desktop rows store the content column as a JSON envelope; the raw
        blob is not evidence and a pass that saw `{}` would report nothing."""
        assert sd._flattenMessageText(json.dumps({'content': 'the sentence'})) == 'the sentence'
        assert sd._flattenMessageText([{'type': 'text', 'text': 'one'}, {'type': 'text', 'text': 'two'}]) == 'one two'
        assert sd._flattenMessageText('plain') == 'plain'
        assert sd._flattenMessageText(None) == ''


class TestWhereVerdictsLand:
    def test_a_verdict_from_a_review_still_faces_the_memory_bar(self, brain, monkeypatch, noProposals):
        """The review pass is a NEW door into apply_verdict. The bar lives at
        that door, so it applies here too — a task-state sentence is dropped."""
        from app.services.memory_store import get_fact

        _arm(monkeypatch)
        _seed('s-bar', [('user', 'deploy it')])
        monkeypatch.setattr(
            sd,
            '_run_judge_sync',
            lambda prompt, system='': {
                'verdicts': [
                    {'episode': 1, 'action': 'memory', 'title': 'now',
                     'summary': 'The user asked me to deploy the change just now and it is done.'},
                ]
            },
        )
        out = sd.run_review_pass()
        assert out['results'][0]['label'] == 'dropped-not-durable'
        assert get_fact('distilled:now') is None

    def test_a_durable_preference_from_the_same_pass_is_kept(self, brain, monkeypatch, noProposals):
        from app.services.memory_store import get_fact

        _arm(monkeypatch)
        _seed('s-keep', [('user', 'always run pytest with -n auto')])
        monkeypatch.setattr(
            sd,
            '_run_judge_sync',
            lambda prompt, system='': {
                'verdicts': [
                    {'episode': 1, 'action': 'memory', 'title': 'test-runner',
                     'summary': 'Always run the backend pytest suite with -n auto, never serially.'},
                ]
            },
        )
        out = sd.run_review_pass()
        assert out['results'][0]['label'] == 'memory-saved'
        fact = get_fact('distilled:test-runner')
        assert fact is not None and '-n auto' in str(fact['factValue'])

    def test_the_fingerprint_is_scoped_to_the_session_reviewed(self, brain, monkeypatch, noProposals):
        """apply_verdict dedupes drafts by fingerprint. A review pass must not
        hand it the bare episode id — a message id collides with the episode
        table's ids, so two different sessions could silence each other's draft."""
        _arm(monkeypatch)
        ids = _seed('s-fp', [('user', 'a two-attempt procedure')])
        fingerprints: list[str] = []
        monkeypatch.setattr(
            sd,
            'apply_verdict',
            lambda verdict, fingerprint, mode='propose', scope='': fingerprints.append(fingerprint) or 'ok',
        )
        monkeypatch.setattr(
            sd,
            '_run_judge_sync',
            lambda prompt, system='': {'verdicts': [{'episode': ids[0], 'action': 'none'}]},
        )
        sd.run_review_pass()
        assert fingerprints == ['review:s-fp']


class TestJudgePlumbing:
    def test_the_review_uses_its_own_system_prompt(self, brain, monkeypatch):
        """The episode prompt tells the model the evidence is flagged failures.
        Reusing it verbatim would say every window contains a bug, so a review
        would hunt for one — and a memory written because the pass felt it had
        to find something is worse than no memory."""
        assert sd._REVIEW_SYSTEM.startswith(sd._JUDGE_SYSTEM)
        assert 'CONVERSATION window' in sd._REVIEW_SYSTEM
        assert 'worse than no memory at all' in sd._REVIEW_SYSTEM

        seen: list[str] = []

        async def fakeJudge(prompt: str, system: str = sd._JUDGE_SYSTEM):
            seen.append(system)
            return {'verdicts': []}

        monkeypatch.setattr(sd, 'call_judge', fakeJudge)
        assert sd._run_judge_sync('p', sd._REVIEW_SYSTEM) == {'verdicts': []}
        assert seen == [sd._REVIEW_SYSTEM]

    def test_the_episode_batch_still_uses_the_default_prompt(self, brain, monkeypatch):
        """The extraction must not have changed what the failure loop sends."""
        seen: list[str] = []

        async def fakeJudge(prompt: str, system: str = sd._JUDGE_SYSTEM):
            seen.append(system)
            return {'verdicts': []}

        monkeypatch.setattr(sd, 'call_judge', fakeJudge)
        sd._run_judge_sync('p')
        assert seen == [sd._JUDGE_SYSTEM]

    def test_a_failed_judge_costs_a_cooldown_not_a_retry_storm(self, brain, monkeypatch):
        _arm(monkeypatch)
        _seed('s-fail', [('user', 'a sentence')])
        monkeypatch.setattr(sd, '_run_judge_sync', lambda prompt, system='': None)
        out = sd.run_review_pass()
        assert out['status'] == 'judge-failed'
        assert sd.run_review_pass().get('skipped') == 'judge cooldown'


class TestSchedulerWiring:
    """A pass nothing runs is a feature that does not exist — the exact hole
    that shipped the reviewer pass with 20 tests and no caller."""

    def test_the_review_job_is_registered(self):
        import app.services.learning_scheduler as ls

        assert 'review' in ls.JOBS, sorted(ls.JOBS)

    def test_its_cadence_is_a_tunable_brain_config_key(self):
        from app.services.brain_config_service import allowedKeys, fieldTable

        assert 'reviewIntervalHours' in allowedKeys
        assert 'memoryReview' in allowedKeys
        row = next(r for r in fieldTable if r[0] == 'reviewIntervalHours')
        assert row[3] == 'num'

    def test_the_job_body_is_the_pass_the_scheduler_actually_calls(self, monkeypatch):
        import app.services.learning_scheduler as ls

        calls: list[str] = []
        import app.services.skill_distiller as distiller

        monkeypatch.setattr(distiller, 'run_review_pass', lambda *a, **k: calls.append('run') or {'status': 'disabled'})
        assert ls.JOBS['review'].fn() == {'status': 'disabled'}
        assert calls == ['run']

    def test_the_ledger_row_drops_the_per_message_list(self, monkeypatch):
        """_finish_run truncates the serialized detail at 2000 chars; a 60-entry
        results list cut the JSON in half and scheduler_status then parsed it to
        {} — a successful review reported as an unexplained one."""
        import app.services.learning_scheduler as ls

        big = [{'episode': i, 'label': 'dropped-not-durable'} for i in range(60)]
        monkeypatch.setattr(
            sd,
            'run_review_pass',
            lambda *a, **k: {'session': 's', 'reviewed': 60, 'upToMessage': 60, 'results': big},
        )
        detail = ls.JOBS['review'].fn()
        assert 'results' not in detail
        assert detail['reviewed'] == 60
        assert detail['kept'] == 0
        assert len(json.dumps(detail)) < 2000

    def test_the_interval_default_is_daily(self):
        import app.services.learning_scheduler as ls

        # 24h and the Job clamp (1..168) means an unset key never spins.
        assert ls.JOBS['review'].interval() >= 1.0
