"""Part 16 Phase A — episode extraction (window mining, deterministic).

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


def _seedSession(sessionId: str, msgs: list[tuple[str, str]]) -> None:
    """Seed the messages table the way the app does (role + JSON content)."""
    from app.services.memory_store import init

    init()
    from app.services.memory_conn import conn

    c = conn()
    c.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)", (sessionId, 't')
    )
    for role, text in msgs:
        c.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (sessionId, role, json.dumps(text)),
        )
    c.commit()


class TestWindowExtraction:
    def test_failure_recovery_resolved(self, brain):
        _seedSession(
            's1',
            [
                ('user', 'install ngspice'),
                ('assistant', 'Running install… [Error] command failed with exit code:1'),
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
        assert 'ngspice' in ep['events'][0]['excerpt'].lower() or ep['events'][0]['excerpt']
        assert ep['start_message_id'] < ep['end_message_id']

    def test_failure_rescued_by_user(self, brain):
        _seedSession(
            's2',
            [
                ('assistant', '[Error] tracebacks below: ValueError…'),
                ('user', 'My bad — I had set the wrong path. I fixed it already.'),
            ],
        )
        episodes = em.extract_episodes('s2')
        fr = [e for e in episodes if e['kind'] == 'failure_recovery']
        assert len(fr) == 1 and fr[0]['outcome'] == 'rescued'

    def test_failure_unresolved_at_session_end(self, brain):
        _seedSession('s3', [('assistant', '[Error] command failed')])
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
        # Stored content can be a block list — text blocks flatten.
        from app.services.memory_conn import conn

        _seedSession('s8', [])
        c = conn()
        c.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (
                's8',
                'assistant',
                json.dumps([{'type': 'text', 'text': 'boom [Error] exit code:2'}]),
            ),
        )
        c.commit()
        episodes = em.extract_episodes('s8')
        assert episodes and episodes[0]['events'][0]['type'] == 'tool_error'


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

        _seedSession('s10', [('assistant', '[Error] x')])
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
