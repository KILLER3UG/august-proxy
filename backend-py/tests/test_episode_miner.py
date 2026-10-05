"""Episode extraction (window mining, deterministic).

Plan acceptance (docs/plans/2026-08-29-self-improvement-loops.md §3.1/§6):
  * window extraction from synthetic transcripts — failure→recovery,
    correction→accepted, abandoned-approach shapes
  * typed events with tool/outcome/excerpt
  * no-live-turn coupling — everything reads stored messages, nothing in
    the chat loop changes
"""

from __future__ import annotations

import json

import pytest
from app.services import episode_miner as em


@pytest.fixture
def brain(isolatedData):
    return isolatedData


def _seedSession(sessionId: str, msgs: list[tuple[str, object]]) -> None:
    """Seed the messages table the way the app does.

    A str payload stores plain prose. A dict payload is the transcript message
    itself, and ``blocks_json`` is derived by the SAME encoder the real write
    path uses — which is what turns a tool error into a receipt the miner can
    read, rather than a sentence that merely happens to look like one.
    """
    from app.services.memory_store import init
    from app.services.memory_store.transcript_blocks import encode_blocks

    init()
    from app.services.memory_conn import conn

    c = conn()
    c.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)", (sessionId, 't')
    )
    for role, payload in msgs:
        if isinstance(payload, dict):
            msg = dict(payload)
            msg.setdefault('role', role)
            content = msg.get('content', '')
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            c.execute(
                'INSERT INTO messages (session_id, role, content, blocks_json) VALUES (?, ?, ?, ?)',
                (sessionId, role, text, encode_blocks(msg)),
            )
            continue
        c.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (sessionId, role, json.dumps(payload)),
        )
    c.commit()


def _failedCall(name: str = 'run_command', content: str = 'Error: build failed') -> tuple[str, dict]:
    """One tool result the harness decided had failed."""
    return (
        'tool',
        {'role': 'tool', 'tool_use_id': f'toolu_{name}', 'name': name, 'content': content, 'is_error': True},
    )


class TestWindowExtraction:
    def test_failure_recovery_resolved(self, brain):
        _seedSession(
            's1',
            [
                ('user', 'install ngspice'),
                _failedCall('run_command', 'Error: ngspice: command not found'),
                ('user', 'ok'),
                ('assistant', 'Installed and verified — simulation runs clean now.'),
            ],
        )
        episodes = em.extract_episodes('s1')
        fr = [e for e in episodes if e['kind'] == 'failure_recovery']
        assert len(fr) == 1
        ep = fr[0]
        assert ep['outcome'] == 'resolved'
        assert ep['events'][0]['type'] == 'tool_error'
        assert 'ngspice' in ep['events'][0]['excerpt'].lower()
        assert ep['start_message_id'] < ep['end_message_id']

    def test_failure_rescued_by_user(self, brain):
        _seedSession(
            's2',
            [
                _failedCall('run_command', 'Error: ValueError in deck'),
                ('user', 'My bad — I had set the wrong path. I fixed it already.'),
            ],
        )
        episodes = em.extract_episodes('s2')
        fr = [e for e in episodes if e['kind'] == 'failure_recovery']
        assert len(fr) == 1 and fr[0]['outcome'] == 'rescued'

    def test_failure_unresolved_at_session_end(self, brain):
        _seedSession('s3', [_failedCall()])
        episodes = em.extract_episodes('s3')
        assert episodes[0]['outcome'] == 'unresolved'

    def test_correction_accepted(self, brain):
        _seedSession(
            's4',
            [
                ('assistant', 'The build uses npm.'),
                ('user', "Actually, we use pnpm for this repo."),
                ('assistant', 'Got it — pnpm it is.'),
            ],
        )
        episodes = em.extract_episodes('s4')
        ca = [e for e in episodes if e['kind'] == 'correction_accepted']
        assert len(ca) == 1 and ca[0]['outcome'] == 'resolved'
        assert ca[0]['events'][0]['type'] == 'user_correction'

    def test_correction_unresolved_when_recorrected(self, brain):
        # Per-event windows: the re-correction opens its own window; both
        # must end up unresolved (nothing was accepted).
        _seedSession(
            's5',
            [
                ('user', "Actually use port 8080."),
                ('assistant', 'Port 8080 noted.'),
                ('user', "No, not 8080 — 9090."),
            ],
        )
        episodes = em.extract_episodes('s5')
        ca = [e for e in episodes if e['kind'] == 'correction_accepted']
        assert len(ca) == 2
        assert all(e['outcome'] == 'unresolved' for e in ca)

    def test_abandoned_approach(self, brain):
        _seedSession(
            's6',
            [
                ('assistant', 'Approach A implemented.'),
                ('user', "Let's try a different approach — that one isn't working."),
                ('assistant', 'Switching to approach B…'),
            ],
        )
        episodes = em.extract_episodes('s6')
        ab = [e for e in episodes if e['kind'] == 'abandoned_approach']
        assert len(ab) == 1 and ab[0]['outcome'] == 'resolved'

    def test_clean_transcript_yields_nothing(self, brain):
        _seedSession(
            's7',
            [('user', 'hello'), ('assistant', 'Hi! All done.'), ('user', 'thanks')],
        )
        assert em.extract_episodes('s7') == []

    def test_block_list_content_flattened(self, brain):
        # Stored content can be an Anthropic block list — the receipt inside it
        # still reads as a failure, and its text still flattens into excerpt.
        _seedSession(
            's8',
            [
                (
                    'assistant',
                    {
                        'role': 'assistant',
                        'content': [
                            {
                                'type': 'tool_result',
                                'tool_use_id': 'toolu_1',
                                'name': 'run_command',
                                'content': 'boom exit code:2',
                                'is_error': True,
                            }
                        ],
                    },
                )
            ],
        )
        episodes = em.extract_episodes('s8')
        assert episodes and episodes[0]['events'][0]['type'] == 'tool_error'
        assert 'exit code:2' in episodes[0]['events'][0]['excerpt']


