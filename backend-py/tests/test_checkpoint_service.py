"""Filesystem checkpoint create/restore."""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services.workbench.checkpoint_service import (
    create_checkpoint,
    list_checkpoints,
    restore_checkpoint,
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    yield


def test_checkpoint_restore_file(tmp_path):
    ws = tmp_path / 'proj'
    ws.mkdir()
    f = ws / 'hello.txt'
    f.write_text('v1', encoding='utf-8')

    ck = create_checkpoint(
        'sess1',
        workspace_path=str(ws),
        paths=[str(f)],
        tool_name='write_file',
        label='Before edit',
    )
    assert ck is not None
    assert ck['fileCount'] >= 1

    f.write_text('v2-destroyed', encoding='utf-8')
    result = restore_checkpoint('sess1', ck['id'])
    assert result['ok'] is True
    assert f.read_text(encoding='utf-8') == 'v1'


def test_list_checkpoints(tmp_path):
    ws = tmp_path / 'p'
    ws.mkdir()
    f = ws / 'a.py'
    f.write_text('x', encoding='utf-8')
    create_checkpoint('s2', workspace_path=str(ws), paths=[str(f)], tool_name='write_file')
    lst = list_checkpoints('s2')
    assert len(lst) >= 1


def test_restore_deletes_new_file(tmp_path):
    ws = tmp_path / 'p2'
    ws.mkdir()
    newf = ws / 'brand_new.txt'
    # Snapshot before file exists
    ck = create_checkpoint(
        's3',
        workspace_path=str(ws),
        paths=[str(newf)],
        tool_name='write_file',
    )
    assert ck is not None
    newf.write_text('created after', encoding='utf-8')
    result = restore_checkpoint('s3', ck['id'])
    assert result['ok'] is True
    assert not newf.exists()
