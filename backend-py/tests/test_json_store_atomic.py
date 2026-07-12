"""Characterization tests for ``app.jsonUtils.write_json_atomic``.

These prove the atomic JSON writer:
  - writes the exact payload to disk,
  - never corrupts an existing file when the rename fails mid-write,
  - leaves no temp-file leftovers after a successful write,
  - correctly replaces an existing file with new content.
"""
from __future__ import annotations

import json
import os

import pytest

from app.jsonUtils import write_json_atomic


def test_write_json_atomic_writes_expected_content(tmp_path: object) -> None:
    path = tmp_path / "out.json"
    data = {"version": 1, "name": "august", "items": [1, 2, 3]}
    write_json_atomic(path, data, indent=2)
    assert path.exists()
    written = json.loads(path.read_text("utf-8"))
    assert written == data


def test_atomic_write_preserves_existing_file_on_failure(tmp_path: object, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"version": 1}, indent=2), "utf-8")

    def _boom(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("simulated rename failure")

    monkeypatch.setattr(os, "replace", _boom)

    with pytest.raises(RuntimeError):
        write_json_atomic(path, {"version": 2})

    # Original (V1) must be intact — never partially overwritten.
    assert json.loads(path.read_text("utf-8")) == {"version": 1}


def test_atomic_write_leaves_no_temp_files(tmp_path: object) -> None:
    path = tmp_path / "store.json"
    write_json_atomic(path, {"a": 1}, indent=2)
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []


def test_existing_file_replaced(tmp_path: object) -> None:
    path = tmp_path / "store.json"
    write_json_atomic(path, {"version": 1}, indent=2)
    write_json_atomic(path, {"version": 2}, indent=2)
    assert json.loads(path.read_text("utf-8")) == {"version": 2}
