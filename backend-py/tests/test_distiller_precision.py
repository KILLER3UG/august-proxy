"""Part 16 Phase C — the judge-precision ship bar as a test (§6).

"Judge precision ≥ 0.8 on ≥ 30 hand-labeled episodes before any
``amend_body`` is enabled" — the ship bar is a test, not a vibe. The
harness runs labeled episodes through ``precision_state``/``record_precision_run``
accumulation and verifies the gate math; production labels accumulate in
``data/skill_learning_precision.json`` as reviewers hand-label real
episodes. Labeled episodes here are synthetic; the scripted classifier is a
stand-in for the real judge so the harness logic is what's under test.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services import skill_distiller as sd


@pytest.fixture
def brain(isolatedData, monkeypatch, tmp_path):
    """Precision store isolated to the test tmp dir (dataPath is imported
    inside skill_distiller at call time, so patching the module works)."""
    monkeypatch.setattr(
        'app.lib.paths.dataPath', lambda *p: tmp_path / 'data' / Path(*p)
    )
    from app.services.memory_store import init

    init()
    return tmp_path


class TestPrecisionGate:
    def test_gate_closed_with_no_labels(self, brain):
        state = sd.precision_state()
        assert state['labeled'] == 0 and state['amendBodyEnabled'] is False

    def test_gate_never_opens_below_30_labels(self, brain):
        sd.record_precision_run(labeled=29, correct=29)
        state = sd.precision_state()
        assert state['labeled'] == 29 and state['precision'] == 1.0
        assert state['amendBodyEnabled'] is False  # 29 < 30 — bar not met

    def test_gate_opens_at_bar(self, brain):
        sd.record_precision_run(labeled=15, correct=13)
        sd.record_precision_run(labeled=15, correct=13)  # 30 labels, 0.867
        state = sd.precision_state()
        assert state['labeled'] == 30
        assert state['precision'] >= 0.8
        assert state['amendBodyEnabled'] is True

    def test_gate_stays_shut_below_precision(self, brain):
        sd.record_precision_run(labeled=30, correct=22)  # 0.733 < 0.8
        assert sd.precision_state()['amendBodyEnabled'] is False


class TestPrecisionHarness:
    """The harness itself: labeled synthetic episodes + scripted judge."""

    @staticmethod
    def labeledEpisodes(n: int) -> list[dict]:
        """Synthetic labeled episodes: recurring tool failures with clean
        recoveries are label=1 (worth learning); one-off project-tied
        hiccups are label=0."""
        out = []
        for i in range(n):
            recurring = i % 2 == 0
            out.append(
                {
                    'id': i,
                    'kind': 'failure_recovery',
                    'outcome': 'resolved' if recurring else 'unresolved',
                    'fingerprint': f'tool-error:case-{i % 5}' if recurring else f'tool-error:oneoff-{i}',
                    'label': 1 if recurring else 0,
                }
            )
        return out

    @staticmethod
    def scriptedJudge(ep: dict) -> dict:
        """A stand-in judge: flags recurring resolved windows — the shape a
        well-tuned real judge should approximate."""
        worthIt = ep['outcome'] == 'resolved' and 'oneoff' not in ep['fingerprint']
        return {'episode': ep['id'], 'action': 'memory' if worthIt else 'none'}

    def test_harness_accumulates_and_gates(self, brain):
        episodes = self.labeledEpisodes(30)
        correct = sum(
            1
            for ep in episodes
            if (self.scriptedJudge(ep)['action'] == 'memory') == bool(ep['label'])
        )
        state = sd.record_precision_run(labeled=len(episodes), correct=correct)
        # The scripted judge classifies every synthetic episode correctly.
        assert correct == 30
        assert state['precision'] == 1.0
        assert state['amendBodyEnabled'] is True

    def test_harness_detects_a_bad_judge(self, brain):
        episodes = self.labeledEpisodes(30)

        def badJudge(ep):
            return {'episode': ep['id'], 'action': 'memory'}  # flags everything

        correct = sum(
            1 for ep in episodes if (badJudge(ep)['action'] == 'memory') == bool(ep['label'])
        )
        state = sd.record_precision_run(labeled=len(episodes), correct=correct)
        assert correct == 15
        assert state['precision'] == 0.5
        assert state['amendBodyEnabled'] is False
