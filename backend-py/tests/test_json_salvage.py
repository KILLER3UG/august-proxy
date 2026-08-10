"""Tolerant salvage of model-written JSON tool arguments."""

from __future__ import annotations

from app.services.workbench.json_salvage import salvage_json_object


def test_strict_json_passes_through():
    assert salvage_json_object('{"command": "ls"}') == {'command': 'ls'}


def test_code_fenced_json():
    assert salvage_json_object('```json\n{"command": "ls -la"}\n```') == {'command': 'ls -la'}
    assert salvage_json_object('Here is the call:\n```\n{"path": "a.txt"}\n```') == {'path': 'a.txt'}


def test_prose_prefixed_json():
    assert salvage_json_object('Let me check that file. {"path": "README.md", "start": 1}') == {
        'path': 'README.md',
        'start': 1,
    }


def test_trailing_text_after_json():
    assert salvage_json_object('{"path": "a.txt"} done') == {'path': 'a.txt'}


def test_trailing_comma_repaired():
    assert salvage_json_object('{"path": "a.txt",}') == {'path': 'a.txt'}


def test_unbalanced_or_garbage_returns_none():
    assert salvage_json_object('not json at all') is None
    assert salvage_json_object('{"unclosed": ') is None
    assert salvage_json_object('') is None
    assert salvage_json_object(None) is None


def test_array_result_rejected():
    # Tool arguments must be objects — a salvaged array must not reach a tool.
    assert salvage_json_object('[1, 2, 3]') is None


def test_nested_braces_survive():
    raw = '{"input": {"nested": {"deep": [1, 2]}}, "ok": true}'
    assert salvage_json_object(raw) == {'input': {'nested': {'deep': [1, 2]}}, 'ok': True}
