"""Fan-out bounds for sub-agents: how many run at once, how many per turn,
and how much work a dispatch may do in total.

Why this module exists
----------------------
A model can ask the harness to "fan out N agents, go". Every child is a full
conversation loop that holds its own transcript, tool surface and context, and
the parent session absorbs one completion notice per child. This is the one
place a developer laptop gets to say how much of that the backend may run.

Before this module the only bound in the process was a hardcoded five-worker
pool that no setting could move (``runtime_services`` passed ``max_workers=5``
into the orchestrator) while the Settings → Subagents number
(``subagentMaxConcurrent``, range 1..30) sized a *per-session* semaphore that
the global pool then overrode — so raising it did nothing, and the "N work
items exceeds maxConcurrent" branch only ever logged. The per-turn child count
was unbounded in code: the tool schema says ``maxItems: 10``
(``tool_registrations/agent_tools.py``) but ``workbench.validator`` checks
types/required only, never ``maxItems``, so a 200-item dispatch created 200
eager ``asyncio.Task`` objects, 200 handles, 200 ``subagent_runs`` rows and
200 completion notices for the parent to hold.

Three independent bounds, each with one authority
-------------------------------------------------
1. **Concurrency** — :class:`ConcurrencyGate` wrapping sub-agent execution.
   Process-wide, sized by brain-config ``subagentMaxConcurrent``
   (default :data:`SUBAGENT_CONCURRENCY_DEFAULT`, hard ceiling
   :data:`SUBAGENT_CONCURRENCY_CEILING`). The per-session semaphore in the
   orchestrator stays as the fairness layer, so the effective gate is
   ``min(per-session intent, this process pool)`` exactly as before — only now
   the process pool is the configured one and it may move without a restart.
2. **Children per dispatch** — :func:`resolve_fanout_limits` returns
   ``max_children_per_fanout`` (default :data:`MAX_CHILDREN_PER_FANOUT_DEFAULT`).
   Exceeding it is a loud, self-heal-style rejection of the WHOLE dispatch,
   never a silent truncation.
3. **Aggregate work per dispatch** — a shared tool-round budget
   (:data:`FANOUT_ROUND_BUDGET_DEFAULT` rounds across ALL children of one
   fan-out) charged by :func:`charge_fanout_round` from the child loop, so N
   children cannot collectively do N times the work unbounded.

All three are observable: :func:`fanout_snapshot` / :func:`ConcurrencyGate.snapshot`
feed the ``subagentFanout`` session-log event and the ``subagent_fanout`` row in
``turn_outcomes`` (the existing per-turn telemetry — no second mechanism).

Defaults and why those values
-----------------------------
* ``SUBAGENT_CONCURRENCY_DEFAULT = 4``: one below the old hardcoded 5, still
  real parallelism for a wave of independent lanes, and 20% less peak of the
  thing that actually costs RAM — each live child transcript plus the JSON body
  re-serialized per round.
* ``SUBAGENT_CONCURRENCY_CEILING = 8``: a desktop backend shares the machine
  with the IDE, the browser and the Tauri shell. A settings value of 30 would
  mean 30 concurrent transcripts; the ceiling keeps the *process* bound honest
  while the per-session gate still honours a lower user intent.
* ``MAX_CHILDREN_PER_FANOUT_DEFAULT = 8``: two waves of four at the default
  pool size. High enough for a real decomposition ("audit these 6 modules"),
  low enough that one turn cannot ask for fifty conversations.
* ``FANOUT_ROUND_BUDGET_DEFAULT = 240``: eight children at the default 50-round
  depth would be 400 model calls with no ceiling; 240 still lets six children
  run the full default depth and kills a runaway fleet.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.json_narrowing import as_dict, as_int

logger = logging.getLogger(__name__)

# ── the numbers (quoted by AGENTS.md — keep docs in step, `npm run check:docs`) ─
SUBAGENT_CONCURRENCY_DEFAULT = 4
SUBAGENT_CONCURRENCY_CEILING = 8
# Historical module constant of ``subagent_orchestrator`` (it was the whole
# answer there, hardcoded at 5). It is now only the DEFAULT — the applied pool
# size comes from :func:`resolve_subagent_concurrency` on every dispatch.
MAX_CONCURRENT_WORKERS = SUBAGENT_CONCURRENCY_DEFAULT
MAX_CHILDREN_PER_FANOUT_DEFAULT = 8
MAX_CHILDREN_PER_FANOUT_CEILING = 24
# 0 means "no aggregate bound" and is an opt-out an operator may choose; the
# shipped default is a real number (see module docstring).
FANOUT_ROUND_BUDGET_DEFAULT = 240
FANOUT_ROUND_BUDGET_CEILING = 2000
# How long a caller may wait for a worker slot before the spawn is failed with a
# visible receipt (orchestrator's SLOT_ACQUIRE_TIMEOUT_SECONDS).
SLOT_ACQUIRE_TIMEOUT_SECONDS = 600.0

# A queued-then-abandoned fan-out record must not live forever.
_FANOUT_TTL_S = 6 * 3600.0
_MAX_RETAINED_FANOUTS = 64

# Why a fan-out ended, in the same spirit as the ``turn_end`` reason vocabulary:
# read this before auditing code for "why did the fleet stop".
FANOUT_END_FINISHED = 'finished'
FANOUT_END_CHILDREN_CAP = 'children-cap'
FANOUT_END_ROUND_BUDGET = 'round-budget'
FANOUT_END_CANCELLED = 'cancelled'


@dataclass(frozen=True)
class FanoutLimits:
    """The three bounds, already resolved and clamped for one dispatch."""

    concurrency: int = SUBAGENT_CONCURRENCY_DEFAULT
    max_children_per_fanout: int = MAX_CHILDREN_PER_FANOUT_DEFAULT
    round_budget: int = FANOUT_ROUND_BUDGET_DEFAULT
    max_iterations: int = 50
    requested_concurrency: int = SUBAGENT_CONCURRENCY_DEFAULT

    def toDict(self) -> dict[str, Any]:
        return {
            'concurrencyLimit': self.concurrency,
            'childrenCap': self.max_children_per_fanout,
            'roundBudget': self.round_budget,
            'maxIterations': self.max_iterations,
            # Non-equal to concurrencyLimit means the user asked for more than a
            # desktop may safely run and the ceiling bound it — say so rather
            # than silently disagreeing with the Settings panel.
            'requestedConcurrency': self.requested_concurrency,
            'concurrencyCeiling': SUBAGENT_CONCURRENCY_CEILING,
        }


def _delegation_source(
    delegation: dict[str, object] | None = None,
    session: object = None,
) -> dict[str, object]:
    """Merge the three sources of a delegation limit, key by key.

    Explicit dict wins, then the session's own ``metadata.delegation``, then the
    global brain-config limits — the same precedence the orchestrator has always
    used for ``maxConcurrent``/``maxDepth`` (one authority, no second merge).
    """
    source = dict(as_dict(delegation))
    if session is not None:
        meta = as_dict(getattr(session, 'metadata', None))
        for key, value in as_dict(meta.get('delegation')).items():
            source.setdefault(key, value)
    # The global limits fill EVERY remaining gap, not only an empty dict: a
    # session that overrides just `maxDepth` must still inherit the configured
    # pool size / children cap / round budget, exactly as the orchestrator's own
    # key-by-key merge has always done. Anything less and the spawn tool's
    # pre-check and the orchestrator's backstop would resolve different numbers.
    try:
        from app.services.brain_config_service import getDelegationLimits

        for key, value in as_dict(getDelegationLimits()).items():
            source.setdefault(key, value)
    except Exception:
        logger.debug('delegation limits read failed; using defaults', exc_info=True)
    return source


def _clamped(source: dict[str, object], key: str, default: int, ceiling: int, *, allow_zero: bool = False) -> int:
    """Read one integer limit: unset/garbage → default, out of range → clamp.

    ``allow_zero`` keeps an explicit 0 (the opt-out for the round budget)
    instead of folding it into the default — 0 is a decision, not an absence.
    """
    value = as_int(source.get(key), -1)
    if value < 0:
        return default
    if value == 0:
        return 0 if allow_zero else default
    return min(ceiling, value)


def resolve_subagent_concurrency(
    delegation: dict[str, object] | None = None,
    session: object = None,
) -> int:
    """Process-wide worker pool size: ``maxConcurrent`` clamped to the ceiling.

    The Settings panel may legitimately say 30 (a workstation with plenty of
    RAM); the pool never exceeds :data:`SUBAGENT_CONCURRENCY_CEILING`, and the
    applied value is what the fan-out telemetry reports, together with the
    number that was asked for.
    """
    source = _delegation_source(delegation, session)
    requested = _clamped(source, 'maxConcurrent', SUBAGENT_CONCURRENCY_DEFAULT, 10**6)
    return min(SUBAGENT_CONCURRENCY_CEILING, requested)


def resolve_fanout_limits(
    delegation: dict[str, object] | None = None,
    session: object = None,
) -> FanoutLimits:
    """One call, all three bounds — spawn tool and orchestrator cannot disagree."""
    source = _delegation_source(delegation, session)
    requested = _clamped(source, 'maxConcurrent', SUBAGENT_CONCURRENCY_DEFAULT, 10**6)
    return FanoutLimits(
        concurrency=min(SUBAGENT_CONCURRENCY_CEILING, requested),
        max_children_per_fanout=_clamped(
            source, 'maxChildrenPerTurn', MAX_CHILDREN_PER_FANOUT_DEFAULT, MAX_CHILDREN_PER_FANOUT_CEILING
        ),
        round_budget=_clamped(
            source, 'fanoutRoundBudget', FANOUT_ROUND_BUDGET_DEFAULT, FANOUT_ROUND_BUDGET_CEILING, allow_zero=True
        ),
        max_iterations=_clamped(source, 'maxIterations', 50, 200),
        requested_concurrency=requested,
    )


# ── messages the model reads ───────────────────────────────────────────────


def children_cap_message(requested: int, limit: int) -> str:
    """The self-heal receipt for asking for more children than one turn may run.

    Rejection, not truncation: a silently dropped lane looks to the parent like
    a lost result, and the fleet it thought it launched never existed. Follows
    the ``[Proxy Self-Heal]`` convention — runtime-only, says so, and tells the
    model what to do instead of just refusing.
    """
    return (
        f'[Proxy Self-Heal] This dispatch asked for {requested} sub-agents; one turn may request at most '
        f'{limit} (brain setting subagentMaxChildrenPerTurn). NOTHING WAS STARTED — no lane ran, so nothing '
        'was lost. Re-request with at most '
        f'{limit} work items: merge lanes that do not need their own conversation, raise maxIterations per '
        'lane instead of adding lanes, or dispatch the rest in a later turn once these completions land. '
        'This is a runtime resource limit of this harness, not a durable fact about the task.'
    )


def round_budget_message(fanout_id: str, budget: int, used: int) -> str:
    """The child-side receipt when the SHARED budget of a fan-out runs out."""
    return (
        f'[Proxy Self-Heal] This sub-agent stopped because the whole dispatch ({fanout_id}) used its shared '
        f'round budget ({used} of {budget} tool rounds across all its children). Other lanes were still '
        'running, so the budget is spent even though this lane had iterations left. Report what you have '
        'as status=partial with the concrete next step — the bound is a runtime resource limit of this '
        'harness, not a durable fact about the task.'
    )


# ── the concurrency gate ───────────────────────────────────────────────────


class ConcurrencyGate:
    """A worker gate whose permit count may change while slots are held.

    ``asyncio.Semaphore`` cannot do this: its size is fixed at construction, so
    a Settings change needs a restart (or a rebuild that strands whatever
    permits were already outstanding). Growth applies immediately; a shrink
    stops admitting new workers without breaking anything already running.

    Single-threaded by construction (an event loop): the check-and-increment in
    :meth:`acquire` has no ``await`` between them, so it is atomic the same way
    ``Semaphore._value`` is. ``release()`` stays SYNCHRONOUS on purpose — an
    ``await`` inside the worker's ``finally`` can raise on a cancelling task and
    leak the slot forever, which is the exact failure mode the orchestrator's
    ``_acquire_slot`` comments were written about.

    Duck-typed against the semaphore it replaces (``acquire()``, ``release()``,
    ``locked()``) so the orchestrator keeps ONE slot-acquisition path.
    """

    def __init__(self, limit: int | Callable[[], int] = SUBAGENT_CONCURRENCY_DEFAULT, name: str = '') -> None:
        self._limit_provider = (lambda: int(limit)) if not callable(limit) else limit
        self._name = name
        self._running = 0
        self._peak = 0
        self._timeouts = 0
        self._waiters: list[asyncio.Future[bool]] = []

    # -- introspection (telemetry) ----------------------------------------
    @property
    def limit(self) -> int:
        try:
            return max(1, int(self._limit_provider()))
        except (TypeError, ValueError):
            return SUBAGENT_CONCURRENCY_DEFAULT

    @property
    def in_use(self) -> int:
        return self._running

    @property
    def peak(self) -> int:
        return self._peak

    def set_limit(self, new_limit: int) -> int:
        """Pin the size (the orchestrator calls this per dispatch when the pool
        follows brain config, so the value is read once per fan-out instead of
        on every acquire). Returns the applied limit."""
        applied = max(1, int(new_limit or 1))
        self._limit_provider = lambda: applied
        return applied

    def locked(self) -> bool:
        """No slot free right now — same question ``Semaphore.locked()`` answers,
        and the orchestrator uses it for the same purpose (mark a spawn queued
        rather than pending so the drawer can show a queue position)."""
        return self._running >= self.limit

    def snapshot(self) -> dict[str, Any]:
        return {
            'gate': self._name,
            'limit': self.limit,
            'inUse': self._running,
            'peak': self._peak,
            'queued': len(self._waiters),
            'slotTimeouts': self._timeouts,
        }

    # -- the gate ----------------------------------------------------------
    async def acquire(self, timeout: float | None = None) -> bool:
        """Take a slot. True = held (caller MUST pair with one ``release()``).

        ``timeout=None`` waits until woken or cancelled, which is what the
        orchestrator uses: its ``_acquire_slot`` wrapper owns the deadline so
        the semaphore and the gate share one acquisition path. A caller that
        passes a timeout gets False when the wait expires.

        Safety never depends on a wake being delivered: ``_running < limit`` is
        re-checked at the increment, so a lost or duplicated wake can only make
        a waiter wait longer, never admit more than ``limit`` workers. The
        wake hand-off below is about not letting a slot idle while a queue
        exists.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout if timeout is not None else None
        while True:
            # No await between the check and the increment: atomic per event loop.
            if self._running < self.limit:
                self._running += 1
                if self._running > self._peak:
                    self._peak = self._running
                return True
            fut: asyncio.Future[bool] = loop.create_future()
            self._waiters.append(fut)
            expired = False
            remaining = None if deadline is None else deadline - loop.time()
            if remaining is not None and remaining <= 0:
                self._discard(fut)
                self._timeouts += 1
                return False
            try:
                await asyncio.wait_for(fut, remaining)
            except TimeoutError:  # asyncio.TimeoutError IS this in 3.11+
                expired = True
            except asyncio.CancelledError:
                # Stop-all / session delete while queued: leave the line, and
                # pass on a wake we were granted but will not spend.
                self._discard(fut)
                if fut.done() and not fut.cancelled():
                    self._wake_next()
                raise
            self._discard(fut)
            if expired:
                if fut.done() and not fut.cancelled():
                    # Woken in the same tick we expired — hand the wake on.
                    self._wake_next()
                self._timeouts += 1
                return False

    def _discard(self, fut: asyncio.Future[bool]) -> None:
        try:
            self._waiters.remove(fut)
        except ValueError:
            pass

    def _wake_next(self) -> None:
        while self._waiters:
            fut = self._waiters.pop(0)
            if not fut.done():
                fut.set_result(True)
                return

    def release(self) -> None:
        """Return one slot. Sync, safe to call from a ``finally``."""
        if self._running > 0:
            self._running -= 1
        self._wake_next()


