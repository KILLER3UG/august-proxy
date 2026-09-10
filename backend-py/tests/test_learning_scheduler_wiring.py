"""P2 wiring: the unified learning scheduler must be the ONLY starter of
scheduled learning passes.

The loop this replaces shipped as three independent pollers, each with its
own due-ness bookkeeping (and the introspection loop had none at all — every
boot ran it regardless of elapsed time). The failure mode that regression
protects is a new cadence job getting its own `asyncio.create_task(…_loop())`
somewhere instead of a `Job` in the registry: the ledger goes blind to it,
the Learning panel shows stale "last run" data, and overdue/no-op logic is
re-invented per site. Same lesson as test_learning_loop_wiring.py — green
unit tests prove behavior at the seam, not that the seam is wired.

Cheap on purpose: temp-DB ledger round trips + source scans. No server, no
model calls, no real job bodies run.
"""

from __future__ import annotations

import re
from pathlib import Path

import app.services.learning_scheduler as ls

_BACKEND = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (_BACKEND / rel).read_text(encoding='utf-8')


class TestSchedulerIsTheOnlyStarter:
    def test_no_legacy_loop_starters_remain(self) -> None:
        """Production code must not start the retired pollers; the module
        docstring/comments are allowed to name them."""
        for rel in ('app/main.py', 'app/services/cognitive_boot.py'):
            src = _read(rel)
            assert 'scheduled_introspection_loop' not in src, f'{rel} still starts introspection'
            assert re.search(r'create_task\(\s*consolidation_loop', src) is None, (
                f'{rel} still starts the consolidation poller'
            )

    def test_scheduler_started_once_from_lifespan(self) -> None:
        src = _read('app/main.py')
        assert 'scheduler_loop()' in src, 'lifespan no longer starts the learning scheduler'
        assert 'create_task' in src.split('scheduler_loop()')[0][-200:], (
            'scheduler_loop must be started as a task'
        )

    def test_registry_covers_both_cadences(self) -> None:
        assert set(ls.JOBS) >= {'introspection', 'consolidation'}, ls.JOBS.keys()
        # Cadence keys exist in brain config so the intervals are user-tunable.
        from app.services.brain_config_service import allowedKeys

        assert {'consolidationIntervalHours', 'introspectionIntervalHours'} <= set(allowedKeys)


class TestLedger:
    """conftest's autouse isolatedData fixture keeps the brain DB in tmp."""

    def test_run_writes_a_finished_row_with_summary(self) -> None:
        calls: list[int] = []

        def body() -> dict:
            calls.append(1)
            return {'observationsFiled': len(calls)}

        ls._register(ls.Job('wire-test', body, lambda: 6.0))
        out = ls.run_job('wire-test')
        assert out['ok'] and out['status'] == 'ok'
        row = ls.last_run('wire-test')
        assert row and row['status'] == 'ok'
        assert 'observationsFiled' in (row['detail'] or '')
        assert ls.JOBS['wire-test'].due() is False  # just ran → not overdue

    def test_failed_job_lands_in_the_ledger_not_the_loop(self) -> None:
        def boom() -> dict:
            raise RuntimeError('wire kaboom')

        ls._register(ls.Job('wire-bad', boom, lambda: 6.0))
        out = ls.run_job('wire-bad')
        assert out['ok'] is False and out['status'] == 'error'
        row = ls.last_run('wire-bad')
        assert row['status'] == 'error' and 'wire kaboom' in row['detail']
        # A failed run still resets due-ness (the tick loop must not hot-retry).
        assert ls.JOBS['wire-bad'].due() is False

    def test_unknown_job_is_a_receipt_not_an_exception(self) -> None:
        out = ls.run_job('definitely-not-registered')
        assert out['ok'] is False and 'unknown job' in out['error']

    def test_status_endpoint_shape(self) -> None:
        st = ls.scheduler_status()
        names = {j['job'] for j in st['jobs']}
        assert {'introspection', 'consolidation'} <= names
        for j in st['jobs']:
            assert {'intervalHours', 'lastStatus', 'nextDueAt'} <= set(j)


class TestSchedulerRoutes:
    def test_routes_answer_over_http(self) -> None:
        """The panel reads cadence/last-run through mounted routes; the same
        write/read split that killed the refine store kills the scheduler's
        UI if these vanish."""
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        res = client.get('/api/curator/scheduler')
        assert res.status_code == 200, res.status_code
        body = res.json()
        assert {'introspection', 'consolidation'} <= {j['job'] for j in body['jobs']}

        res = client.post('/api/curator/scheduler/run/nope-not-a-job')
        assert res.status_code == 404
