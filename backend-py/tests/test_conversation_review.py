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


class TestArchivedTranscriptIsReviewable:
    """Compaction DELETES the middle it folded away from `messages` — a row the
    saved snapshot no longer contains is removed — so a session can be fully
    reviewed against the live table while unread content survives only in the
    append-only archive. These pin the second cursor that reaches it.
    """

    def _archive(self, sessionId: str, rows: list[tuple[str, str]]) -> None:
        from app.services.transcript_archive import archive_messages

        archive_messages(
            sessionId, [{'role': r, 'content': c} for r, c in rows], reason='auto-compact'
        )

    def test_live_content_is_preferred_over_the_archive(self, brain):
        ids = _seed('s-pref', [('user', 'still unread'), ('assistant', 'reply')])
        self._archive('s-pref', [('user', 'archived ask'), ('assistant', 'archived answer')])
        sessionId, cursor, fromArchive = sd._reviewTarget()
        assert sessionId == 's-pref'
        assert fromArchive is False, 'live rows are unread, so the archive must wait'
        assert cursor == 0
        assert ids

    def test_a_fully_reviewed_session_falls_through_to_the_archive(self, brain):
        ids = _seed('s-arch', [('user', 'unread yet'), ('assistant', 'reply')])
        self._archive('s-arch', [('user', 'the erased middle'), ('assistant', 'what it taught')])
        sd._setReviewCursor('s-arch', ids[-1])
        sessionId, cursor, fromArchive = sd._reviewTarget()
        assert (sessionId, fromArchive) == ('s-arch', True)
        assert cursor == 0

    def test_the_archive_window_carries_negative_positions(self, brain):
        self._archive('s-win', [('user', 'erased ask about the ledger'), ('assistant', 'erased fix')])
        window, consumed = sd._archiveWindow('s-win', 0)
        assert '[-1] user: erased ask about the ledger' in window, window
        assert '[-2] assistant: erased fix' in window, window
        assert consumed == 2

    def test_overlapping_snapshots_are_not_judged_twice(self, brain):
        """Each snapshot holds the WHOLE projection at that moment, so consecutive
        ones repeat messages. Without the dedupe the same lesson is offered once per
        snapshot it survived in."""
        shared = ('user', 'always run the suite with -n auto')
        self._archive('s-dup', [shared, ('assistant', 'noted')])
        self._archive('s-dup', [shared, ('assistant', 'later turn')])
        window, consumed = sd._archiveWindow('s-dup', 0)
        assert window.count('always run the suite') == 1, window
        assert consumed == 4, 'the cursor still advances over the repeated row'

    def test_a_blank_archive_window_advances_its_own_cursor(self, brain, monkeypatch):
        """Re-reading an empty window forever is the failure this whole map exists
        to prevent, and it must advance the ARCHIVE cursor, not the live one."""
        ids = _seed('s-blank', [('user', 'live row, reviewed')])
        sd._setReviewCursor('s-blank', ids[-1])
        self._archive('s-blank', [('tool', '')])
        _arm(monkeypatch)
        calls: list[str] = []
        monkeypatch.setattr(sd, '_run_judge_sync', lambda *a, **k: calls.append('judge') or [])

        out = sd.run_review_pass()

        assert out['status'] == 'idle', out
        assert not calls, 'an empty window must not spend a judge call'
        assert sd._reviewCursors(sd._ARCHIVE_CURSOR_KEY).get('s-blank') == 1, (
            'the archive cursor did not advance, so this window is re-read every pass'
        )
        assert sd._reviewCursors().get('s-blank') == ids[-1], 'the live cursor was overwritten'