# ── the aggregate work bound (per fan-out) ─────────────────────────────────


@dataclass
class FanoutRecord:
    """One dispatch's shared budget and observed concurrency."""

    fanoutId: str
    sessionId: str = ''
    roundBudget: int = 0
    roundsUsed: int = 0
    childrenRequested: int = 0
    childrenStarted: int = 0
    childrenRunning: int = 0
    childrenPeak: int = 0
    childrenFinished: int = 0
    stoppedBy: str = ''
    createdAt: float = field(default_factory=time.time)
    endedAt: float | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            'fanoutId': self.fanoutId,
            'sessionId': self.sessionId,
            'roundBudget': self.roundBudget,
            'roundsUsed': self.roundsUsed,
            'childrenRequested': self.childrenRequested,
            'childrenStarted': self.childrenStarted,
            'childrenPeak': self.childrenPeak,
            'childrenFinished': self.childrenFinished,
            'stoppedBy': self.stoppedBy,
            'elapsedS': round((self.endedAt or time.time()) - self.createdAt, 2),
        }


_fanouts: dict[str, FanoutRecord] = {}


def _sweep_fanouts(now: float | None = None) -> None:
    """Prune fan-outs nobody closed (crashed watch task) after a TTL."""
    now = time.time() if now is None else now
    for fid in list(_fanouts.keys()):
        rec = _fanouts.get(fid)
        if rec is None:
            continue
        if now - rec.createdAt > _FANOUT_TTL_S:
            _fanouts.pop(fid, None)
    # A registry that only grows is a leak of exactly the kind this module
    # exists to prevent.
    while len(_fanouts) > _MAX_RETAINED_FANOUTS:
        oldest = min(_fanouts.values(), key=lambda r: r.createdAt)
        _fanouts.pop(oldest.fanoutId, None)