class TestCorrectionDetectorOnRealShape:
    """Backlog item 4: the correction lane has to fire on a transcript the app
    actually wrote — through ``save_workbench_session_sot``, with the tail-patch
    and provenance columns the storage path adds — not only on the hand-rolled
    rows the earlier tests inserted."""

    def _save(self, sid, msgs):
        from app.services.memory_store import init
        from app.services.memory_store.sessions import save_workbench_session_sot

        init()
        save_workbench_session_sot({'id': sid, 'title': 't'}, msgs)

    def test_a_plain_user_correction_is_mined(self, brain):
        self._save(
            'c1',
            [
                {'role': 'user', 'content': 'deploy the api to staging'},
                {'role': 'assistant', 'content': 'Deployed with docker compose.'},
                {'role': 'user', 'content': 'Actually we deploy with helm, not compose.'},
                {'role': 'assistant', 'content': 'Redeployed via the helm chart.'},
            ],
        )
        ca = [e for e in em.extract_episodes('c1') if e['kind'] == 'correction_accepted']
        assert len(ca) == 1, f'a real correction must mine exactly one window: {ca}'
        assert ca[0]['outcome'] == 'resolved'
        assert 'helm' in ca[0]['events'][0]['excerpt'].lower()

    def test_a_tail_patched_user_correction_is_mined_from_its_own_text(self, brain):
        """The per-turn <memory>/<relevant_skills> tail is stripped at the
        recorded boundary; the user's sentence must survive the strip."""
        tail = '\n\n<memory>\nsome injected facts\n</memory>'
        self._save(
            'c2',
            [
                {'role': 'user', 'content': 'set up the proxy'},
                {'role': 'assistant', 'content': 'Pointed it at 8085.'},
                {
                    'role': 'user',
                    'content': 'No, use 9090 instead' + tail,
                    '_tailPatched': True,
                    '_tailFrom': len('No, use 9090 instead'),
                },
                {'role': 'assistant', 'content': 'Switched to 9090.'},
            ],
        )
        ca = [e for e in em.extract_episodes('c2') if e['kind'] == 'correction_accepted']
        assert len(ca) == 1
        assert '<memory>' not in ca[0]['events'][0]['excerpt']

    def test_a_harness_nudge_is_not_mined_as_a_correction(self, brain):
        """The loop's own plumbing speaks as role='user'. Provenance (049) is
        what keeps '[Proxy Self-Heal]' from reading as the human disagreeing."""
        self._save(
            'c3',
            [
                {'role': 'user', 'content': 'keep going'},
                {
                    'role': 'user',
                    'content': '[Proxy Self-Heal] do NOT stop; actually try a different tool.',
                    'source': 'harness_nudge',
                },
                {'role': 'assistant', 'content': 'Used a different tool.'},
            ],
        )
        assert [e for e in em.extract_episodes('c3') if e['kind'] == 'correction_accepted'] == []

    @pytest.mark.parametrize(
        'n, phrase',
        [
            # The wording that must be recognised as the human correcting course.
            (1, 'Actually, we deploy with helm.'),
            (2, 'No, not 9090 — use 8080.'),
            (3, "That's wrong, the port is 8080."),
            (4, 'I meant the staging cluster, not prod.'),
            (5, 'Don’t rebuild, just restart the container.'),
            (6, 'Correction: the binary is called ngspice, not spice.'),
            (7, 'Never mind the compose file, use the chart.'),
        ],
    )
    def test_recognised_phrasings_mine_a_correction(self, brain, n, phrase):
        """Item 4's real question is recall, not "does one example work"."""
        sid = f'recall_{n}'
        self._save(
            sid,
            [
                {'role': 'user', 'content': 'do the thing'},
                {'role': 'assistant', 'content': 'Done, the way I guessed.'},
                {'role': 'user', 'content': phrase},
                {'role': 'assistant', 'content': 'Adjusted.'},
            ],
        )
        ca = [e for e in em.extract_episodes(sid) if e['kind'] == 'correction_accepted']
        assert len(ca) == 1, f'not detected: {phrase!r}'

    def test_the_correction_survives_a_transcript_rewrite(self, brain):
        """Item 2's identity, on the correction lane: a rewrite must not
        duplicate the window the correction produced."""
        transcript = [
            {'role': 'user', 'content': 'deploy the api'},
            {'role': 'assistant', 'content': 'Used compose.'},
            {'role': 'user', 'content': 'Actually use helm.'},
            {'role': 'assistant', 'content': 'Redeployed with helm.'},
        ]
        from app.services.memory_store import init
        from app.services.memory_store.sessions import save_workbench_session_sot

        init()
        save_workbench_session_sot({'id': 'c4', 'title': 't'}, transcript)
        first = em.extract_episodes('c4')
        assert len(first) == 1
        for _ in range(2):
            save_workbench_session_sot({'id': 'c4', 'title': 't'}, transcript)
            for episode in em.extract_episodes('c4'):
                em.record_episode({**episode, 'session_id': 'c4'})
        rows = em._conn().execute("SELECT COUNT(*) n FROM episodes WHERE session_id='c4'").fetchone()['n']
        assert rows == 1, f'the rewrite duplicated the correction window: {rows} rows'


    # Verbatim from workbench/sessions.py — the marker the harness appends when
    # a turn never closed (crash/restart), so replay stays balanced.
    INTERRUPTED_NOTICE = (
        '[interrupted] The previous turn was interrupted before it completed '
        '(session recovered mid-turn). Work may be partially done — verify state '
        'before continuing.'
    )

    def test_the_harness_interrupted_notice_is_not_human_speech(self, brain):
        """Found by running the detector over the real stored corpus (54 human
        user messages) instead of inventing phrasings.

        This row is written by the harness with ``source = NULL``, so the
        provenance filter cannot see it and the legacy prefix list did not
        either — it enters the human-speech lane. Its current wording happens
        not to trip any pattern, so no episode is being invented by it today;
        the defect is that harness instruction text is being *read as the user
        talking*, which is the class that produced the 41 false episodes.
        """
        assert em._isMachineRow('', self.INTERRUPTED_NOTICE) is True
        assert em._extractEvents('user', self.INTERRUPTED_NOTICE, '') == []

    def test_a_humans_correction_still_fires_beside_that_notice(self, brain):
        """The filter must not blind the detector to real speech in the same
        session — the notice is dropped, the correction is not."""
        self._save(
            'c6',
            [
                {'role': 'user', 'content': self.INTERRUPTED_NOTICE},
                {'role': 'user', 'content': 'Actually, the port is 9090.'},
                {'role': 'assistant', 'content': 'Switched to 9090.'},
            ],
        )
        ca = [e for e in em.extract_episodes('c6') if e['kind'] == 'correction_accepted']
        assert len(ca) == 1


