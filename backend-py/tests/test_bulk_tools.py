"""Bulk tool helpers and dispatcher."""

from __future__ import annotations

import pytest
from app.services.tool_registrations import bulk_tools
from app.services.tool_registrations.bulk_helpers import coerce_str_list, format_bulk_report


def test_coerce_str_list_array_and_csv():
    assert coerce_str_list(['a', 'b', 'a']) == ['a', 'b']
    assert coerce_str_list('x, y\nz') == ['x', 'y', 'z']
    assert coerce_str_list('["p","q"]') == ['p', 'q']
    assert coerce_str_list(None, single='solo') == ['solo']


def test_format_bulk_report():
    msg = format_bulk_report(
        label='read_files',
        total=3,
        ok_ids=['a.txt', 'b.txt'],
        errors=['c.txt: missing'],
    )
    assert '2/3' in msg
    assert 'a.txt' in msg
    assert 'c.txt' in msg


@pytest.mark.asyncio
async def test_bulk_unknown_operation():
    out = await bulk_tools._bulk(operation='nope')
    assert out.startswith('Error:')
    assert 'read_files' in out


@pytest.mark.asyncio
async def test_bulk_read_files_missing_paths():
    out = await bulk_tools._bulk(operation='read_files')
    assert 'paths is required' in out


@pytest.mark.asyncio
async def test_bulk_kill_daemons_empty():
    out = await bulk_tools._bulk_kill_daemons(daemonIds=[])
    assert 'daemonIds is required' in out


def test_bulk_ops_registered():
    from app.services import tool_registry
    from app.services.tool_registrations.bulk_tools import register

    register()
    names = set(tool_registry._registry.keys())  # noqa: SLF001 — test registry keys
    for n in (
        'bulk',
        'read_files',
        'write_files',
        'rename_sessions',
        'kill_daemons',
        'web_fetch_many',
        'load_skills',
    ):
        assert n in names