def new_fanout_id() -> str:
    """Id for a dispatch that has no harness job row (no session / create failed).

    The bound must exist even when the ledger does not, and the child loop only
    carries one identifier (``harness_job_id``) — so a dispatch without a job
    still gets a budget key. Unknown ids are inert in ``harness_jobs``, so
    ``mark_dirty`` / ``record_lane`` simply no-op on it, as they did with ''.
    """
    import uuid

    return f'fan_{uuid.uuid4().hex[:12]}'


def begin_fanout(
    fanout_id: str,
    *,
    session_id: str = '',
    round_budget: int = FANOUT_ROUND_BUDGET_DEFAULT,
    children_requested: int = 0,
) -> FanoutRecord:
    """Open the shared budget for one dispatch (idempotent per id)."""
    rec = _fanouts.get(fanout_id)
    if rec is None:
        rec = FanoutRecord(
            fanoutId=fanout_id,
            sessionId=session_id,
            roundBudget=max(0, int(round_budget or 0)),
            childrenRequested=int(children_requested or 0),
        )
        _fanouts[fanout_id] = rec
    else:
        rec.childrenRequested = max(rec.childrenRequested, int(children_requested or 0))
        if rec.roundBudget <= 0:
            rec.roundBudget = max(0, int(round_budget or 0))
    # Sweep AFTER the insert: pruning before it leaves the registry sitting at
    # limit+1 forever, which is exactly the unbounded growth this guards.
    _sweep_fanouts()
    return rec


