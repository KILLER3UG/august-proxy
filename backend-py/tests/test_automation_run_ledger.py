"""M-11 ledger fidelity for workbench automation runs.

A turn that ends with a stream ``error`` event (provider 4xx/5xx, retry
exhaustion) returns normally from ``sendWorkbenchMessageStream`` — the
ledger must record ``failed`` (+ incident) or chronic model failures would
never reach the automation_incidents table.
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture()
def store(isolatedData):
    from app.services.memory_store import init as init_store

    init_store()
    from app.services import automation_memory

    return automation_memory


def _seedJob(isolatedData):
    """A real persisted workbench job so wake_context/_finish_run have a row."""
    from app.services import automations_store

    job = automations_store.upsert_job(
        {
            'name': 'ledger fidelity job',
            'prompt': 'do the thing',
            'schedule': 'every 1h',
            'jobType': 'workbench',
        }
    )
    return job


def test_stream_error_event_marks_ledger_failed(store, isolatedData, monkeypatch):
    from app.services import automations_store
    from app.services.workbench import workbench as wb

    job = _seedJob(isolatedData)

    async def fakeStream(sessionId, message, **kwargs):
        emit = kwargs.get('emit')
        # simulate the turn loop's error surface
        if emit is not None:
            emit({'type': 'error', 'error': 'provider 400: model overloaded'})

    monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fakeStream)

    async def run():
        await automations_store._run_workbench_stream(
            job['id'], dict(job), trigger='manual'
        )

    asyncio.run(run())
    row = store.last_run(job['id'])
    assert row is not None
    assert row['status'] == 'failed', row
    assert row['error_signature'] == 'provider 400: model overloaded'[:120]
    open = store.open_incidents(job['id'])
    assert len(open) == 1 and open[0]['occurrences'] == 1


def test_clean_stream_marks_ledger_succeeded_and_closes_incident(
    store, isolatedData, monkeypatch
):
    from app.services import automations_store
    from app.services.workbench import workbench as wb

    job = _seedJob(isolatedData)
    # An open incident from a previous failed run.
    rid = store.start_run(job_id=job['id'])
    store.finish_run(rid, status='failed', error_sig='earlier outage')

    async def fakeStream(sessionId, message, **kwargs):
        pass  # clean turn, no error events

    monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fakeStream)

    async def run():
        await automations_store._run_workbench_stream(
            job['id'], dict(job), trigger='manual'
        )

    asyncio.run(run())
    row = store.last_run(job['id'])
    assert row is not None and row['status'] == 'succeeded', row
    assert store.open_incidents(job['id']) == [], 'success must close open incidents'


class TestM11RunsApi:
    """M-11 remaining gaps: runs/incidents readable over the API."""

    def test_runs_and_incidents_endpoints(self, store, isolatedData):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            created = client.post(
                '/api/automations',
                json={'name': 'ledger-api', 'schedule': 'daily 09:00', 'prompt': 'ping'},
            ).json()
            job_id = created['id']
            from app.services import automation_memory as am

            run_id = am.start_run(job_id=job_id, trigger='manual')
            am.finish_run(run_id, status='failed', error_sig='connection reset by peer')
            runs = client.get(f'/api/automations/{job_id}/runs').json()
            assert runs['runs'] and runs['runs'][0]['status'] == 'failed'
            assert 'reset by peer' in runs['runs'][0]['errorSignature']
            incidents = client.get('/api/automations/incidents').json()
            assert any(i['jobId'] == job_id for i in incidents['incidents'])


class TestM11SchedulerLedger:
    """M-11: legacy scheduler.py runs must land in the same ledger."""

    def test_legacy_cron_run_writes_ledger(self, isolatedData, monkeypatch):
        import asyncio

        from app.services import scheduler

        monkeypatch.setattr(scheduler, '_loadJobs', lambda: None)
        monkeypatch.setattr(scheduler, '_saveJobs', lambda: None)
        job = scheduler.createJob('legacy-ledger', 'daily 09:00', 'echo hi')

        class FakeResult:
            exit_code = 0
            elapsed_ms = 12

            def as_tool_text(self):
                return 'hi'

        async def fake_run(command, policy, *, timeout=300.0):
            return FakeResult()

        import app.services.sandbox.runner as runner

        monkeypatch.setattr(runner, 'run_sandboxed', fake_run)
        out = asyncio.run(scheduler.runJobNow(job['id']))
        assert out['status'] == 'idle'
        from app.services import automation_memory as am

        row = am.last_run(job['id'])
        assert row is not None and row['status'] == 'succeeded'
        assert row['trigger'] == 'cron-legacy'


class TestM11DerivedSummaryFields:
    """M-11: lastRunAt/lastResult/lastError are DERIVED from the runs ledger
    in _finish_run — never written independently (one source of truth)."""

    def test_finish_run_derives_summary_from_ledger(self, store, isolatedData, monkeypatch):
        from app.services import automations_store
        from app.services.workbench import workbench as wb

        job = _seedJob(isolatedData)

        async def fakeStream(sessionId, message, **kwargs):
            emit = kwargs.get('emit')
            if emit is not None:
                emit({'type': 'text', 'content': 'brief text output'})

        monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fakeStream)

        async def run():
            await automations_store._run_workbench_stream(
                job['id'], dict(job), trigger='manual'
            )

        asyncio.run(run())
        fresh = automations_store.get_job(job['id'])
        runs = fresh['runs']
        assert runs, 'run row must exist'
        last = runs[-1]
        assert fresh['lastRunAt'] == (last.get('finishedAt') or last.get('startedAt'))
        assert fresh['lastResult'] == (last.get('outputSnippet') or '')[:1000]
        assert fresh['lastError'] == '', 'succeeded run must not carry lastError'

    def test_failed_run_carries_lastError(self, store, isolatedData, monkeypatch):
        from app.services import automations_store
        from app.services.workbench import workbench as wb

        job = _seedJob(isolatedData)

        async def fakeStream(sessionId, message, **kwargs):
            emit = kwargs.get('emit')
            if emit is not None:
                emit({'type': 'error', 'error': 'provider 500: boom'})

        monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fakeStream)

        async def run():
            await automations_store._run_workbench_stream(
                job['id'], dict(job), trigger='manual'
            )

        asyncio.run(run())
        fresh = automations_store.get_job(job['id'])
        assert 'boom' in (fresh['lastError'] or '')
