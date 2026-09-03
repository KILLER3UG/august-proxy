"""Latency fix 1 — the turn-start shadow-git snapshot must not block the
event loop.

Measured (2026-09-02 live profile): the first turn on a workspace spent
6.13 s of wall clock inside ``shadow_git.commit_snapshot`` (blocking
``subprocess.run`` git add/status/commit/rev-parse) — ON the event loop,
BEFORE the model call. Every other API request stalls behind it for the
duration; the user perceives it as "the app hangs before even starting to
think".

Fix: the turn-start baseline snapshot runs on a worker thread
(``asyncio.to_thread``) and the turn does not wait for it to finish — the
snapshot only needs to complete before the turn's first MUTATION, so we
await it lazily at the first write boundary instead of turn start.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from app.services.workbench import shadow_git


@pytest.fixture
def ws(tmp_path):
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    return str(tmp_path)


class TestSnapshotOffLoop:
    def test_commit_snapshot_is_sync_and_slow(self, ws):
        """Sanity: the snapshot fn itself is blocking (that's why the call
        site must offload it) — 4+ git subprocesses, each .2-1s on a big
        repo. We assert it takes nonzero time, NOT that it is fast."""
        t0 = time.perf_counter()
        sha = shadow_git.commit_snapshot("lat-test-1", ws, "baseline")
        assert sha, "snapshot should succeed on a real dir"
        assert time.perf_counter() - t0 > 0.0

    async def test_turn_start_snapshot_does_not_block_loop(self, ws, monkeypatch):
        """RED: the turn-start path must schedule the snapshot OFF the loop.

        Simulate a slow snapshot (2s) and prove the loop stays responsive:
        a concurrently-scheduled task (the model call stands in for it)
        completes within a fraction of the snapshot time.
        """
        loop = asyncio.get_running_loop()  # noqa: F841 — asserted indirectly: the helper needs one
        del loop
        from app.services.workbench import workbench as wb

        # Stub the snapshot to a slow-but-successful subprocess-free impl.
        state = {"awaited_inline": False}

        def slow_snapshot(session_id, workspace, message):
            state["awaited_inline"] = True
            time.sleep(2.0)  # blocking — what a big repo costs
            return "deadbeef"

        monkeypatch.setattr(shadow_git, "commit_snapshot", slow_snapshot)

        # The turn loop's snapshot helper: must be awaitable AND off-loop.
        helper = getattr(wb, "_turnBaselineSnapshotTask", None)
        assert helper is not None, (
            "workbench must expose an async turn-baseline snapshot helper that "
            "offloads commit_snapshot to a worker thread"
        )
        t0 = time.perf_counter()
        task = helper("sess-x", ws, "turn 1 start")
        # While the snapshot runs on its thread, the loop must be free:
        await asyncio.sleep(0.1)
        probe_t0 = time.perf_counter()
        await asyncio.sleep(0.05)
        probe = time.perf_counter() - probe_t0
        assert probe < 0.3, f"event loop blocked while snapshot ran ({probe:.2f}s)"
        sha = await asyncio.wait_for(task, 5)
        assert sha == "deadbeef"
        assert time.perf_counter() - t0 >= 2.0