def charge_fanout_round(fanout_id: str) -> bool:
    """One child round of the shared budget. True = allowed to proceed.

    An unknown id returns True: a child spawned outside a fan-out (daemon,
    recurring task, a direct tool call) is bounded by its own per-agent
    iteration cap, not by a budget that was never opened for it.
    """
    rec = _fanouts.get(fanout_id) if fanout_id else None
    if rec is None:
        return True
    if rec.roundBudget <= 0:
        # Opt-out (budget 0) — still counted so the telemetry is honest.
        rec.roundsUsed += 1
        return True
    if rec.roundsUsed >= rec.roundBudget:
        if rec.stoppedBy != FANOUT_END_ROUND_BUDGET:
            rec.stoppedBy = FANOUT_END_ROUND_BUDGET
            logger.info(
                '[Fanout] %s shared round budget exhausted (%d/%d) — later child rounds are refused',
                rec.fanoutId,
                rec.roundsUsed,
                rec.roundBudget,
            )
        return False
    rec.roundsUsed += 1
    return True


def note_child_start(fanout_id: str) -> None:
    rec = _fanouts.get(fanout_id) if fanout_id else None
    if rec is None:
        return
    rec.childrenStarted += 1
    rec.childrenRunning += 1
    if rec.childrenRunning > rec.childrenPeak:
        rec.childrenPeak = rec.childrenRunning