class TestArchiveDraftCarriesEvidence:
    """A proposal raised from archived content must show the span it came from."""

    def test_a_negative_episode_resolves_to_the_archived_message(self, brain, monkeypatch, tmp_path):
        from app.services import skill_service
        from app.services.harness_self_improve import list_proposals

        monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: tmp_path / 'agent-skills')
        from app.services.transcript_archive import archive_messages

        archive_messages(
            's-ev',
            [{'role': 'user', 'content': 'the erased ledger migration conversation'}],
            reason='auto-compact',
        )
        label = sd.apply_verdict(
            {
                'action': 'create_skill',
                'episode': -1,
                'name': 'ledger-migration',
                'description': 'Migrate the billing ledger when the ask arrives already scoped.',
                'when_to_use': ['- The user hands over a ledger migration with the schema attached.'],
                'steps': ['Read the existing projection before rewriting.', 'Replay the deltas in order.'],
                'pitfalls': ['Summarizing the middle without archiving it first.'],
                'verification': ['The replayed ledger matches the source totals.'],
            },
            'review:s-ev',
            mode='full',
        )
        assert label == 'proposal-filed', label
        filed = list_proposals()
        assert filed, 'no proposal was filed, so the evidence has nowhere to be'
        evidence = str(filed[0].get('evidence', ''))
        assert 'the erased ledger migration conversation' in evidence, (
            f'a draft from the archive shipped with no evidence of it: {evidence[:200]!r}'
        )

    def test_a_live_episode_id_does_not_take_the_archive_path(self, brain):
        """A positive id is a `messages`/`episodes` row; the archive branch must not
        claim it just because the fingerprint looks like a review pass."""
        from app.services.transcript_archive import archive_messages

        archive_messages('s-live', [{'role': 'user', 'content': 'ARCHIVED TEXT'}], reason='auto-compact')
        out = sd._evidenceWindow({'events': []}, 1, 'review:s-live')
        assert 'ARCHIVED TEXT' not in out, out
        assert '[archived' not in out, out


class TestArchivedPositionsSurviveADroppedSnapshot:
    """Positions are stamped at write time rather than re-derived by counting what
    happens to parse on read, so the numbering a cursor was stored against is the
    numbering the next pass sees. What a torn append genuinely costs (the welded
    records) is unrecoverable by any scheme; the reachable hazard is a cursor that
    outruns the file, and that one must be loud."""

    def _torn(self, sid: str) -> None:
        """Three snapshots with a corrupt-but-terminated middle record.

        A torn line with no trailing newline is worse still — it welds the next
        record onto the broken bytes and BOTH vanish — but no position scheme can
        recover those bytes. This is the case `startSeq` does protect: the middle
        record is dropped and the later one must keep the position it was written
        with, instead of sliding forward and invalidating every stored cursor.
        """
        from app.lib.paths import dataPath
        from app.services.transcript_archive import archive_messages

        archive_messages(sid, [{'role': 'user', 'content': 'first middle'}], reason='auto-compact')
        path = dataPath('transcripts', f"{sid[:120]}.jsonl")
        with path.open('a', encoding='utf-8') as fh:
            fh.write('{"reason": "auto-compact", broken\n')
        archive_messages(sid, [{'role': 'assistant', 'content': 'later middle'}], reason='auto-compact')

    def test_positions_are_recorded_and_agree_across_reads(self, brain):
        from app.services.transcript_archive import archivedMessages, load_archive

        self._torn('s-torn')
        # Every surviving snapshot carries the position it was written with...
        starts = [r.get('startSeq') for r in load_archive('s-torn')]
        assert starts and all(isinstance(s, int) for s in starts), starts
        # ...and two reads of the same file must never disagree, or a stored cursor
        # means something different on the next pass.
        first = archivedMessages('s-torn')
        assert archivedMessages('s-torn') == first
        # Ids descend as positions ascend, so transcript order is ascending ids.
        assert [ep for ep, _ in first] == sorted((ep for ep, _ in first), reverse=True), first

    def test_a_cursor_past_the_end_is_logged_not_swallowed(self, brain, caplog):
        """The hazard that IS reachable: a stored cursor ahead of everything the
        file can yield makes `count > cursor` false forever. Silent would be
        indistinguishable from a session with nothing archived.

        The session needs a live row to be a candidate at all: the scan walks
        sessions by their newest `messages` id, so a session with no rows anywhere
        is not considered — that is an undone or cleared chat, not a compacted one.
        """
        import logging

        from app.services.transcript_archive import archive_messages, archivedCount

        ids = _seed('s-past', [('user', 'a row that survived the compaction')])
        archive_messages('s-past', [{'role': 'user', 'content': 'one'}], reason='auto-compact')
        sd._setReviewCursor('s-past', ids[-1], sd._REVIEW_CURSOR_KEY)
        bound = archivedCount('s-past')
        sd._setReviewCursor('s-past', bound + 5, sd._ARCHIVE_CURSOR_KEY)
        with caplog.at_level(logging.WARNING, logger='app.services.skill_distiller'):
            sessionId, cursor, fromArchive = sd._reviewTarget()
        assert 'cursor past end' in caplog.text, (
            f'a past-the-end archive cursor produced no log line (session={sessionId})'
        )
        # Nothing unread in either channel, so the pass reports no target — but it
        # now says why, instead of the session vanishing from the ledger quietly.
        assert (sessionId, cursor, fromArchive) == ('', 0, False)

    def test_the_cursor_never_claims_more_than_exists(self, brain):
        from app.services.transcript_archive import archivedCount

        self._torn('s-torn2')
        bound = archivedCount('s-torn2')
        sd._setReviewCursor('s-torn2', bound + 5, sd._ARCHIVE_CURSOR_KEY)
        window, consumed = sd._archiveWindow('s-torn2', bound + 5)
        assert window == ''
        assert consumed == bound + 5, 'a cursor past the end must not walk backwards'

    def test_the_cursor_never_claims_more_than_exists(self, brain):
        from app.services.transcript_archive import archivedCount

        self._torn('s-torn2')
        bound = archivedCount('s-torn2')
        sd._setReviewCursor('s-torn2', bound + 5, sd._ARCHIVE_CURSOR_KEY)
        window, consumed = sd._archiveWindow('s-torn2', bound + 5)
        assert window == ''
        assert consumed == bound + 5, 'a cursor past the end must not walk backwards'


