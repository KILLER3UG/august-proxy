"""Durable session archive.

`is_archived` existed in the sessions table (with an index) but nothing read it
back and both write paths reset it: `save_session` passed `_session_field(...) or
None` straight into `1 if ... else 0`, and `save_workbench_session_sot` — the
path every autosave takes — wrote `1 if session_dict.get('isArchived') else 0`
while the workbench session object has no such key. Archiving therefore could
not survive, and the UI kept the flag in localStorage instead. The route now
owns it.
"""

from __future__ import annotations

from app.services import memory_store
from fastapi.testclient import TestClient


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _seed(sid: str = 'sess_arch') -> str:
    memory_store.save_session(
        {
            'id': sid,
            'title': 'Archive me',
            'startedAt': '2026-09-22T00:00:00Z',
            'messageCount': 0,
            'provider': 'p',
            'model': 'm',
        }
    )
    return sid


def test_archive_and_restore_round_trip_through_the_route(isolatedData):
    client = _client()
    sid = _seed()

    resp = client.post('/api/august/sessions/manage', json={'action': 'archive', 'id': sid})
    assert resp.status_code == 200, resp.text
    # SQLite hands back 1/0 and the wire dict is not re-encoded, so both this
    # route and GET /api/sessions/{id} report the flag the same way.
    assert resp.json()['isArchived'] in (1, True)
    assert memory_store.get_session(sid)['isArchived'] in (1, True)

    assert client.post(
        '/api/august/sessions/manage', json={'action': 'restore', 'id': sid}
    ).status_code == 200
    assert not memory_store.get_session(sid)['isArchived']


def test_metadata_only_save_does_not_un_archive(isolatedData):
    """The bug: a later write that never mentioned the flag reset it to 0."""
    sid = _seed()
    archived = dict(memory_store.get_session(sid))
    archived['isArchived'] = True
    memory_store.save_session(archived)

    memory_store.save_session({'id': sid, 'title': 'Renamed later', 'startedAt': 'x'})

    session = memory_store.get_session(sid)
    assert session['title'] == 'Renamed later'
    assert session['isArchived'] in (1, True), 'a rename silently un-archived the session'


def test_workbench_autosave_preserves_the_archive_flag(isolatedData):
    sid = _seed()
    archived = dict(memory_store.get_session(sid))
    archived['isArchived'] = True
    memory_store.save_session(archived)

    # The hot path: a workbench session dict, which carries no archive field.
    memory_store.save_workbench_session_sot(
        {'id': sid, 'title': 'Workbench title', 'messages': []}, []
    )

    assert memory_store.get_session(sid)['isArchived'] in (1, True)


def test_explicit_un_archive_still_works(isolatedData):
    sid = _seed()
    archived = dict(memory_store.get_session(sid))
    archived['isArchived'] = True
    memory_store.save_session(archived)

    restored = dict(archived)
    restored['isArchived'] = False
    memory_store.save_session(restored)

    assert not memory_store.get_session(sid)['isArchived']


def test_sot_save_can_still_set_the_flag_directly(isolatedData):
    sid = _seed()
    memory_store.save_workbench_session_sot(
        {'id': sid, 'title': 'T', 'messages': [], 'isArchived': True}, []
    )
    assert memory_store.get_session(sid)['isArchived'] in (1, True)


def test_unknown_or_missing_id_is_refused(isolatedData):
    client = _client()
    assert client.post(
        '/api/august/sessions/manage', json={'action': 'archive', 'id': 'sess_nope'}
    ).status_code == 404
    assert client.post('/api/august/sessions/manage', json={'action': 'archive'}).status_code == 400
    # The list shape is unchanged, and 'update' is still honestly refused.
    assert client.post(
        '/api/august/sessions/manage', json={'action': 'update', 'id': 'x'}
    ).status_code == 400


def test_patch_route_round_trips_the_flag(isolatedData):
    client = _client()
    sid = _seed()

    resp = client.patch(f'/api/sessions/{sid}', json={'isArchived': True})
    assert resp.status_code == 200, resp.text
    assert resp.json()['isArchived'] in (1, True)

    assert client.patch(f'/api/sessions/{sid}', json={'isArchived': False}).status_code == 200
    assert not memory_store.get_session(sid)['isArchived']


def test_patch_route_refuses_unknown_id_and_empty_body(isolatedData):
    client = _client()
    sid = _seed()
    assert client.patch('/api/sessions/sess_nope', json={'isArchived': True}).status_code == 404
    # An absent field means "unchanged", so a body with nothing to do is a
    # mistake worth reporting rather than a silent no-op.
    assert client.patch(f'/api/sessions/{sid}', json={}).status_code == 400


def test_flags_query_returns_only_archived_rows(isolatedData):
    sid = _seed('sess_flagged')
    other = _seed('sess_plain')
    memory_store.set_session_archived(sid, True)

    flags = memory_store.session_archive_flags()

    assert flags.get(sid) is True
    # Absent means "not archived", so the client never has to distinguish a
    # false from a missing field.
    assert other not in flags


def test_workbench_session_list_carries_the_archive_flag(isolatedData):
    """The sidebar reconciles from `GET /api/workbench/sessions`, not
    `/api/sessions`. If the flag cannot reach the client through THAT list, the
    durable write is invisible after a localStorage wipe — archived chats come
    back, which is the whole feature."""
    from app.services.workbench import workbench as wb

    sid = 'wb_archived_list'
    memory_store.save_workbench_session_sot({'id': sid, 'title': 'T', 'messages': []}, [])
    memory_store.set_session_archived(sid, True)

    listed = {s['id']: s for s in wb.listWorkbenchSessions()}

    assert sid in listed
    assert listed[sid].get('isArchived') is True

    memory_store.set_session_archived(sid, False)
    relisted = {s['id']: s for s in wb.listWorkbenchSessions()}
    assert not relisted[sid].get('isArchived')


def test_both_surfaces_write_the_same_column(isolatedData):
    """Legacy action route and REST PATCH must not become two authorities."""
    client = _client()
    sid = _seed()

    client.post('/api/august/sessions/manage', json={'action': 'archive', 'id': sid})
    assert client.get(f'/api/sessions/{sid}').json()['isArchived'] in (1, True)

    client.patch(f'/api/sessions/{sid}', json={'isArchived': False})
    assert not client.get(f'/api/sessions/{sid}').json()['isArchived']
