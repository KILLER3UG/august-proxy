"""Tests for backfill, dual-write retry, cognitive boot, smoke pieces."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.services import memory_store
from app.services.workbench.brain_sync import (
    backfill_workbench_json_to_brain,
    get_sync_stats,
    sync_workbench_session_to_brain,
)
from app.services.workbench.sessions import WorkbenchSession


@pytest.fixture(autouse=True)
def _init():
    memory_store.init()
    yield


def test_dual_write_retry_success():
    s = WorkbenchSession(
        id='gap_retry_ok',
        title='t',
        messages=[{'role': 'user', 'content': 'gap-retry-marker'}],
        messageCount=1,
        createdAt='t',
        startedAt='t',
        updatedAt='t',
    )
    assert sync_workbench_session_to_brain(s) is True
    stats = get_sync_stats()
    assert stats.get('last_error') is None
    assert memory_store.count_messages('gap_retry_ok') == 1
    memory_store.delete_session_messages('gap_retry_ok')
    memory_store.delete_session_record('gap_retry_ok')


def test_dual_write_strict_raises(monkeypatch):
    s = WorkbenchSession(
        id='gap_strict',
        title='t',
        messages=[{'role': 'user', 'content': 'x'}],
        messageCount=1,
        createdAt='t',
        startedAt='t',
        updatedAt='t',
    )

    def boom(*_a, **_k):
        raise RuntimeError('forced brain failure')

    monkeypatch.setattr('app.services.memory_store.save_session', boom)
    with pytest.raises(RuntimeError, match='forced'):
        sync_workbench_session_to_brain(s, retries=2, strict=True)
    stats = get_sync_stats()
    assert stats.get('failure_count', 0) >= 1
    assert s.metadata.get('brainSyncOk') is False


def test_backfill_from_json(tmp_path: Path):
    payload = [
        {
            'id': 'wb_backfill_a',
            'title': 'Backfill A',
            'provider': 'test',
            'model': 'm',
            'messages': [{'role': 'user', 'content': 'backfill-content-AAA'}],
            'messageCount': 1,
            'createdAt': '2026-01-01T00:00:00Z',
            'updatedAt': '2026-01-01T00:00:00Z',
            'startedAt': '2026-01-01T00:00:00Z',
        },
        {
            'id': 'wb_backfill_b',
            'title': 'Backfill B',
            'messages': [{'role': 'user', 'content': 'backfill-content-BBB'}],
            'messageCount': 1,
            'createdAt': '2026-01-01T00:00:00Z',
            'updatedAt': '2026-01-01T00:00:00Z',
            'startedAt': '2026-01-01T00:00:00Z',
        },
    ]
    p = tmp_path / 'workbench-sessions.json'
    p.write_text(json.dumps(payload), encoding='utf-8')
    result = backfill_workbench_json_to_brain(sessions_path=p)
    assert result['found'] == 2
    assert result['synced'] == 2
    assert result['failed'] == 0
    assert memory_store.get_session('wb_backfill_a') is not None
    msgs = memory_store.get_messages('wb_backfill_a')
    assert any('AAA' in str(m.get('content', '')) for m in msgs)
    memory_store.delete_session_messages('wb_backfill_a')
    memory_store.delete_session_messages('wb_backfill_b')
    memory_store.delete_session_record('wb_backfill_a')
    memory_store.delete_session_record('wb_backfill_b')


@pytest.mark.asyncio
async def test_cognitive_boot_start_stop():
    from app.services.cognitive_boot import get_boot_status, start_cognitive_services, stop_cognitive_services

    # Force lightweight boot (skip long consolidation wait by default interval).
    status = await start_cognitive_services(None)
    assert status.get('started') is True
    services = status.get('services') or {}
    assert 'backfill_workbench' in services
    assert 'db_writer' in services
    await stop_cognitive_services()
    after = get_boot_status()
    assert after.get('started') is False