class TestReviewerFindings2026Oct16:
    """Closed against the runtime review round. Each of these was measured as a
    live failure on the commits that shipped the archive channel."""

    def test_invalid_utf8_at_the_tail_corrupts_one_line_not_the_review(self, brain):
        """`read_text` raises UnicodeDecodeError, which is neither OSError nor
        JSONDecodeError, so it escaped both readers and out of `run_review_pass` —
        whose docstring promises it never raises — and one damaged transcript
        blocked EVERY session's review at each cadence."""
        from app.services.transcript_archive import _path, archive_messages, archivedCount, load_archive

        archive_messages('s-bad', [{'role': 'user', 'content': 'readable middle'}], reason='auto-compact')
        with _path('s-bad').open('ab') as f:
            f.write(b'{"messages":[{"role":"user","content":"\xff\xfe broken"}\n')

        snaps = load_archive('s-bad')
        assert len(snaps) == 1, f'the readable record must survive the torn one: {snaps}'
        assert archivedCount('s-bad') == 1
        ids = _seed('s-bad', [('user', 'a live row')])
        sd._setReviewCursor('s-bad', ids[-1], sd._REVIEW_CURSOR_KEY)
        sessionId, cursor, fromArchive = sd._reviewTarget()
        assert (sessionId, fromArchive) == ('s-bad', True)

    def test_a_quoted_negative_id_still_reaches_the_archive(self, brain):
        """The verdict schema types the episode id as int OR string, so "-1" is a
        legal answer. The archive branch keyed on the TYPE, so a model that quoted
        the id shipped a draft with no evidence at all — silently."""
        from app.services.transcript_archive import archive_messages

        archive_messages('s-quoted', [{'role': 'user', 'content': 'ARCH QUOTED ASK'}], reason='auto-compact')
        ev = sd._evidenceWindow({'episode': '-1'}, '-1', fingerprint='review:s-quoted')
        assert 'ARCH QUOTED ASK' in str(ev), ev

    def test_the_archive_probe_rotates_rather_than_starving(self, brain):
        """With more exhausted sessions than the per-pass cap, a stable scan order
        probed the same first N every pass and never looked at the tail — measured
        at 12 sessions against a cap of 8, where four were skipped forever."""
        from app.services.transcript_archive import archive_messages

        cap = sd._REVIEW_ARCHIVE_SCAN
        n = cap + 4
        for i in range(n):
            sid = f's{i:02d}'
            ids = _seed(sid, [('user', f'row of {sid}')])
            archive_messages(sid, [{'role': 'user', 'content': f'UNREAD MIDDLE {sid}'}], reason='auto-compact')
            sd._setReviewCursor(sid, ids[-1], sd._REVIEW_CURSOR_KEY)
            # `_seed` inserts in order, so the scan's `newest DESC` walks s11 first
            # and s00 last. Marking the NEWEST n-cap sessions as already read puts
            # every unread one past the per-pass cap — which is exactly the state
            # the old stable order could never leave.
            if i >= n - cap:
                sd._setReviewCursor(sid, 1, sd._ARCHIVE_CURSOR_KEY)

        sessionId, cursor, fromArchive = sd._reviewTarget()
        assert fromArchive is True, sessionId
        assert cursor == 0, 'the least-read archive must be next, not an already-read one'
        assert int(sessionId[1:]) < n - cap, f'{sessionId} is inside the starved tail'
