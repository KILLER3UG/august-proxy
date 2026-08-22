"""EventLog fan-out tests."""

import asyncio

import pytest
from app.services.event_log import EventLog


@pytest.mark.asyncio
async def testSubscribeReplaysPastThenDeliversLive():
    """Baseline: subscribe(since_seq=0) replays buffered events and then
    receives live appends in order."""
    log = EventLog()
    log.append('s1', 'msg', {'n': 1})
    log.append('s1', 'msg', {'n': 2})
    gen = log.subscribe('s1', sinceSeq=0)
    assert (await gen.__anext__())['payload'] == {'n': 1}
    assert (await gen.__anext__())['payload'] == {'n': 2}
    log.append('s1', 'msg', {'n': 3})
    assert (await gen.__anext__())['payload'] == {'n': 3}
    await gen.aclose()


@pytest.mark.asyncio
async def testSubscribeDeliversEventsAppendedDuringReplay():
    """Regression: a subscriber must not miss events appended while it is
    suspended mid-replay. Previously subscribe() materialised a snapshot of
    past events and yielded them, registering its queue only AFTER the
    replay loop. Any event appended during a yield-suspension landed in
    entry.events but was absent from both the already-materialised snapshot
    and the not-yet-registered queue — silently dropped. In the workbench
    this drops a tool result or terminal 'done' on SSE reconnect, leaving
    the UI stuck (e.g. a tool stuck 'running')."""
    log = EventLog()
    log.append('s1', 'msg', {'n': 1})
    gen = log.subscribe('s1', sinceSeq=0)
    first = await gen.__anext__()
    assert first['seq'] == 1
    log.append('s1', 'msg', {'n': 2})
    nxt = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert nxt['seq'] == 2, 'event appended during replay must be delivered'
    await gen.aclose()


def testAppendPersistsAsynchronouslyAndFlushDrains(tmp_path, monkeypatch):
    """Round-5 hot-path fix: persistence runs on a writer thread; flush()
    drains the backlog so restart-replay stays correct without the SSE loop
    ever paying a synchronous disk write."""
    import json

    from app.services import event_log as el

    monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)
    log = el.EventLog()
    for i in range(1, 51):
        log.append('flush-s', 'msg', {'n': i})
    assert log.flush() is True
    lines = el._log_path('flush-s').read_text(encoding='utf-8').strip().splitlines()
    assert len(lines) == 50
    seqs = [json.loads(ln)['seq'] for ln in lines]
    assert seqs == list(range(1, 51)), 'writer thread must preserve append order'


def testSyncModeEscapeHatch(tmp_path, monkeypatch):
    """AUGUST_EVENT_LOG_SYNC=1 restores inline persistence (debug escape hatch)."""
    from app.services import event_log as el

    monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)
    monkeypatch.setenv('AUGUST_EVENT_LOG_SYNC', '1')
    log = el.EventLog()
    log.append('sync-s', 'msg', {'n': 1})
    # No flush call — the line must already be on disk.
    assert 'sync-s' in str(el._log_path('sync-s'))
    assert el._log_path('sync-s').exists()
