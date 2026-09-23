"""Sub-agents must inherit durable memory — and be proven wired, not just unit-tested.

A worker can run twenty minutes knowing nothing about the person it works for:
the `<memory>` tail was parent-only, so every identity-level fact had to be
re-typed into the goal string. `subagent_memory_block` is the seam; the last
test here is the one that matters most, because a capability only its own test
calls is not a feature.
"""

from __future__ import annotations

import inspect
import types

import pytest
from app.services import memory_store
from app.services.memory_store.fact_retrieval import invalidate_fact_index
from app.services.workbench import subagent as sub_mod
from app.services.workbench.subagent import subagent_memory_block

# Hand-checked to share no token of length > 1 with the goal below, so a hit
# inside the block can only have come from the always-in profile lane.
_GOAL = 'why did my database connection pool exhaust during tonights deploy'
_PROFILE_BODY = 'The user is a Korean backend engineer based in Seoul.'


@pytest.fixture(autouse=True)
def _fresh_index():
    invalidate_fact_index()
    yield
    invalidate_fact_index()


def _session() -> object:
    """A stand-in owner session.

    Deliberately NOT ``createWorkbenchSession()``: that registers into the
    process-global ``wb._sessions``, and ``get_session()`` falls back to the
    most-recently-touched session outside a tool dispatch — so a leaked real
    session here silently reroutes other tests' todo writes (found as
    ``test_subagent_parity_batch`` failing only inside a full run).
    """
    return types.SimpleNamespace(id='sess_submem', metadata={}, workspacePath='')


def _save_profile(body: str = _PROFILE_BODY) -> None:
    memory_store.save_fact(
        'profile:identity',
        {'fact': body},
        title='Who the user is',
        kind=memory_store.PROFILE_FACT_KIND,
        scope='global',
    )


def test_empty_corpus_produces_no_section() -> None:
    assert subagent_memory_block(_session(), _GOAL, None) == ''


def test_profile_fact_reaches_a_worker_with_zero_word_overlap() -> None:
    _save_profile()
    block = subagent_memory_block(_session(), _GOAL, None)
    assert 'Korean backend engineer' in block
    assert block.startswith('<memory>')


def test_auto_inject_off_still_ships_the_identity_lane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The keyword gate governs keyword recall, not whether the worker knows
    who it is working for — same rule the parent turn follows."""
    _save_profile()
    calls: list[str] = []
    monkeypatch.setattr(
        'app.services.memory_store.fact_retrieval.build_memory_block',
        lambda *a, **k: calls.append('keyword') or ('', []),
    )
    monkeypatch.setattr(
        'app.services.memory_store.fact_retrieval.build_profile_memory_block',
        lambda **k: calls.append('profile') or ('<memory>x</memory>', []),
    )
    assert subagent_memory_block(_session(), _GOAL, None) == '<memory>x</memory>'
    assert calls == ['profile']


def test_auto_inject_on_uses_the_full_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        'app.services.brain_config_service',
        type('BC', (), {'getRuntimeConfig': staticmethod(lambda: {'memoryAutoInject': True})}),
    )
    monkeypatch.setattr(
        'app.services.memory_store.fact_retrieval.build_memory_block',
        lambda *a, **k: calls.append('keyword') or ('<memory>kw</memory>', []),
    )
    monkeypatch.setattr(
        'app.services.memory_store.fact_retrieval.build_profile_memory_block',
        lambda **k: calls.append('profile') or ('', []),
    )
    assert subagent_memory_block(_session(), _GOAL, None) == '<memory>kw</memory>'
    assert calls == ['keyword']


def test_a_memory_failure_cannot_break_a_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(**_kwargs: object) -> tuple[str, list[object]]:
        raise RuntimeError('brain DB locked')

    monkeypatch.setattr(
        'app.services.memory_store.fact_retrieval.build_profile_memory_block', _boom
    )
    assert subagent_memory_block(_session(), _GOAL, None) == ''


def test_execute_subagent_wires_the_block_into_its_system_prompt() -> None:
    """Guard against the dead-feature pattern: the helper exists, is tested,
    and nothing in production calls it."""
    src = inspect.getsource(sub_mod.executeSubAgent)
    assert 'subagent_memory_block(' in src
    assert '_memText' in src and 'systemText' in src


def test_worker_memory_stays_read_only_by_policy() -> None:
    """The parent turn remains the single door that mutates durable memory, so
    widening a worker's context must not quietly widen its write surface."""
    assert {'remember', 'forget'} <= set(sub_mod._SUBAGENT_NEVER_TOOLS)