def note_child_finish(fanout_id: str) -> None:
    rec = _fanouts.get(fanout_id) if fanout_id else None
    if rec is None:
        return
    rec.childrenRunning = max(0, rec.childrenRunning - 1)
    rec.childrenFinished += 1


def note_child_refused(fanout_id: str, reason: str = FANOUT_END_ROUND_BUDGET) -> None:
    rec = _fanouts.get(fanout_id) if fanout_id else None
    if rec is None:
        return
    rec.stoppedBy = reason


def fanout_snapshot(fanout_id: str) -> dict[str, Any]:
    rec = _fanouts.get(fanout_id) if fanout_id else None
    if rec is None:
        return {'fanoutId': fanout_id or '', 'unknown': True}
    return rec.snapshot()


def end_fanout(fanout_id: str, *, reason: str = FANOUT_END_FINISHED) -> dict[str, Any]:
    """Close a dispatch's ledger and return its final numbers (for telemetry)."""
    rec = _fanouts.pop(fanout_id, None) if fanout_id else None
    if rec is None:
        return {'fanoutId': fanout_id or '', 'unknown': True, 'stoppedBy': reason}
    rec.endedAt = time.time()
    if not rec.stoppedBy:
        rec.stoppedBy = reason
    snap = rec.snapshot()
    snap['endReason'] = rec.stoppedBy
    return snap


def active_fanout_count() -> int:
    """How many dispatch budgets are open (leak guard + audit read)."""
    return len(_fanouts)


def reset_fanout_registry() -> None:
    """Test/shutdown helper: forget every open dispatch."""
    _fanouts.clear()
