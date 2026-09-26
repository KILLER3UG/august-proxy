"""Measure what the sub-agent fan-out governor actually costs in RAM.

Not a unit test — a measurement harness. Run:
    cd backend-py && PYTHONPATH=. .venv/Scripts/python.exe scripts/measure_fanout_ram.py
"""
from __future__ import annotations

import asyncio
import gc
import sys
import tracemalloc

from app.services.workbench.subagent_fanout import (
    MAX_CHILDREN_PER_FANOUT_CEILING,
    SUBAGENT_CONCURRENCY_DEFAULT,
    ConcurrencyGate,
    resolve_fanout_limits,
)


def rss_mb() -> float:
    """Python heap currently held, via tracemalloc.

    Deliberately not the Win32 working set: `GetProcessWorkingSetSizeEx` is a
    psapi export, and reaching for it through `windll.kernel32` auto-binds a
    symbol that is not there and faults the process. The quantity that answers
    "does a big fan-out blow the box" is the Python each concurrent child
    retains, and tracemalloc measures exactly that, portably.
    """
    if not tracemalloc.is_tracing():
        tracemalloc.start()
    return tracemalloc.get_traced_memory()[0] / (1024 * 1024)


def blob(mb: float) -> bytearray:
    """A touched working set — allocating is not the same as faulting in."""
    buf = bytearray(int(mb * 1024 * 1024))
    for i in range(0, len(buf), 4096):
        buf[i] = 1
    return buf


async def child(gate: ConcurrencyGate | None, hold_mb: float, seconds: float, live: list) -> None:
    if gate is not None:
        ok = await gate.acquire(timeout=60)
        if not ok:
            raise RuntimeError('gate timeout')
    try:
        live.append(blob(hold_mb))
        await asyncio.sleep(seconds)
    finally:
        live.clear()
        if gate is not None:
            gate.release()


async def wave(label: str, n: int, gate: ConcurrencyGate | None, hold_mb: float) -> None:
    gc.collect()
    base = rss_mb()
    live: list = []
    peak_rss = base
    tasks = [asyncio.create_task(child(gate, hold_mb, 0.35, live)) for _ in range(n)]
    peak_concurrent = 0
    while any(not t.done() for t in tasks):
        cur = len(live)
        peak_concurrent = max(peak_concurrent, cur)
        peak_rss = max(peak_rss, rss_mb())
        await asyncio.sleep(0.01)
    await asyncio.gather(*tasks)
    gc.collect()
    held = gate.in_use if gate is not None else -1
    print(
        f'  {label:34s} children={n:3d}  peak_live={peak_concurrent:3d}  '
        f'peak_rss=+{peak_rss - base:7.1f} MB  slots_left={held}'
    )


async def main() -> int:
    per_child_mb = 8.0
    n = 24
    print(f'per-child working set modelled at {per_child_mb:.0f} MB; {n} children requested')
    print(f'SUBAGENT_CONCURRENCY_DEFAULT={SUBAGENT_CONCURRENCY_DEFAULT}  '
          f'MAX_CHILDREN_PER_FANOUT_CEILING={MAX_CHILDREN_PER_FANOUT_CEILING}')
    print()

    print('CONTROL — no gate (what an unbounded fan-out would cost):')
    await wave('ungated', n, None, per_child_mb)

    print('\nGATED — ConcurrencyGate at the shipped default:')
    gate = ConcurrencyGate(SUBAGENT_CONCURRENCY_DEFAULT, name='measure')
    await wave('gated', n, gate, per_child_mb)
    print(f'  gate.snapshot() -> {gate.snapshot()}')

    print('\nRUNTIME RETUNE — shrink must not break running slots:')
    gate2 = ConcurrencyGate(6, name='retune')
    tasks = [asyncio.create_task(child(gate2, 1, 0.3, [])) for _ in range(12)]
    await asyncio.sleep(0.05)
    before = gate2.in_use
    gate2.set_limit(2)
    await asyncio.gather(*tasks)
    print(f'  in_use at shrink={before}  limit now={gate2.limit}  '
          f'peak={gate2.peak}  slots_left={gate2.in_use}')

    print('\nCANCELLATION — a cancelled child must return its slot:')
    # Repeated, because a single reading here is a measurement and not a
    # result: one run of this shape reported a stuck slot that 15 identical
    # trials then could not reproduce.
    trials = 15
    stuck = []
    for _ in range(trials):
        gate3 = ConcurrencyGate(2, name='cancel')
        victims = [asyncio.create_task(child(gate3, 1, 5, [])) for _ in range(6)]
        await asyncio.sleep(0.1)
        for t in victims:
            t.cancel()
        await asyncio.gather(*victims, return_exceptions=True)
        await asyncio.sleep(0.05)
        stuck.append(gate3.in_use)
    got = await gate3.acquire(timeout=1.0)
    if got:
        gate3.release()
    print(f'  {trials} trials, slots left stuck: {stuck.count(0)}/{trials} clean, '
          f'{sum(1 for s in stuck if s)}/{trials} leaked')

    print('\nREQUEST CLAMPING — asking for more than the ceiling:')
    for req in (1, 4, 16, 1000):
        lim = resolve_fanout_limits({'maxConcurrent': req})
        print(f'  requested={req:5d} -> concurrency={lim.concurrency:2d} '
              f'(asked={lim.requested_concurrency}, '
              f'capped={lim.concurrency < req}, '
              f'children_cap={lim.max_children_per_fanout}, '
              f'round_budget={lim.round_budget})')
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
