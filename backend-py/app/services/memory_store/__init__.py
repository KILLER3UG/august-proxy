"""Brain SQLite memory store — domain package facade.

Public API is re-exported so existing imports keep working:

  from app.services.memory_store import get_messages
  from app.services import memory_store

Domains: wire, kv, messages, sessions, brain, rest.
Connection helpers: app.services.memory_conn
"""
from __future__ import annotations

from app.services.memory_conn import close, conn as _conn, db_path as _db_path
from app.services.memory_store.brain import brain_query
from app.services.memory_store.kv import (
    _fts_match_query,
    delete_memory,
    get_memory,
    init,
    list_memory,
    save_memory,
    search_memory,
)
from app.services.memory_store.messages import (
    count_messages,
    delete_session_messages,
    get_messages,
    get_messages_async,
    save_message,
)
from app.services.memory_store.rest import (
    decide_proposal,
    delete_fact,
    get_fact,
    get_proposal,
    get_session_topic,
    get_stats,
    get_usage,
    index_session_topic,
    list_config_audit,
    list_facts,
    list_lifecycle,
    list_proposals,
    list_topics,
    record_config_audit,
    record_lifecycle,
    list_usage,
    record_usage,
    resolve_sot_session_id,
    save_fact,
    save_proposal,
    search_facts,
    search_sessions_by_topic,
    timeline_sweep,
    vacuum,
    write_timeline_event,
)
from app.services.memory_store.sessions import (
    delete_session_cascade,
    delete_session_record,
    get_session,
    list_sessions,
    list_workbench_blobs,
    save_session,
    save_workbench_session_sot,
)
from app.services.memory_store.wire import _row_as_wire, _session_field

__all__ = [
    'close',
    'init',
    'save_memory',
    'get_memory',
    'delete_memory',
    'list_memory',
    'search_memory',
    'save_fact',
    'get_fact',
    'search_facts',
    'list_facts',
    'delete_fact',
    'save_proposal',
    'get_proposal',
    'list_proposals',
    'decide_proposal',
    'record_lifecycle',
    'list_lifecycle',
    'record_config_audit',
    'list_config_audit',
    'index_session_topic',
    'get_session_topic',
    'list_topics',
    'search_sessions_by_topic',
    'save_session',
    'save_workbench_session_sot',
    'list_workbench_blobs',
    'list_sessions',
    'get_session',
    'delete_session_cascade',
    'delete_session_record',
    'save_message',
    'get_messages',
    'count_messages',
    'get_messages_async',
    'delete_session_messages',
    'record_usage',
    'resolve_sot_session_id',
    'list_usage',
    'get_usage',
    'vacuum',
    'get_stats',
    'brain_query',
    'write_timeline_event',
    'timeline_sweep',
    '_conn',
    '_db_path',
    '_row_as_wire',
    '_session_field',
    '_fts_match_query',
]
