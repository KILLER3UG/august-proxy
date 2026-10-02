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
import re

_APP = pathlib.Path(__file__).resolve().parents[1] / 'app'

# Modules that legitimately commit outside the funnel, each with a reason. This
# is an ALLOWLIST, so adding an entry here is a conscious decision rather than a
# silent hole — and every entry is asserted to still be justified below.
_EXEMPT = {
    # Owns DDL. A migration runs inside its own transaction and the runner
    # manages commits itself; routing them through the WAL counter would count
    # schema work as ordinary writes.
    'services/memory_schema.py': 'owns DDL for the brain schema',
    # Already routes through memory_conn.commit — that IS the funnel.
    'services/deferred_writes.py': 'is itself the deferred funnel',
}

# A brain-DB writer is anything that reaches the brain connection. Matching on
# the connection accessor is what caught the routers and services the first
# six-file allowlist missed.
_BRAIN_CONN = re.compile(
    r'_conn\(\)|from app\.services\.memory_conn import|memory_store import _conn'
)

def _calls(tree: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call)]


def _brain_writers() -> list[pathlib.Path]:
    """Every module that commits to the brain DB, minus the exempt ones."""
    out: list[pathlib.Path] = []
    for p in sorted(_APP.rglob('*.py')):
        rel = p.relative_to(_APP).as_posix()
        if rel in _EXEMPT or rel.endswith('memory_conn.py'):
            continue
        src = p.read_text('utf-8')
        if '.commit()' not in src or not _BRAIN_CONN.search(src):
            continue
        out.append(p)
    return out


class TestNoDirectCommitsRemain:
    def test_the_brain_writer_set_is_discovered_not_hardcoded(self):
        """The first version of this guard listed six files by hand, and 27
        more brain-DB writers (routers, harness services, the episode miner)
        sat outside it while the docstring claimed full coverage. Discovery
        means a new writer is found the day it is written."""
        writers = _brain_writers()
        assert writers, 'discovery found no brain writers at all — the matcher is broken'
        for p in writers:
            rel = p.relative_to(_APP).as_posix()
            src = p.read_text('utf-8')
            tree = ast.parse(src)
            offenders = [
                node.func.value.id
                for node in _calls(tree)
                if isinstance(node.func, ast.Attribute)
                and node.func.attr == 'commit'
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in ('conn', 'c')
            ]
            assert not offenders, (
                f'{rel} calls {offenders}.commit() directly; route it through '
                'memory_conn.commit (imported as brain_commit) or the WAL '
                'checkpoint stops counting these writes'
            )

    def test_the_exempt_modules_are_still_justified(self):
        """An exemption with no reason is a hole with paperwork."""
        for rel, reason in _EXEMPT.items():
            assert reason, f'{rel} is exempt from the commit funnel with no stated reason'
            assert (_APP / rel).exists(), f'{rel} is exempt but no longer exists'


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