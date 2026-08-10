"""Text tool protocol — `[TOOLCALL] name|json` fallback surface for models
that ignore native `tools` (or gateways that silently drop them)."""

from __future__ import annotations

from app.services.workbench.workbench import (
    _parseTextToolCalls,
    _setAssistantText,
    _stripTextToolCallLines,
)


def test_parse_single_call():
    calls = _parseTextToolCalls('[TOOLCALL] run_command|{"command": "ls"}')
    assert calls == [('run_command', {'command': 'ls'})]


def test_parse_multiple_calls_across_lines():
    text = (
        'I will check both files.\n'
        '[TOOLCALL] read_file|{"path": "a.txt"}\n'
        '[TOOLCALL] read_file|{"path": "b.txt"}\n'
        'Then I will answer.'
    )
    calls = _parseTextToolCalls(text)
    assert len(calls) == 2
    assert calls[0] == ('read_file', {'path': 'a.txt'})
    assert calls[1] == ('read_file', {'path': 'b.txt'})


def test_parse_with_salvageable_json():
    # Prose-wrapped JSON still works via the salvage helper.
    calls = _parseTextToolCalls(
        '[TOOLCALL] run_command| Here is the command: {"command": "pwd"} done'
    )
    assert calls == [('run_command', {'command': 'pwd'})]


def test_parse_empty_and_no_markers():
    assert _parseTextToolCalls('') == []
    assert _parseTextToolCalls('plain answer, no tool calls') == []
    assert _parseTextToolCalls('mentions [TOOLCALL] but no pipe line') == []


def test_strip_removes_protocol_lines_only():
    text = (
        'Let me check.\n'
        '[TOOLCALL] read_file|{"path": "a.txt"}\n'
        '[TOOLCALL] read_file|{"path": "b.txt"}\n'
        'Done checking.'
    )
    cleaned = _stripTextToolCallLines(text)
    assert '[TOOLCALL]' not in cleaned
    assert 'Let me check.' in cleaned
    assert 'Done checking.' in cleaned


def test_set_assistant_text_openai():
    msg: dict[str, object] = {'role': 'assistant', 'content': 'raw [TOOLCALL] x|{}'}
    _setAssistantText(msg, 'cleaned', isAnthropic=False)
    assert msg['content'] == 'cleaned'


def test_set_assistant_text_anthropic():
    blocks = [
        {'type': 'text', 'text': 'raw [TOOLCALL] x|{}'},
        {'type': 'thinking', 'text': 'keep me'},
    ]
    msg: dict[str, object] = {'role': 'assistant', 'content': blocks}
    _setAssistantText(msg, 'cleaned', isAnthropic=True, contentBlocks=blocks)
    assert blocks[0]['text'] == 'cleaned'
    assert blocks[1]['text'] == 'keep me'
    assert msg['content'] == blocks