class TestQuarantineKeepsTheRowAndDropsTheInfluence:
    """Backlog item 5: the invented episodes are marked, not deleted, and stop
    reaching anything that acts on them."""

    def _seedEpisode(self, sid, excerpt, fp='tool-error:august-harness-loop', outcome='resolved'):
        from app.services.memory_conn import conn

        c = conn()
        c.execute(
            'INSERT INTO episodes (session_id, kind, start_message_id, end_message_id, events, '
            "outcome, fingerprint_id, tier) VALUES (?, 'failure_recovery', 1, 3, ?, ?, ?, 1)",
            (sid, json.dumps([{'type': 'tool_error', 'excerpt': excerpt}]), outcome, fp),
        )
        c.commit()
        return int(c.execute('SELECT last_insert_rowid() AS i').fetchone()['i'])

    def test_an_unbacked_episode_is_marked_and_the_row_survives(self, brain):
        from app.services.memory_conn import conn

        init_ep = self._seedEpisode('q1', 'read_file: [Validation Error] Tool X received')
        before = conn().execute('SELECT COUNT(*) n FROM episodes').fetchone()['n']
        out = em.quarantine_unverified_tool_errors()
        assert out['quarantined'] == 1
        assert out['candidates'] == 1
        after = conn().execute('SELECT COUNT(*) n FROM episodes').fetchone()['n']
        assert after == before, 'quarantine must never delete'
        row = conn().execute('SELECT quarantined FROM episodes WHERE id = ?', (init_ep,)).fetchone()
        assert row['quarantined'] == 1

    def test_a_receipt_backed_episode_is_left_alone(self, brain):
        from app.services.memory_conn import conn

        _seedSession(
            'q2',
            [
                (
                    'tool',
                    {
                        'role': 'tool',
                        'tool_use_id': 't1',
                        'name': 'run_command',
                        'content': 'Error: ngspice: command not found',
                        'is_error': True,
                    },
                )
            ],
        )
        excerpt = em._errorReceipts(
            conn().execute('SELECT blocks_json b FROM messages WHERE session_id=?', ('q2',)).fetchone()['b']
        )[0]
        epId = self._seedEpisode('q2', excerpt)
        assert em.quarantine_unverified_tool_errors()['quarantined'] == 0
        assert (
            conn().execute('SELECT quarantined q FROM episodes WHERE id = ?', (epId,)).fetchone()['q'] == 0
        )

    def test_quarantining_recounts_the_fingerprint_that_escalated_it(self, brain):
        """`episode_count` is the recurrence score that promotes a fingerprint
        to the distiller. Leaving it at the inflated value would keep proposing
        a problem that was never real."""
        from app.services.memory_conn import conn

        c = conn()
        c.execute(
            "INSERT INTO failure_fingerprints (fingerprint, episode_count, status, flagged) "
            "VALUES ('tool-error:august-harness-loop', 32, 'open', 1)"
        )
        for _ in range(3):
            self._seedEpisode('q3', 'read_file: [Validation Error] Tool X')
        c.commit()
        em.quarantine_unverified_tool_errors()
        row = c.execute(
            "SELECT episode_count n, flagged f FROM failure_fingerprints "
            "WHERE fingerprint='tool-error:august-harness-loop'"
        ).fetchone()
        assert row['n'] == 0, f'recurrence still counts invented windows: {row["n"]}'
        # The distiller selects by flagged = 1. Clearing the count but leaving
        # the flag would keep proposing a problem that was never real.
        assert row['f'] == 0

    def test_no_consumer_sees_a_quarantined_episode(self, brain):
        from app.services.memory_conn import conn

        epId = self._seedEpisode('q4', 'read_file: [Validation Error] Tool X')
        em.quarantine_unverified_tool_errors()
        assert [e['id'] for e in em.unscored_episodes()] == []
        em.set_flagged(epId, True)
        assert em.flagged_episodes() == []
        assert em._sameCauseSessions('tool-error:august-harness-loop') == 0
        report = em.learning_report()
        assert report['episodes'] == 0
        assert report['quarantined'] == 1, 'the count must stay visible as history'

    def test_the_sweep_is_idempotent(self, brain):
        self._seedEpisode('q5', 'read_file: [Validation Error] Tool X')
        first = em.quarantine_unverified_tool_errors()
        second = em.quarantine_unverified_tool_errors()
        assert first['quarantined'] == 1
        assert second['candidates'] == 0 and second['quarantined'] == 0
        assert second['quarantinedTotal'] == 1

    def test_a_mixed_window_is_not_quarantined(self, brain):
        """One real failure in the window is enough to keep the whole episode —
        discarding true evidence to tidy a counter is the wrong trade."""
        from app.services.memory_conn import conn

        _seedSession(
            'q6',
            [
                (
                    'tool',
                    {
                        'role': 'tool',
                        'tool_use_id': 't9',
                        'name': 'run_command',
                        'content': 'Error: real failure',
                        'is_error': True,
                    },
                )
            ],
        )
        real = em._errorReceipts(
            conn().execute('SELECT blocks_json b FROM messages WHERE session_id=?', ('q6',)).fetchone()['b']
        )[0]
        c = conn()
        c.execute(
            'INSERT INTO episodes (session_id, kind, start_message_id, end_message_id, events, '
            "outcome, fingerprint_id, tier) VALUES (?, 'failure_recovery', 1, 3, ?, 'resolved', 'fp', 1)",
            (
                'q6',
                json.dumps(
                    [
                        {'type': 'tool_error', 'excerpt': 'read_file: [Validation Error] invented'},
                        {'type': 'tool_error', 'excerpt': real},
                    ]
                ),
            ),
        )
        c.commit()
        assert em.quarantine_unverified_tool_errors()['quarantined'] == 0


