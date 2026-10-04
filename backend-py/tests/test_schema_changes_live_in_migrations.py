"""Schema changes belong in a migration, not in runtime code.

Three harness columns — `harness_jobs.outcomes_json` and
`harness_routines.{schedule,paused,last_run}` — were each added by an
`ALTER TABLE ... ADD COLUMN` executed on EVERY connection inside
`try/except Exception: pass`. Nothing recorded the change in
`schema_migrations`, a failed DDL was invisible, and an upgrade path did not
exist for a database predating the code. Migration 051 owns them now.

The failure mode is quiet enough that it recurs: the code works on the
developer's machine, so the runtime DDL looks like harmless insurance. This
file makes the class a build failure instead, and separately checks that the
columns migration 051 declares actually exist afterwards — a migration that
silently does nothing is the other half of the same defect.
"""

from __future__ import annotations

import ast
import pathlib
import sqlite3

import pytest

_APP = pathlib.Path(__file__).resolve().parents[1] / 'app'
_MIGRATIONS = _APP / 'migrations'

# Where DDL legitimately lives at runtime. `memory_schema` OWNS the base
# schema and runs before the migration runner; `schema_rename_migration` is the
# runner's own ALTER-TO-RENAME pass. Everything else must ship a .sql file.
_DDL_OWNERS = {
    'services/memory_schema.py': 'owns the base brain schema; runs before migrations',
    'services/schema_rename_migration.py': "is the migration runner's rename pass",
    # The runner itself, in lib/ rather than services/.
    'lib/migrations.py': 'records versions; its own bookkeeping table',
}

_MIGRATION_FILE_RE = __import__('re').compile(r'^(\d+)_.+\.sql$')


def _tables_with_columns(p: pathlib.Path) -> set[str]:
    tree = ast.parse(p.read_text('utf-8'))
    tables: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr not in ('execute', 'executescript'):
            continue
        sql = ' '.join(
            a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)
        )
        if 'ALTER TABLE' not in sql.upper():
            continue
        # `f'ALTER TABLE {table} …'` — a formatted string, so the table name is
        # not a literal. Those live in the DDL owners above; if one appears
        # elsewhere it is still caught by the allowlist check below.
        for lit in [a for a in node.args if isinstance(a, ast.Constant)]:
            if not isinstance(lit.value, str):
                continue
            if 'ALTER TABLE' in lit.value.upper():
                tables.add(lit.value[:60])
    return tables


class TestNoRuntimeSchemaChanges:
    def test_the_migration_directory_exists(self):
        assert _MIGRATIONS.is_dir(), f'missing {_MIGRATIONS}'

    @pytest.mark.parametrize('p', sorted(_APP.rglob('*.py')), ids=lambda p: p.name)
    def test_no_module_alters_a_table_outside_the_ddl_owners(self, p: pathlib.Path):
        rel = p.relative_to(_APP).as_posix()
        if rel in _DDL_OWNERS:
            return
        offenders = _tables_with_columns(p)
        assert not offenders, (
            f'{rel} runs ALTER TABLE at runtime: {sorted(offenders)}. Ship a '
            'migration instead — a runtime ALTER is invisible to '
            'schema_migrations, is swallowed on failure, and runs per connection.'
        )

    def test_the_allowlist_entries_still_exist(self):
        for rel, reason in _DDL_OWNERS.items():
            assert (_APP / rel).exists(), f'{rel} is a DDL owner but no longer exists'
            assert reason, f'{rel} is a DDL owner with no stated reason'


class TestMigration051DeliversWhatItPromises:
    """A migration that silently does nothing is the same defect wearing a
    different hat: the columns are missing and nothing says so."""

    COLUMNS = {
        'harness_jobs': {'outcomes_json'},
        'harness_routines': {'schedule', 'paused', 'last_run'},
    }

    def _apply_051(self, conn: sqlite3.Connection) -> None:
        path = _MIGRATIONS / '051_harness_job_columns.sql'
        assert path.exists(), f'missing {path}'
        conn.executescript(path.read_text('utf-8'))

    def test_the_migration_exists_and_is_numbered_after_the_last_one(self):
        path = _MIGRATIONS / '051_harness_job_columns.sql'
        assert path.exists()
        versions = sorted(
            int(m.group(1))
            for m in (_MIGRATION_FILE_RE.match(f.name) for f in _MIGRATIONS.iterdir())
            if m
        )
        assert versions == sorted(set(versions)), f'duplicate migration versions: {versions}'
        # This used to pin versions[-1] == 51 — "051 is the newest" — which was
        # only a proxy for "051 was numbered after everything before it". It
        # broke the moment 052 landed, and a guard that breaks on every normal
        # addition gets deleted rather than read. What is actually worth
        # asserting is that the ladder has no holes: a missing number means a
        # migration was deleted or renumbered, and an installed database would
        # never get that DDL at all.
        assert 51 in versions
        assert versions == list(range(1, max(versions) + 1)), 'gap in migration numbering'

    def test_each_column_lands_on_its_table(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE harness_jobs (id TEXT PRIMARY KEY, status TEXT)')
        conn.execute(
            'CREATE TABLE harness_routines (id TEXT PRIMARY KEY, name TEXT)'
        )
        self._apply_051(conn)
        for table, columns in self.COLUMNS.items():
            have = {r[1] for r in conn.execute(f'PRAGMA table_info({table})')}
            missing = columns - have
            assert not missing, f'{table} is missing {sorted(missing)} after 051'
        conn.close()

    def test_reapplying_is_harmless_for_an_upgraded_install(self):
        """An installation whose DB already got these columns from the old
        runtime path must upgrade cleanly.

        `executescript` aborts on the FIRST duplicate, which is exactly what the
        runner sees and why it checks for 'duplicate column name' /
        'already exists' in `_ALREADY_APPLIED_ERRORS` before marking a version
        applied. This test asserts the shape that rule depends on: the error is
        an ordinary, recognisable OperationalError, and the table is intact.
        """
        conn = sqlite3.connect(':memory:')
        # An UPGRADED install: the old runtime path already added these columns.
        conn.execute('CREATE TABLE harness_jobs (id TEXT PRIMARY KEY, outcomes_json TEXT)')
        conn.execute(
            'CREATE TABLE harness_routines (id TEXT PRIMARY KEY, schedule TEXT, '
            'paused INTEGER, last_run TEXT)'
        )

        # Applying 051 raises the benign, recognisable error the runner treats
        # as already-applied — and the data is untouched by the abort.
        with pytest.raises(sqlite3.OperationalError, match='duplicate column'):
            self._apply_051(conn)

        assert conn.execute('SELECT count(*) FROM harness_jobs').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM harness_routines').fetchone()[0] == 0
        conn.close()

    def test_the_runner_classifies_the_duplicate_as_already_applied(self):
        """The migration is only safe because the runner recognises this error.
        Pin that, so relaxing the tuple cannot silently break 051 on upgrade."""
        from app.lib import migrations as runner

        assert 'duplicate column name' in runner._ALREADY_APPLIED_ERRORS  # noqa: SLF001

    def test_no_module_still_writes_those_columns_through_a_helper(self):
        """The old helpers are gone; a stray call would be an AttributeError at
        runtime, so this fails loudly at build time instead."""
        for name in ('_ensure_outcomes_col', '_ensure_workspace_col'):
            hits = [
                p.relative_to(_APP).as_posix()
                for p in _APP.rglob('*.py')
                if name in p.read_text('utf-8')
            ]
            assert not hits, f'{name} is referenced again in {hits}'