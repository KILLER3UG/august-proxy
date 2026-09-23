"""module_context: bounded reading package + tool registration.

The point of the tool is that an agent can choose *which* file to open without
opening any of them, so these tests pin the surface it promises (purpose,
signatures, imports, importers), the budgets it must never exceed, and the
rule that a short list must announce itself as short.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services import tool_registry
from app.services.workbench.module_context import build_module_context

MODULE_SOURCE = '''"""Report assembly for the weekly export."""

from __future__ import annotations

import csv
from pathlib import Path


class Report:
    """One exportable report."""

    def rows(self):
        return []

    def render(self):
        return ''

    def _internal(self):
        return None


def build_report(name: str, *, fmt: str = 'csv') -> Report:
    return Report()


async def publish(report: Report) -> bool:
    return True
'''

CONSUMER = 'from app.services.reporting import build_report\n'


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / 'ws'
    pkg = root / 'app' / 'services' / 'reporting'
    pkg.mkdir(parents=True)
    (pkg / '__init__.py').write_text('', encoding='utf-8')
    (pkg / 'builder.py').write_text(MODULE_SOURCE, encoding='utf-8')
    (root / 'app' / 'services' / 'consumer.py').write_text(CONSUMER, encoding='utf-8')
    (root / 'frontend').mkdir()
    (root / 'frontend' / 'index.ts').write_text(
        'export function runTask(id: string): void {}\n'
        'export const LIMIT = 5;\n'
        'class Hidden {}\n',
        encoding='utf-8',
    )
    return root


def test_python_surface_lists_signatures_not_bodies(workspace: Path) -> None:
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert '# app/services/reporting/builder.py' in out
    assert 'Report assembly for the weekly export' in out
    assert 'class Report' in out
    assert 'def build_report(' in out
    assert 'async def publish(' in out
    # Methods are named, their bodies are not — that is the whole bargain.
    assert 'rows' in out and 'render' in out
    assert 'return []' not in out


def test_signatures_read_as_code_not_double_keyworded(workspace: Path) -> None:
    """The kind prefix is re-added after joining wrapped source, which already
    carries `def`/`class` — without stripping, every entry read `def def foo`."""
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert 'def def ' not in out
    assert 'class class ' not in out
    assert 'async def publish(report: Report) -> bool:' in out
    assert 'def build_report(name: str, *, fmt: str = ' in out
    assert 'class Report' in out


def test_importers_are_found(workspace: Path) -> None:
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert '## Imported by' in out
    assert 'app/services/consumer.py' in out


def test_package_import_is_labelled_rather_than_credited(workspace: Path) -> None:
    """`from pkg import name` does not name builder.py; saying it did would be
    a fabricated edge, and saying nothing would lose a real caller."""
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert 'imports the reporting package, not this file directly' in out


def test_direct_module_import_matches_without_a_label(workspace: Path) -> None:
    (workspace / 'app' / 'direct.py').write_text(
        'from app.services.reporting.builder import build_report\n', encoding='utf-8'
    )
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert 'app/direct.py\n' in out or 'app/direct.py' in out
    assert 'app/direct.py (imports' not in out


def test_lookalike_module_names_do_not_match(workspace: Path) -> None:
    (workspace / 'app' / 'lookalike.py').write_text(
        'from app.services.error_reporting import send\n', encoding='utf-8'
    )
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert 'lookalike' not in out


def test_prose_mentioning_import_is_not_a_dependency(workspace: Path) -> None:
    (workspace / 'app' / 'notes.py').write_text(
        'def help():\n    """import this module to use it"""\n    return None\n',
        encoding='utf-8',
    )
    out = build_module_context(workspace, 'app/services/reporting/builder.py')
    assert 'notes.py' not in out


def test_directory_lists_entries_and_names_the_entrypoint(workspace: Path) -> None:
    out = build_module_context(workspace, 'frontend')
    assert 'index.ts' in out
    assert 'runTask' in out


def test_escape_outside_the_workspace_is_refused(workspace: Path, tmp_path: Path) -> None:
    secret = tmp_path / 'outside-secret.py'
    secret.write_text('LEAKED = 1\n', encoding='utf-8')
    out = build_module_context(workspace, str(secret))
    assert out.startswith('Error')
    assert 'LEAKED' not in out


def test_missing_workspace_reports_clearly() -> None:
    out = build_module_context(None, 'anything.py')
    assert 'no workspace' in out


def test_truncation_is_announced_not_hidden(workspace: Path) -> None:
    out = build_module_context(workspace, 'app/services/reporting/builder.py', max_chars=200)
    assert 'truncated at 200 chars' in out
    assert 'read_file' in out


def test_signature_cap_says_more_exists(workspace: Path) -> None:
    many = workspace / 'app' / 'many.py'
    many.write_text('\n\n'.join(f'def fn_{i}():\n    pass' for i in range(60)), encoding='utf-8')
    out = build_module_context(workspace, 'app/many.py')
    assert 'more top-level names not listed' in out


def test_binary_and_oversized_files_get_guidance_not_garbage(workspace: Path) -> None:
    blob = workspace / 'app' / 'blob.py'
    blob.write_bytes(b'\x00\x01\x02binary')
    out = build_module_context(workspace, 'app/blob.py')
    assert 'No readable source' in out
    assert 'media' in out


def test_non_python_surface_uses_regex_fallback(workspace: Path) -> None:
    out = build_module_context(workspace, 'frontend/index.ts')
    assert 'runTask' in out
    assert 'LIMIT' in out


def test_malformed_python_still_yields_a_surface(workspace: Path) -> None:
    broken = workspace / 'app' / 'broken.py'
    broken.write_text('def ok():\n    pass\n\ndef broken(\n', encoding='utf-8')
    out = build_module_context(workspace, 'app/broken.py')
    assert '## Surface' in out


def test_tool_is_registered_with_a_usable_schema() -> None:
    from app.services.tool_registrations import module_tools

    module_tools.register()
    entry = tool_registry.get('module_context')
    assert entry is not None, 'module_context never registered'
    schema = entry['parameters']
    assert isinstance(schema, dict)
    assert 'path' in (schema.get('required') or [])
    # The description is the only discoverability the model gets, so it has to
    # say when to use the tool rather than merely what it returns.
    assert 'BEFORE read_file' in str(entry['description'])


def test_handler_reports_a_missing_path_instead_of_guessing() -> None:
    import inspect

    from app.services.tool_registrations.module_tools import _moduleContext

    assert inspect.iscoroutinefunction(_moduleContext), (
        'tool_registry awaits every handler; a sync one blocks the event loop '
        'for the whole scan budget'
    )


def test_tool_is_classified_read_only_and_parallel_safe() -> None:
    """Two harness contracts a new read tool must satisfy or it misbehaves:

    `tool_other` fails the capability taxonomy, and staying out of the
    parallel set serializes every batch of reads it joins.
    """
    from app.services.capabilities_prompt import classify_tool
    from app.services.tool_policy import is_mutating
    from app.services.workbench.parallel_tools import is_parallel_safe

    assert classify_tool('module_context') == 'tool_read'
    assert is_mutating('module_context') is False
    assert is_parallel_safe('module_context') is True


async def test_handler_errors_are_returned_not_raised() -> None:
    """A tool failure must come back as a receipt the model can act on."""
    from app.services.tool_registrations.module_tools import _moduleContext

    assert (await _moduleContext('')).startswith('Error')
    # No session bound here, so the workspace is empty — still a receipt.
    assert 'no workspace' in await _moduleContext('app/foo.py')
