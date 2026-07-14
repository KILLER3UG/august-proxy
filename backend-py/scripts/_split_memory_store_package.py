"""One-shot: convert memory_store.py into domain package under memory_store/."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'app' / 'services'
src = root / 'memory_store.py'
if not src.exists():
    # Already a package?
    if (root / 'memory_store' / '__init__.py').exists():
        print('package already exists')
        raise SystemExit(0)
    raise SystemExit(f'missing {src}')

text = src.read_text(encoding='utf-8')
lines = text.splitlines(keepends=True)

starts: list[int] = []
for i, line in enumerate(lines):
    if re.match(r'^(async )?def ', line):
        starts.append(i)
starts.append(len(lines))


def slice_funcs(names: set[str]) -> str:
    chunks: list[str] = []
    for i, s in enumerate(starts[:-1]):
        m = re.match(r'^(?:async )?def (\w+)', lines[s])
        assert m
        if m.group(1) in names:
            chunks.append(''.join(lines[s : starts[i + 1]]))
    return ''.join(chunks)


header_end = next(i for i, line in enumerate(lines) if line.startswith('def _q'))
brain_store_start = next(i for i, line in enumerate(lines) if line.startswith('_BRAINStores'))
brain_store_end = next(
    i
    for i in range(brain_store_start + 1, len(lines))
    if re.match(r'^(async )?def ', lines[i])
)

wire_names = {'_q', '_json', '_row_as_wire', '_session_field'}
kv_names = {
    'init',
    'save_memory',
    'get_memory',
    'delete_memory',
    'list_memory',
    '_fts_match_query',
    'search_memory',
}
msg_names = {
    'save_message',
    'get_messages',
    'count_messages',
    'get_messages_async',
    'delete_session_messages',
}
sess_names = {'save_session', 'list_sessions', 'get_session', 'delete_session_record'}
brain_defs = {'_brain_query_graph', '_brain_query_daemons', 'brain_query'}
skip = wire_names | kv_names | msg_names | sess_names | brain_defs

pkg = root / 'memory_store'
if pkg.exists():
    shutil.rmtree(pkg)
pkg.mkdir()

(pkg / 'wire.py').write_text(
    '"""Row/wire helpers for the brain SQLite store."""\n'
    'from __future__ import annotations\n'
    'import json\n'
    'import sqlite3\n'
    'from typing import cast\n'
    'from app.adapters.case_converters import snakeToCamel\n'
    'from app.type_aliases import JsonValue, SessionRecord\n\n'
    + slice_funcs(wire_names),
    encoding='utf-8',
)

(pkg / 'kv.py').write_text(
    '"""Key-value memory blob + FTS search domain."""\n'
    'from __future__ import annotations\n'
    'import json\n'
    'import sqlite3\n'
    'from typing import cast\n'
    'from app.services.memory_conn import conn as _conn\n'
    'from app.services.memory_schema import ensure_schema\n'
    'from app.services.memory_store.wire import _json, _row_as_wire\n'
    'from app.type_aliases import JsonValue, MemoryEntryDict\n\n'
    + slice_funcs(kv_names),
    encoding='utf-8',
)

(pkg / 'messages.py').write_text(
    '"""Session messages domain (hot path for chat open / pagination)."""\n'
    'from __future__ import annotations\n'
    'import asyncio\n'
    'import json\n'
    'from typing import cast\n'
    'from app.services.memory_conn import conn as _conn\n'
    'from app.services.memory_store.wire import _json, _row_as_wire\n'
    'from app.type_aliases import JsonValue, MessageDict\n\n'
    + slice_funcs(msg_names),
    encoding='utf-8',
)

(pkg / 'sessions.py').write_text(
    '"""Sessions table domain."""\n'
    'from __future__ import annotations\n'
    'from typing import cast\n'
    'from app.services.memory_conn import conn as _conn\n'
    'from app.services.memory_store.wire import _json, _row_as_wire, _session_field\n'
    'from app.type_aliases import SessionRecord\n\n'
    + slice_funcs(sess_names),
    encoding='utf-8',
)

brain_block = ''.join(lines[brain_store_start:brain_store_end])
(pkg / 'brain.py').write_text(
    '"""brain_query tool domain (multi-store FTS/SQL)."""\n'
    'from __future__ import annotations\n'
    'import json\n'
    'from app.adapters.case_converters import camelToSnake\n'
    'from app.json_narrowing import as_str, as_list\n'
    'from app.services.memory_conn import conn as _conn\n'
    'from app.services.memory_store.kv import _fts_match_query\n'
    'from app.services.memory_store.wire import _row_as_wire\n\n'
    + brain_block
    + slice_funcs(brain_defs),
    encoding='utf-8',
)

rest_chunks: list[str] = []
for i, s in enumerate(starts[:-1]):
    name = re.match(r'^(?:async )?def (\w+)', lines[s]).group(1)
    if name in skip:
        continue
    if brain_store_start <= s < brain_store_end:
        continue
    rest_chunks.append(''.join(lines[s : starts[i + 1]]))

(pkg / 'rest.py').write_text(
    '"""Facts, proposals, lifecycle, topics, usage, timeline, stats."""\n'
    'from __future__ import annotations\n'
    'import asyncio\n'
    'import json\n'
    'from typing import cast\n'
    'from app.json_narrowing import as_int\n'
    'from app.services.memory_conn import conn as _conn, db_path as _db_path\n'
    'from app.services.memory_store.wire import _json, _row_as_wire\n'
    'from app.type_aliases import FactDict, JsonValue, ProposalDict\n\n'
    + ''.join(rest_chunks),
    encoding='utf-8',
)

(pkg / '__init__.py').write_text(
    '''"""Brain SQLite memory store — domain package facade.

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
    record_usage,
    save_fact,
    save_proposal,
    search_facts,
    search_sessions_by_topic,
    timeline_sweep,
    vacuum,
    write_timeline_event,
)
from app.services.memory_store.sessions import (
    delete_session_record,
    get_session,
    list_sessions,
    save_session,
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
    'list_sessions',
    'get_session',
    'delete_session_record',
    'save_message',
    'get_messages',
    'count_messages',
    'get_messages_async',
    'delete_session_messages',
    'record_usage',
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
''',
    encoding='utf-8',
)

src.unlink()
print('OK package', pkg)
print('files', sorted(p.name for p in pkg.iterdir()))