class TestNoLiveTurnCoupling:
    def test_mine_sessions_reads_only_storage(self, brain):
        # The scheduled pass works against storage alone — a session with
        # no messages yields no episodes and never touches the chat loop.
        _seedSession('s9', [('user', 'plain text only')])
        out = em.mine_sessions(sinceDays=3650)
        assert out['episodes'] == 0


class TestStorage:
    def test_save_episode_dedupes_on_window(self, brain):
        from app.services.memory_conn import conn

        _seedSession('s10', [_failedCall()])
        ep = em.extract_episodes('s10')[0]
        ep['session_id'] = 's10'
        id1 = em.save_episode(ep)
        id2 = em.save_episode(ep)
        assert id1 == id2
        n = conn().execute("SELECT COUNT(*) AS n FROM episodes WHERE session_id='s10'").fetchone()['n']
        assert n == 1

    def test_fingerprints_join_brain_query(self, brain):
        em.upsert_fingerprint('tool-error:ngspice')
        em.upsert_fingerprint('tool-error:ngspice')
        em.upsert_fingerprint('user-correction:pnpm')
        from app.services.memory_store.brain import brain_query

        rows = json.loads(brain_query('failure-fingerprints', query='ngspice'))
        assert len(rows) == 1
        assert rows[0]['fingerprint'] == 'tool-error:ngspice'
        assert rows[0]['episodeCount'] == 2
        allRows = json.loads(brain_query('failure-fingerprints', query=''))
        assert len(allRows) == 2


