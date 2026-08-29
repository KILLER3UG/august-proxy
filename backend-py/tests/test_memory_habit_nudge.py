"""Memory-habit nudge: one-shot end-of-turn trigger + tail consumption (2026-08-29).

Guards the "any August model can build durable memory" habit: after a
substantial turn (>= _MEMORY_NUDGE_MIN_ROUNDS tool rounds) with no `remember`
call, the NEXT turn's tail carries a one-shot <memory_nudge> hint. The nudge
never touches the system prompt — it rides the per-turn tail block (appended
to the latest user message, outside the cached prefix), same discipline as
the <memory> / <relevant_skills> blocks.
"""

from __future__ import annotations

from app.services.tool_registrations import session_tools
from app.services.workbench import prompt_segments_cache as seg
from app.services.workbench import workbench as wb
from app.services.workbench.sessions import WorkbenchSession


def _session(sid: str = 'nudge-sess') -> WorkbenchSession:
    return WorkbenchSession(id=sid)


def teardown_function() -> None:
    session_tools.reset_remember_turn_budget()


def test_nudge_queues_on_substantial_turn() -> None:
    s = _session()
    wb.queue_memory_habit_nudge(s, rounds=3, rememberOffered=True, memWritesOn=True)
    assert s._memory_nudge_pending is True


def test_no_nudge_below_round_threshold() -> None:
    s = _session()
    wb.queue_memory_habit_nudge(s, rounds=wb._MEMORY_NUDGE_MIN_ROUNDS - 1, rememberOffered=True, memWritesOn=True)
    assert s._memory_nudge_pending is False


def test_no_nudge_when_writes_off_or_tool_missing() -> None:
    s = _session()
    wb.queue_memory_habit_nudge(s, rounds=5, rememberOffered=False, memWritesOn=True)
    assert s._memory_nudge_pending is False
    wb.queue_memory_habit_nudge(s, rounds=5, rememberOffered=True, memWritesOn=False)
    assert s._memory_nudge_pending is False


def test_no_nudge_when_remember_already_used() -> None:
    s = _session()
    session_tools._rememberTurnCounts[s.id] = 1
    wb.queue_memory_habit_nudge(s, rounds=4, rememberOffered=True, memWritesOn=True)
    assert s._memory_nudge_pending is False


def test_nudge_block_is_one_shot() -> None:
    s = _session()
    wb.queue_memory_habit_nudge(s, rounds=3, rememberOffered=True, memWritesOn=True)
    block = wb.memory_nudge_block(s, memWritesOn=True)
    assert '<memory_nudge>' in block
    assert '`remember`' in block
    assert 'Skip if nothing' in block
    assert wb.memory_nudge_block(s, memWritesOn=True) == ''
    assert s._memory_nudge_pending is False


def test_nudge_block_respects_writes_gate() -> None:
    s = _session()
    wb.queue_memory_habit_nudge(s, rounds=3, rememberOffered=True, memWritesOn=True)
    assert wb.memory_nudge_block(s, memWritesOn=False) == ''
    assert s._memory_nudge_pending is True  # held, not consumed, while gated off


def test_policy_block_teaches_the_habit() -> None:
    text = seg.MEMORY_BLOCK
    assert '<memory_policy>' in text
    assert 'root cause' in text
    assert '[[key]]' in text
    assert 'Correct yourself too' in text
    assert "Update, don't duplicate" in text  # pre-existing anchor preserved
    assert 'Sensitive topics' in text  # pre-existing anchor preserved


def test_nudge_block_never_in_system_prompt_constants() -> None:
    # Structural guard: the nudge text lives in its own constant so the
    # system-prompt builder cannot pick it up accidentally.
    assert seg.MEMORY_NUDGE_BLOCK.startswith('<memory_nudge>')
    assert '<memory_nudge>' not in seg.MEMORY_BLOCK
