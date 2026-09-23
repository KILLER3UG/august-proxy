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
