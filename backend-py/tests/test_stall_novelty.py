"""Stall-nudge novelty exemption (Part 28 review, item 9).

The phase/step stall signature punished deep investigation exactly as hard
as real spinning: many read_file/search_files calls on *different* files
never advance phase/step. ``_assistant_round_is_novel`` is the fix — new
tool-call signatures or emitted prose reset the counter; only repeated
identical calls keep counting.
"""

from __future__ import annotations

from app.services.workbench.workbench import _assistant_round_is_novel


def test_anthropic_new_tool_call_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{
        'role': 'assistant',
        'content': [{'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'a.py'}}],
    }]
    assert _assistant_round_is_novel(msgs, seen) is True
    # The identical call repeated is no longer novel — genuine spinning.
    assert _assistant_round_is_novel(msgs, seen) is False


def test_anthropic_different_file_is_novel():
    seen: set[tuple[str, str]] = set()
    first = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'a.py'}},
    ]}]
    second = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'read_file', 'input': {'path': 'b.py'}},
    ]}]
    assert _assistant_round_is_novel(first, seen) is True
    assert _assistant_round_is_novel(second, seen) is True


def test_anthropic_prose_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': [{'type': 'text', 'text': 'found the root cause'}]}]
    assert _assistant_round_is_novel(msgs, seen) is True


def test_openai_tool_calls_novelty():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'function': {'name': 'search_files', 'arguments': '{"query": "x"}'}},
    ]}]
    assert _assistant_round_is_novel(msgs, seen) is True
    assert _assistant_round_is_novel(msgs, seen) is False


def test_openai_text_content_is_novel():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': 'thinking out loud', 'tool_calls': []}]
    assert _assistant_round_is_novel(msgs, seen) is True


def test_no_assistant_message_is_not_novel():
    assert _assistant_round_is_novel([], set()) is False
    assert _assistant_round_is_novel([{'role': 'user', 'content': 'hi'}], set()) is False


def test_malformed_arguments_do_not_crash():
    seen: set[tuple[str, str]] = set()
    msgs = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'function': {'name': 'run_command', 'arguments': 'not-json{'}},
    ]}]
    assert _assistant_round_is_novel(msgs, seen) is True
