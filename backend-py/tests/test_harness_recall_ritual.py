"""Regression tests: P1 Claude-style recall ritual + P2 memory nudge.

Turn 1 must recall under ANY pressure (limit shrinks, never zero); later
turns stay cadence/probe-gated; probe recalls are cached per session; the
mid-turn <memory_nudge> fires once per turn under the right conditions.
"""

from __future__ import annotations

import pytest
from app.services.workbench.workbench import (
    _MEMORY_NUDGE_MIN_ROUND,
    _build_memory_nudge,
    _probe_recall_limit,
    _shouldAutoRecall,
)

# ── P1.1: turn-1 guaranteed recall ──────────────────────────────────────────

def test_turn_one_recalls_under_low_pressure():
    budget = {'attention_pressure': 'low', 'remaining_tokens': 50_000}
    assert _shouldAutoRecall(budget) is True


def test_turn_one_recalls_even_at_high_pressure():
    """The old gate dropped recall to zero under pressure — the ritual must hold."""
    budget = {'attention_pressure': 'high', 'remaining_tokens': 20_000}
    assert _shouldAutoRecall(budget) is True


def test_turn_one_recalls_at_critical_pressure_with_min_headroom():
    budget = {'attention_pressure': 'critical', 'remaining_tokens': 5_000}
    assert _shouldAutoRecall(budget) is True


def test_turn_one_no_recall_when_window_exhausted():
    budget = {'attention_pressure': 'critical', 'remaining_tokens': 500}
    assert _shouldAutoRecall(budget) is False


def test_turn_one_no_budget_no_recall():
    assert _shouldAutoRecall(None) is False


class _Session:
    def __init__(self, messages: list[dict[str, object]]):
        self.messages = messages


def _turn_n(n: int, text: str = 'continue the work') -> _Session:
    msgs: list[dict[str, object]] = []
    for i in range(n):
        msgs.append({'role': 'user', 'content': text if i == n - 1 else f'turn {i}'})
        msgs.append({'role': 'assistant', 'content': 'ok'})
    return _Session(msgs)


def test_later_turns_still_cadence_gated():
    """Turn 3 (3 % 3 == 0) recalls; turn 4 without probe verbs does not."""
    ok_budget = {'attention_pressure': 'low', 'remaining_tokens': 50_000}
    assert _shouldAutoRecall(ok_budget, session=_turn_n(3)) is True
    assert _shouldAutoRecall(ok_budget, session=_turn_n(4)) is False


def test_later_turn_probe_recalls_under_pressure():
    """A probe message recalls even under high pressure on later turns.

    Probe detection happens at the call site (it owns the message text);
    the gate honors it through ``probe=True``."""
    budget = {'attention_pressure': 'high', 'remaining_tokens': 30_000}
    probe_session = _turn_n(4, text='what did I say about the deploy process?')
    assert _shouldAutoRecall(budget, session=probe_session, probe=True) is True
    # Without the flag, later turns keep the low/medium-pressure rule.
    assert _shouldAutoRecall(budget, session=probe_session) is False


def test_later_turn_high_pressure_no_headroom_still_gated():
    budget = {'attention_pressure': 'high', 'remaining_tokens': 2_000}
    assert _shouldAutoRecall(budget, session=_turn_n(3)) is False


# ── P1.1b: pressure-shrinking limit ─────────────────────────────────────────

def test_limit_shrinks_under_high_pressure():
    assert _probe_recall_limit({'attention_pressure': 'high', 'remaining_tokens': 10_000}, 5) == 2


def test_limit_floors_at_one_under_critical():
    assert _probe_recall_limit({'attention_pressure': 'critical', 'remaining_tokens': 3_000}, 5) == 1
    assert _probe_recall_limit({'attention_pressure': 'low', 'remaining_tokens': 1000}, 5) == 1


def test_limit_full_when_calm():
    assert _probe_recall_limit({'attention_pressure': 'low', 'remaining_tokens': 50_000}, 5) == 5


# ── P2: mid-task memory nudge ───────────────────────────────────────────────

def _msgs_with_correction() -> list[dict[str, object]]:
    return [
        {'role': 'user', 'content': 'run the tests please'},
        {'role': 'assistant', 'content': 'running'},
        {'role': 'tool', 'content': 'ok'},
        {'role': 'user', 'content': 'actually from now on always use uv run pytest -q'},
    ]


def test_nudge_fires_on_correction_pattern():
    out = _build_memory_nudge(_msgs_with_correction(), set(), None)
    assert '<memory_nudge>' in out
    assert 'remember(' in out


def test_nudge_suppressed_when_remember_already_called():
    out = _build_memory_nudge(_msgs_with_correction(), {'remember'}, None)
    assert out == ''


def test_nudge_suppressed_under_high_pressure():
    out = _build_memory_nudge(
        _msgs_with_correction(), set(), {'attention_pressure': 'high'}
    )
    assert out == ''


def test_nudge_suppressed_without_correction():
    msgs: list[dict[str, object]] = [
        {'role': 'user', 'content': 'what is the capital of France'},
        {'role': 'assistant', 'content': 'Paris'},
    ]
    assert _build_memory_nudge(msgs, set(), None) == ''


def test_nudge_min_round_constant_sane():
    """Background review gates at turn_interval=3 — the nudge must fire deeper."""
    assert _MEMORY_NUDGE_MIN_ROUND > 3
