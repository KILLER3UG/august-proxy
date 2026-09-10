"""Cognitive boot start/stop smoke test.

The dual-write retry/strict and JSON backfill tests lived here until the
memory-system cleanup (plan §2.2) removed ``sync_workbench_session_to_brain``
and ``backfill_workbench_json_to_brain``; session persistence is covered by
``test_brain_dual_write.py`` / ``test_session_json_delete_sot.py`` instead.
"""

from __future__ import annotations

import pytest
from app.services import memory_store


@pytest.fixture(autouse=True)
def _init():
    memory_store.init()
    yield


@pytest.mark.asyncio
async def test_cognitive_boot_start_stop():
    from app.services.cognitive_boot import get_boot_status, start_cognitive_services, stop_cognitive_services

    # Force lightweight boot (skip long consolidation wait by default interval).
    status = await start_cognitive_services(None)
    assert status.get('started') is True
    services = status.get('services') or {}
    assert 'cron_scheduler' in services
    assert 'daemon_manager' in services
    # M4 consolidation v2 became one job of the P2 unified scheduler — the
    # tracked boot service is 'learning_scheduler' now (f66d6ec1 renamed it
    # without updating this assertion; caught by the 2026-09-11 full run).
    assert 'learning_scheduler' in services
    assert 'consolidation' not in services
    await stop_cognitive_services()
    after = get_boot_status()
    assert after.get('started') is False
