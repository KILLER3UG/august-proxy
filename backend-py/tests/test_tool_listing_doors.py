"""The tool surface had the third and fourth listing doors.

`/api/workspace/files` and `/api/workbench/workspace/files` were closed on
2026-10-12 by routing both through `sandbox.paths.listable_root`. The two entry
points the *agent* uses — the `list_directory` tool and the `search_files` tool —
were never in that pair, and they answer the same question about the same paths.

This file is the measurement, not the theory: on this machine, before the fix,
`list_directory("~/.ssh")` returned a row per key and `search_files(path="~/.ssh")`
accepted the store as a search root (the refusal, if any, had to come from the
per-file hardline check, which `rg` never consults for the root itself).
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def store_root(tmp_path):
    """A temp tree that a folderless session can read (temp is an implicit root)
    and that contains a credential store with a secret inside it."""
    ssh = tmp_path / '.ssh'
    ssh.mkdir()
    (ssh / 'id_ed25519').write_text('PRIVATE KEY MATERIAL', encoding='utf-8')
    (ssh / 'config').write_text('Host *\n  IdentityFile ~/.ssh/id_ed25519\n', encoding='utf-8')
    (tmp_path / 'notes.md').write_text('PRIVATE KEY MATERIAL appears here too', encoding='utf-8')
    return tmp_path


class TestListDirectoryIsAListingDoor:
    def test_a_credential_store_is_not_listable(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        out = asyncio.run(_listDirectory(str(store_root / '.ssh')))
        assert 'id_ed25519' not in out, f'the store was listed: {out!r}'
        assert 'config' not in out, f'the store was listed: {out!r}'
        assert 'Refused' in out or 'blocked' in out.lower(), f'no refusal reported: {out!r}'

    def test_a_store_nested_in_a_listable_parent_is_not_named(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        out = asyncio.run(_listDirectory(str(store_root)))
        assert 'notes.md' in out, f'the ordinary listing broke: {out!r}'
        assert '.ssh' not in out, f'the store rode along with its parent: {out!r}'

    def test_an_ordinary_directory_still_lists(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        good = store_root / 'proj'
        good.mkdir()
        (good / 'a.py').write_text('x = 1', encoding='utf-8')
        out = asyncio.run(_listDirectory(str(good)))
        assert 'a.py' in out, out


class TestSearchFilesIsAListingDoor:
    """`rg` is handed the resolved root and walks it. The per-file hardline
    guard never runs on that walk, so accepting a store as a search root is a
    content leak, not just a name leak — a query for a string inside a key
    returns the key's path and the matching line."""

    def test_a_credential_store_is_not_a_search_root(self, store_root):
        from app.services.tool_registrations.file_tools import _searchFiles as search_files

        out = asyncio.run(search_files('PRIVATE KEY MATERIAL', path=str(store_root / '.ssh')))
        assert 'id_ed25519' not in out, f'the store was searched: {out!r}'
        assert 'Refused' in out or 'blocked' in out.lower(), f'no refusal reported: {out!r}'

    def test_a_store_under_a_searched_parent_is_not_searched(self, store_root):
        from app.services.tool_registrations.file_tools import _searchFiles as search_files

        out = asyncio.run(search_files('PRIVATE KEY MATERIAL', path=str(store_root)))
        assert 'notes.md' in out, f'the ordinary search broke: {out!r}'
        assert '.ssh' not in out, f'a key inside the store matched: {out!r}'
