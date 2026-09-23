"""The spawn-depth cap has to actually be reachable.

`delegation.maxDepth` (Settings -> Subagents, 1..5) was dead configuration
above its default of 1: the sub-agent tool surface subtracted `spawn_subagents`
unconditionally, so a child was never offered the tool and the orchestrator's
depth check could not fire. Both sides now read one resolver, and these tests
pin the shared answer.
"""

from __future__ import annotations

import pytest
from app.services.workbench import subagent as sa
from app.services.workbench.context import (
    MAX_SPAWN_DEPTH_LIMIT,
    may_spawn_children,
    resolve_max_spawn_depth,
)


class _Session:
    def __init__(self, metadata: dict[str, object] | None = None) -> None:
        self.metadata: dict[str, object] = metadata or {}


# ── the resolver ──────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    'configured, expected',
    [
        (None, 1),      # default: today's behavior, one level
        (1, 1),
        (3, 3),
        (5, 5),
        (0, 1),         # clamped up
        (-4, 1),
        (99, MAX_SPAWN_DEPTH_LIMIT),   # clamped down
        ('nonsense', 1),
    ],
)
def test_max_depth_resolution_and_clamping(configured: object, expected: int) -> None:
    delegation = {} if configured is None else {'maxDepth': configured}
    assert resolve_max_spawn_depth(delegation) == expected


def test_session_metadata_is_the_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        'app.services.brain_config_service.getDelegationLimits',
        lambda: {'maxDepth': 1},
    )
    session = _Session({'delegation': {'maxDepth': 3}})
    assert resolve_max_spawn_depth(session=session) == 3


def test_brain_config_fills_the_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        'app.services.brain_config_service.getDelegationLimits',
        lambda: {'maxDepth': 4},
    )
    assert resolve_max_spawn_depth(session=_Session({})) == 4
    # An explicit session value still wins over the global.
    assert resolve_max_spawn_depth(session=_Session({'delegation': {'maxDepth': 2}})) == 2


def test_unreadable_brain_config_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom() -> dict[str, int]:
        raise RuntimeError('brain config down')

    monkeypatch.setattr('app.services.brain_config_service.getDelegationLimits', _boom)
    assert resolve_max_spawn_depth(session=_Session({})) == 1


# ── the surface the child is built from ───────────────────────────────────

def test_default_cap_keeps_children_leaf_only() -> None:
    blocked = sa._blocked_tools(session=_Session({}), depth=1)
    assert 'spawn_subagents' in blocked
    assert 'spawn_subagent' in blocked


def test_raised_cap_offers_spawn_to_a_child_that_may_nest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        'app.services.brain_config_service.getDelegationLimits',
        lambda: {'maxDepth': 3},
    )
    session = _Session({})
    assert 'spawn_subagents' not in sa._blocked_tools(session=session, depth=1)
    assert 'spawn_subagents' not in sa._blocked_tools(session=session, depth=2)
    # ...and stops exactly where the orchestrator's own check would refuse.
    assert 'spawn_subagents' in sa._blocked_tools(session=session, depth=3)


@pytest.mark.parametrize('depth', [0, 1, 2, 5, 9])
def test_never_blocked_tools_are_blocked_at_every_depth(depth: int) -> None:
    blocked = sa._blocked_tools(session=_Session({'delegation': {'maxDepth': 5}}), depth=depth)
    for tool in sa._SUBAGENT_NEVER_TOOLS:
        assert tool in blocked, f'{tool} leaked at depth {depth}'


def test_surface_and_orchestrator_cannot_disagree(monkeypatch: pytest.MonkeyPatch) -> None:
    """One resolver, two consumers — the bug was them disagreeing."""
    monkeypatch.setattr(
        'app.services.brain_config_service.getDelegationLimits',
        lambda: {'maxDepth': 2},
    )
    session = _Session({})
    cap = resolve_max_spawn_depth(session=session)
    for depth in range(0, MAX_SPAWN_DEPTH_LIMIT + 2):
        may_spawn = may_spawn_children(session=session, depth=depth)
        spawn_blocked = 'spawn_subagents' in sa._blocked_tools(session=session, depth=depth)
        assert may_spawn is (depth + 1 <= cap)
        assert spawn_blocked is not may_spawn
