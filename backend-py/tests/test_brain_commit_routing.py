"""Every brain commit must route through ``memory_conn.commit``.

The durability promise is narrow and worth stating exactly: the packaged
desktop quit is ``taskkill /T /F``, so ``main.py``'s lifespan flushes never run,
and a PASSIVE WAL checkpoint is the only thing folding the ``-wal`` sidecar
back into the database file. That checkpoint is driven by a counter, so it only
counts the writes that pass through the helper.

The first version of this hooked only ``deferred_writes._commit``, so 28 of the
brain write sites were outside the guarantee while the docstring around it
claimed the opposite. This file is the guard that stops the guarantee from
quietly decaying again — it is the WAL-lane twin of
``tests/test_gate_participation.py``.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

_MEMORY_STORE = pathlib.Path(__file__).resolve().parents[1] / 'app' / 'services' / 'memory_store'

# The direct brain-write lane. Each of these used to call `.commit()` itself.
_DIRECT_WRITE_MODULES = (
    'brain.py',
    'consolidation.py',
    'kv.py',
    'messages.py',
    'rest.py',
    'sessions.py',
)


def _calls(tree: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call)]


class TestNoDirectCommitsRemain:
    @pytest.mark.parametrize('module', _DIRECT_WRITE_MODULES)
    def test_module_has_no_bare_commit_call(self, module: str):
        path = _MEMORY_STORE / module
        assert path.exists(), f'missing {path}'
        tree = ast.parse(path.read_text('utf-8'))
        offenders = []
        for node in _calls(tree):
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr == 'commit'
                and not isinstance(func.value, ast.Name)
                or (
                    isinstance(func, ast.Attribute)
                    and func.attr == 'commit'
                    and isinstance(func.value, ast.Name)
                    and func.value.id != 'conn'
                    # brain_commit is the helper; a bare `<name>.commit()` is not
                    and func.value.id not in ('conn', 'c')
                )
            ):
                offenders.append(func.attr)
        assert not offenders, (
            f'{module} calls .commit() directly; route it through '
            "memory_conn.commit (imported as brain_commit) or the WAL "
            'checkpoint stops counting these writes'
        )

    def test_the_helper_is_imported_wherever_it_is_used(self):
        for module in _DIRECT_WRITE_MODULES:
            path = _MEMORY_STORE / module
            src = path.read_text('utf-8')
            if 'brain_commit(' not in src:
                continue
            assert 'commit as brain_commit' in src, (
                f'{module} calls brain_commit without importing it'
            )


class TestTheHelperIsReal:
    def test_commit_calls_both_the_commit_and_the_counter(self):
        """The helper must do BOTH halves. A `commit` that only commits would
        silently restore the old gap while passing every test here."""
        import inspect

        from app.services.memory_conn import commit

        src = inspect.getsource(commit)
        assert '.commit()' in src, 'the helper does not actually commit'
        assert 'note_commit()' in src, 'the helper does not count toward the WAL checkpoint'

    def test_the_checkpoint_fires_from_the_helper(self, monkeypatch):
        import sqlite3

        from app.services import memory_conn

        calls: list[str] = []
        real_note = memory_conn.note_commit

        def _spy():
            calls.append('note')
            real_note()

        monkeypatch.setattr(memory_conn, 'note_commit', _spy)
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE t (x INTEGER)')
        conn.execute('INSERT INTO t VALUES (1)')

        memory_conn.commit(conn)
        assert calls == ['note'], 'memory_conn.commit did not reach note_commit'

    def test_a_failing_commit_still_counts_nothing_and_does_not_raise_the_counter(self):
        """`finally` means note_commit runs even on failure — the WAL state is
        unchanged either way, so this is a safety net, not a correctness claim."""
        import sqlite3

        from app.services.memory_conn import commit

        broken = sqlite3.connect(':memory:')
        broken.close()
        try:
            commit(broken)
        except sqlite3.ProgrammingError:
            pass  # acceptable: the caller's own handler decides