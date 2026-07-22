"""Automations upgrade: lock scope, stuck recovery, schedule/tick, trigger auth, memory inject."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture
def auto_iso(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services import automations_store as store

    store.reset_store()
    yield tmp_path
    store.reset_store()
    settings.reload()


@pytest.mark.asyncio
async def test_concurrent_writers_preserve_history_and_pause(auto_iso):
    from app.services import automations_store as store

    job = await store.upsert_job_async(
        {'name': 'j1', 'jobType': 'noop', 'schedule': 'every 30m', 'prompt': 'x'}
    )
    jid = str(job['id'])

    async def appender():
        for i in range(8):
            await store.append_run(
                jid,
                status='idle',
                trigger='manual',
                output_snippet=f'run-{i}',
            )

    async def pauser():
        await asyncio.sleep(0.01)
        await store.pause_job(jid, paused=True)

    async def upserter():
        await asyncio.sleep(0.005)
        await store.upsert_job_async({'id': jid, 'name': 'j1-renamed'})

    await asyncio.gather(appender(), pauser(), upserter())
    final = store.get_job(jid)
    assert final is not None
    assert final['paused'] is True
    assert final['name'] == 'j1-renamed'
    runs = final.get('runs') or []
    assert len(runs) >= 8


@pytest.mark.asyncio
async def test_pause_while_mock_stream_does_not_hold_lock(auto_iso):
    from app.services import automations_store as store

    job = await store.upsert_job_async(
        {'name': 'stream', 'jobType': 'noop', 'schedule': '', 'prompt': 'hi'}
    )
    jid = str(job['id'])
    paused_at: list[float] = []

    async def long_work():
        # Simulate stream: status running under short lock, then sleep without lock.
        def start(s):
            j = s[jid]
            j['status'] = 'running'
            j['runningStartedAt'] = store._now()

        await store._mutate(start)
        await asyncio.sleep(0.15)
        def finish(s):
            j = s[jid]
            j['status'] = 'idle'
            j['runningStartedAt'] = None

        await store._mutate(finish)

    async def pause_midway():
        await asyncio.sleep(0.03)
        t0 = asyncio.get_event_loop().time()
        await store.pause_job(jid, paused=True)
        paused_at.append(asyncio.get_event_loop().time() - t0)

    await asyncio.gather(long_work(), pause_midway())
    assert paused_at and paused_at[0] < 0.1  # pause must not wait for stream sleep
    assert store.get_job(jid)['paused'] is True


@pytest.mark.asyncio
async def test_stuck_running_boot_and_stale_recovery(auto_iso):
    from app.services import automations_store as store

    job = await store.upsert_job_async({'name': 'stuck', 'jobType': 'noop', 'prompt': 'x'})
    jid = str(job['id'])

    def mark_running(s):
        j = s[jid]
        j['status'] = 'running'
        j['runningStartedAt'] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()

    await store._mutate(mark_running)
    n = await store.recover_stuck_running(boot=True)
    assert n == 1
    recovered = store.get_job(jid)
    assert recovered['status'] == 'error'
    assert any(r.get('trigger') == 'recovery' for r in (recovered.get('runs') or []))

    def mark_fresh(s):
        j = s[jid]
        j['status'] = 'running'
        j['runningStartedAt'] = datetime.now(timezone.utc).isoformat()

    await store._mutate(mark_fresh)
    n2 = await store.recover_stuck_running(boot=False, now=datetime.now(timezone.utc))
    assert n2 == 0  # fresh run not stale


@pytest.mark.asyncio
async def test_schedule_next_run_and_pause_skips_due(auto_iso):
    from app.services import automations_store as store
    from app.services.automations_schedule import compute_next_run_at, system_local_timezone

    tz = system_local_timezone()
    assert tz  # never empty
    nxt = compute_next_run_at('every 30m', tz)
    assert nxt

    job = await store.upsert_job_async(
        {
            'name': 'due',
            'jobType': 'noop',
            'schedule': 'every 30m',
            'prompt': 'x',
            'timezone': tz,
            'nextRunAt': (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        }
    )
    jid = str(job['id'])
    assert jid in store.due_job_ids()
    await store.pause_job(jid, paused=True)
    assert jid not in store.due_job_ids()


@pytest.mark.asyncio
async def test_tick_fires_due_noop_once(auto_iso):
    from app.services import automations_store as store

    job = await store.upsert_job_async(
        {
            'name': 'tickme',
            'jobType': 'noop',
            'schedule': 'every 30m',
            'prompt': 'x',
            'nextRunAt': (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(),
        }
    )
    started = await store.tick_automations()
    assert str(job['id']) in started
    final = store.get_job(str(job['id']))
    assert final['status'] == 'idle'
    assert final.get('lastOutput') == 'noop'


@pytest.mark.asyncio
async def test_trigger_auth_and_rotate(auto_iso):
    from app.main import app
    from app.services import automations_store as store
    from httpx import ASGITransport, AsyncClient

    job = await store.upsert_job_async(
        {'name': 'hook', 'jobType': 'noop', 'prompt': 'ping', 'schedule': ''}
    )
    jid = str(job['id'])
    token = str(job['triggerToken'])

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        bad = await client.post(
            f'/api/automations/{jid}/trigger',
            headers={'Authorization': 'Bearer wrong'},
        )
        assert bad.status_code == 401

        ok = await client.post(
            f'/api/automations/{jid}/trigger',
            headers={'Authorization': f'Bearer {token}'},
        )
        assert ok.status_code == 200

        rot = await client.post(f'/api/automations/{jid}/rotate-token')
        assert rot.status_code == 200
        new_token = rot.json()['triggerToken']
        assert new_token and new_token != token

        stale = await client.post(
            f'/api/automations/{jid}/trigger',
            headers={'Authorization': f'Bearer {token}'},
        )
        assert stale.status_code == 401


def test_auto_memory_blender_fts_recall(auto_iso):
    from app.services import memory_store
    from app.services.memory.auto_memory import getRelevantMemories, saveAutoMemory

    memory_store.init()
    saveAutoMemory(
        'project_blender',
        'User is working on Blender project X — modeling a character',
        category='project',
        importance=0.9,
    )
    rows = getRelevantMemories('blender', limit=5)
    assert rows, 'FTS/LIKE recall must return blender memory'
    blob = ' '.join(str(r.get('content') or r.get('key') or '') for r in rows).lower()
    assert 'blender' in blob
    # Sane columns
    assert 'key' in rows[0] or 'content' in rows[0]


def test_cross_session_memory_inject_a_to_b(auto_iso):
    from app.services import memory_store
    from app.services.memory.context_builder import buildSystemPrompt
    from app.services.memory.cross_session_context import sync_from_turn

    memory_store.init()
    sync_from_turn(
        workspace_path=r'C:\Dev\BlenderProject',
        last_user_text='Continue the Blender character model',
    )
    projects = memory_store.get_memory('active_projects')
    assert isinstance(projects, list) and projects
    assert 'Blender' in str(projects[0].get('name') or projects[0].get('path'))
    ctx = str(memory_store.get_memory('current_context') or '')
    assert 'Blender' in ctx or 'blender' in ctx.lower()

    # Session B prompt assembly should include the project without session A messages.
    prompt = buildSystemPrompt(
        memory={
            'active_projects': projects,
            'global_context': ctx,
            'userProfile': None,
            'autoMemories': [],
        }
    )
    assert 'Blender' in prompt or 'blender' in prompt.lower()
