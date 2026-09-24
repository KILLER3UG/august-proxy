"""Facts must not be written into a scope retrieval can never read back.

`session_scope.resolve_scope()` returns 'global' or 'bot:<id>' only, and the
recall filter unions global ∪ that resolved value. `save_fact` nonetheless
documented 'project:<path>' as a legal home, so such a row was stored, reported
as saved, and was invisible forever. The write door now refuses it.
"""

from __future__ import annotations

import pytest
from app.services.memory_store import delete_fact, get_fact, save_fact
from app.services.session_scope import GLOBAL_SCOPE, normalize_scope, resolve_scope


def test_resolve_scope_can_never_produce_a_project_scope() -> None:
    """The premise of the guard: nothing reads project: back, ever."""
    assert resolve_scope(session=None, session_id='') == GLOBAL_SCOPE
    assert not normalize_scope('project:C:/Dev/x').startswith('bot:')


def test_project_scope_write_is_refused_clearly() -> None:
    with pytest.raises(ValueError) as exc:
        save_fact('proj-key', 'value', scope='project:C:/Dev/august-proxy')
    message = str(exc.value)
    assert 'project' in message
    # The error must name the way out, or a caller just retries blindly.
    assert 'unreadable' in message or '.aug/memory' in message


def test_global_and_bot_scopes_still_write(isolatedData) -> None:
    save_fact('global-key', 'shared', scope='global')
    save_fact('bot-key', 'private', scope='bot:alpha')
    assert get_fact('global-key')['scope'] == 'global'
    assert get_fact('bot-key')['scope'] == 'bot:alpha'


def test_unspecified_scope_defaults_to_readable_global(isolatedData) -> None:
    save_fact('plain-key', 'value')
    assert get_fact('plain-key')['scope'] == GLOBAL_SCOPE


def test_rejected_write_leaves_no_orphan_row(isolatedData) -> None:
    with pytest.raises(ValueError):
        save_fact('never-read', 'value', scope='project:/tmp/elsewhere')
    assert get_fact('never-read') is None
    delete_fact('never-read')


# ── bot-scoped writes may not clobber a global fact ──────────────────────────
#
# The UPSERT never rewrites ``scope``, so a ``bot:<id>`` write against a global
# row used to replace the shared value while the row stayed ``global`` — the
# bot's private note silently became every session's global fact. A key has
# exactly one home: a write is accepted only from the row's own scope.


def test_bot_scoped_write_cannot_overwrite_a_global_fact(isolatedData) -> None:
    save_fact('shared', {'fact': 'global value'}, scope='global')
    with pytest.raises(ValueError) as exc:
        save_fact('shared', {'fact': 'bot value'}, scope='bot:alpha')
    assert 'global fact' in str(exc.value)
    row = get_fact('shared')
    assert 'global value' in str(row['factValue'])
    assert row['scope'] == 'global'


def test_global_write_still_updates_a_global_fact(isolatedData) -> None:
    save_fact('g-upd', {'fact': 'v1'}, scope='global')
    save_fact('g-upd', {'fact': 'v2'}, scope='global')
    assert 'v2' in str(get_fact('g-upd')['factValue'])


def test_bot_scoped_write_still_updates_its_own_fact(isolatedData) -> None:
    save_fact('own', {'fact': 'v1'}, scope='bot:alpha')
    save_fact('own', {'fact': 'v2'}, scope='bot:alpha')
    row = get_fact('own')
    assert 'v2' in str(row['factValue'])
    assert row['scope'] == 'bot:alpha'


def test_explicit_override_still_allows_cross_scope_global_write(isolatedData) -> None:
    """Consolidation / rollback restore opt in explicitly and keep working."""
    save_fact('moved', {'fact': 'v1'}, scope='bot:alpha')
    save_fact('moved', {'fact': 'v2'}, scope='global', allow_scope_override=True)
    row = get_fact('moved')
    assert 'v2' in str(row['factValue'])
    # scope is never rewritten by an update
    assert row['scope'] == 'bot:alpha'