class TestProvenanceSweep:
    """Every harness-authored user-role row must be excluded from the
    human-speech lane by provenance, not by hoping its wording is benign.

    Found by grepping every write of ``{'role': 'user'}`` that reaches a
    persisted transcript: passive memory delivery (automation_memory.py) and the
    Live/BTW exchange (routers/live.py) both append harness text as the user and
    neither tagged ``source``, so before 052-era provenance they were read as
    something the human said.
    """

    @pytest.mark.parametrize(
        'source, text',
        [
            ('memory_delivery', "Actually, the build uses pnpm — don't run npm install."),
            ('live_transcript', "Correction: that's wrong, the port is 9090."),
        ],
    )
    def test_the_harness_authored_row_is_not_human_speech(self, brain, source, text):
        assert em._isMachineRow(source, text) is True

    @pytest.mark.parametrize('source', ['memory_delivery', 'live_transcript'])
    def test_such_a_row_mines_no_correction_episode(self, brain, source):
        from app.services.memory_store import init
        from app.services.memory_store.sessions import save_workbench_session_sot

        init()
        save_workbench_session_sot(
            {'id': f'p_{source}', 'title': 't'},
            [
                {'role': 'user', 'content': 'set up the proxy'},
                {
                    'role': 'user',
                    'content': "Actually, that's wrong — don't use 9090, use 8080.",
                    'source': source,
                },
                {'role': 'assistant', 'content': 'Switched to 8080.'},
            ],
        )
        assert em.extract_episodes(f'p_{source}') == []

    def test_a_real_human_correction_in_the_same_session_still_counts(self, brain):
        from app.services.memory_store import init
        from app.services.memory_store.sessions import save_workbench_session_sot

        init()
        save_workbench_session_sot(
            {'id': 'p_mixed', 'title': 't'},
            [
                {
                    'role': 'user',
                    'content': 'Actually, the deploy target is helm, not compose.',
                    'source': 'memory_delivery',
                },
                # A phrasing the detector does match — the point of the test is
                # that the injected row is dropped and this one is not.
                {'role': 'user', 'content': "Don't use compose, use helm."},
                {'role': 'assistant', 'content': 'Using helm.'},
            ],
        )
        eps = [e for e in em.extract_episodes('p_mixed') if e['kind'] == 'correction_accepted']
        assert len(eps) == 1, 'the filter must drop the injected row, not the human one'
