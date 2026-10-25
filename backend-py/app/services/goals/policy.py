"""Goal policy — formed per arrival, never stored.

Two different questions, and conflating them is how an editable harness locks itself out:

  * the **work surface** — the tools that do the work (files, terminal, memory, market). This is the
    chain's ``allow`` lists intersected with what the seat actually offers, minus every ``deny`` up the
    chain. Slice 5 trims ``toolDefinitions`` with exactly this set.
  * the **meta surface** — the four ``goal_*`` tools that edit the environment itself. These are
    governed by the DENY list only. Gating them by the allow list would mean a goal that narrowed itself
    without naming ``goal_edit`` could never widen again, because widening is what the narrowing rule
    forbids — a permanent lockout with no error to show for it.

Pure: environments in, a bound out. No database, so the rule is the same in a tool call, a prompt
block and a future UI.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.services.goals import records as R


@dataclass(frozen=True)
class Effective:
    """What one session may do, in the goal it is working in."""
    env_id: str
    allow: frozenset[str]
    denials: tuple[tuple[str, str], ...]  # (tool name, which goal denied it)
    max_rounds: int
    context_chars: int
    path: tuple[str, ...]  # titles, root first

    def denies(self, name: str) -> str | None:
        for denied, by in self.denials:
            if denied == name:
                return by
        return None


def chain(envs: Iterable[R.Env], env_id: str) -> list[R.Env]:
    """The goal and its ancestors, root first. A parent cycle terminates instead of hanging a turn."""
    by_id = {e.id: e for e in envs}
    up: list[R.Env] = []
    seen: set[str] = set()
    cursor = by_id.get(env_id)
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        up.append(cursor)
        cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
    return list(reversed(up))


def effective(envs: Iterable[R.Env], env_id: str, seat_tools: Iterable[str]) -> Effective:
    """Intersect the chain's allow lists with the seat, union the denials, take the tightest ceilings.

    A chain that does not reach the root is not a chain this app seeded, so it falls CLOSED to no
    work surface — never open to everything the seat offers.
    """
    envs = list(envs)
    link = chain(envs, env_id)
    if not link or not R.is_root(link[0].id):
        return Effective(env_id=env_id, allow=frozenset(), denials=(), max_rounds=0,
                         context_chars=0, path=tuple(e.title for e in link))
    seat = {str(t).strip() for t in seat_tools if str(t).strip()}
    allow: set[str] | None = None
    denials: list[tuple[str, str]] = []
    denied: set[str] = set()
    max_rounds = R.root_bound(()).max_rounds
    context_chars = R.root_bound(()).context_chars
    for env in link:
        names = set(env.bound.allow)
        allow = names if allow is None else (allow & names)
        for name in env.bound.deny:
            if name not in denied:
                denied.add(name)
                denials.append((name, env.title or env.id))
        max_rounds = min(max_rounds, env.bound.max_rounds)
        context_chars = min(context_chars, env.bound.context_chars)
    final = {n for n in (allow or set()) if n in seat and n not in denied}
    for name in sorted((allow or set()) - seat - denied):
        denials.append((name, 'the seat does not offer it'))
    return Effective(env_id=env_id, allow=frozenset(final), denials=tuple(denials),
                     max_rounds=max_rounds, context_chars=context_chars,
                     path=tuple(e.title for e in link))


def deny_refusal(policy: Effective, tool_name: str) -> str | None:
    """The deny-list half, on its own.

    Creating a goal UNDER the app-owned root is the normal case, so the "root is read-only" rule
    must not be applied to the parent — it applies to editing the root itself.
    """
    by = policy.denies(tool_name)
    if by:
        return f'{tool_name} is denied by "{by}" — goal_read still works'
    return None


def meta_refusal(policy: Effective, tool_name: str, env: R.Env) -> str | None:
    """Whether a ``goal_*`` tool may run here. Deny-list only, plus the app-owned root."""
    if not env.writable:
        return f'"{env.title}" is the app\u2019s own environment — its bound is the ceiling every goal narrows from, and the model does not edit it'
    by = policy.denies(tool_name)
    if by:
        return f'{tool_name} is denied by "{by}" — harness_read-equivalent (goal_read) still works'
    return None
