"""Part 16 Phase B — tier-1 scoring + fingerprints (no model calls).

Plan acceptance (§3.2/§6):
  * signature stability — same cause+tokens → same fingerprint
  * paraphrase dedupe — ≥0.85 BM25 similarity adopts the existing signature
  * six fixed rubric criteria, deterministic scoring
  * ≤5% flag cap + daily escalation budget (the tier-2 cost gate)
"""

from __future__ import annotations

import pytest
from app.services import episode_miner as em


@pytest.fixture
def brain(isolatedData):
    return isolatedData


class TestFingerprintStability:
    def test_same_cause_and_tokens_same_signature(self, brain):
        e1 = {'events': [{'type': 'tool_error', 'excerpt': 'ngspice binary missing for simulation'}]}
        e2 = {'events': [{'type': 'tool_error', 'excerpt': 'ngspice binary missing again for simulation'}]}
        assert em.fingerprint_for(e1) == em.fingerprint_for(e2)

    def test_canonical_shape(self, brain):
        fp = em.fingerprint_for(
            {'events': [{'type': 'tool_error', 'excerpt': 'ngspice not installed'}]}
        )
        assert fp.startswith('tool-error:')
        assert 'ngspice' in fp
        assert fp == fp.lower() and ' ' not in fp

    def test_stopwords_stripped(self, brain):
        fp = em.fingerprint_for(
            {'events': [{'type': 'tool_error', 'excerpt': 'the error was that it failed'}]}
        )
        assert fp == 'tool-error:general'  # no key tokens survive

    def test_upsert_increments_count(self, brain):
        em.upsert_fingerprint('tool-error:kicad')
        row = em.upsert_fingerprint('tool-error:kicad')
        assert row['episode_count'] == 2
        assert row['first_seen'] and row['last_seen']


class TestParaphraseDedupe:
    def test_near_duplicate_adopts_existing(self, brain):
        fp = em.paraphrase_dedupe(
            'tool-error:quartus-fmax-timing',
            'quartus fmax timing report could not be parsed from the compile log',
            [('tool-error:quartus-fmax', 'quartus fmax timing parse failed from compile log output')],
        )
        assert fp == 'tool-error:quartus-fmax'

    def test_different_cause_class_never_merges(self, brain):
        fp = em.paraphrase_dedupe(
            'user-correction:quartus-fmax-timing',
            'quartus fmax timing report could not be parsed from the compile log',
            [('tool-error:quartus-fmax', 'quartus fmax timing parse failed from compile log output')],
        )
        assert fp == 'user-correction:quartus-fmax-timing'

    def test_dissimilar_text_keeps_new_signature(self, brain):
        fp = em.paraphrase_dedupe(
            'tool-error:ghdl-analyze',
            'ghdl analyze refused the vhdl entity declaration',
            [('tool-error:quartus-fmax', 'quartus fmax timing parse failed from compile log output')],
        )
        assert fp == 'tool-error:ghdl-analyze'


class TestRubricScoring:
    def test_deterministic_and_bounded(self, brain):
        ep = {
            'kind': 'failure_recovery',
            'start_message_id': 3,
            'end_message_id': 5,
            'events': [{'type': 'tool_error', 'excerpt': 'exit code:1 build broke'}],
            'outcome': 'resolved',
        }
        r1 = em.score_episode(ep, fingerprintCount=4, sameCauseSessions=3)
        r2 = em.score_episode(ep, fingerprintCount=4, sameCauseSessions=3)
        assert r1 == r2  # no LLM, no clock in the rubric
        assert 0.0 <= r1['score'] <= 1.0
        assert set(r1['subscores']) == set(em._RUBRIC_WEIGHTS)

    def test_recurrence_and_generalizability_raise_score(self, brain):
        ep = {
            'kind': 'failure_recovery',
            'start_message_id': 3,
            'end_message_id': 4,
            'events': [{'type': 'tool_error', 'excerpt': 'exit code:1 build broke'}],
            'outcome': 'resolved',
        }
        lone = em.score_episode(ep, fingerprintCount=1, sameCauseSessions=1)
        recurring = em.score_episode(ep, fingerprintCount=6, sameCauseSessions=4)
        assert recurring['score'] > lone['score']
        projectTied = em.score_episode(
            {**ep, 'events': [{'type': 'tool_error', 'excerpt': 'C:\\Dev\\sheesh build broke'}]},
            fingerprintCount=6,
            sameCauseSessions=4,
        )
        assert projectTied['subscores']['generalizability'] == 0.0
        assert projectTied['score'] < recurring['score']


class TestFlagCap:
    def _seed(self, n: int) -> None:
        for i in range(n):
            em.save_episode(
                {
                    'session_id': f's{i}',
                    'kind': 'failure_recovery',
                    'start_message_id': i * 10,
                    'end_message_id': i * 10 + 2,
                    'events': [{'type': 'tool_error', 'excerpt': f'build broke unit {i}'}],
                    'outcome': 'resolved',
                    'fingerprint_id': f'tool-error:case-{i}',
                }
            )

    def test_flag_rate_cap_five_percent(self, brain):
        n = 100
        self._seed(n)
        out = em.flag_top_slice(flagRateCap=0.05, budgetPerDay=100)
        assert out['scored'] == n
        # 5% of 100 = 5, but the per-pass budget is the binding gate here.
        assert out['flagged'] == 5

    def test_daily_budget_binds(self, brain):
        self._seed(40)
        out = em.flag_top_slice(flagRateCap=0.05, budgetPerDay=2)
        assert out['flagged'] == 2
        assert len(em.flagged_episodes()) == 2

    def test_zero_score_never_flagged(self, brain):
        em.save_episode(
            {
                'session_id': 'sx',
                'kind': 'failure_recovery',
                'start_message_id': 1,
                'end_message_id': 99,
                'events': [{'type': 'tool_error', 'excerpt': 'C:\\Dev\\only-this-project failed'}],
                'outcome': 'unresolved',
                'fingerprint_id': 'tool-error:only-this-project',
            }
        )
        out = em.flag_top_slice(flagRateCap=0.05, budgetPerDay=10)
        assert out['flagged'] == 0
