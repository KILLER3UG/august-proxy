"""Regression tests for the OpenAI→Anthropic non-streaming translation.

The CRITICAL audit finding: ``_translateOpenaiToAnthropicResponse`` read the
choice dict instead of ``choices[0].message``, so non-streaming
``/v1/messages`` calls routed to OpenAI-format upstreams returned empty
content, no tool calls and zero usage. These tests pin the corrected shape
for both raw (snake) and camelized upstream bodies.
"""

from app.adapters.anthropic import _translateOpenaiToAnthropicResponse
from app.adapters.case_converters import snakeToCamel, strip_none_deep


def _openai_response() -> dict:
    return {
        'id': 'chatcmpl-abc123',
        'model': 'deepseek-chat',
        'choices': [
            {
                'index': 0,
                'message': {
                    'role': 'assistant',
                    'content': 'Hello world',
                    'tool_calls': [
                        {
                            'id': 'call_1',
                            'type': 'function',
                            'function': {
                                'name': 'search_files',
                                'arguments': '{"pattern": "*.py"}',
                            },
                        }
                    ],
                },
                'finish_reason': 'tool_calls',
            }
        ],
        'usage': {'prompt_tokens': 12, 'completion_tokens': 7, 'total_tokens': 19},
    }


def test_translates_text_and_tool_calls_from_raw_body():
    result = _translateOpenaiToAnthropicResponse(_openai_response(), 'deepseek-chat')
    assert result['content'][0] == {'type': 'text', 'text': 'Hello world'}
    tool_use = [b for b in result['content'] if b.get('type') == 'tool_use']
    assert len(tool_use) == 1
    assert tool_use[0]['id'] == 'call_1'
    assert tool_use[0]['name'] == 'search_files'
    assert tool_use[0]['input'] == {'pattern': '*.py'}
    assert result['stop_reason'] == 'tool_use'
    assert result['usage']['input_tokens'] == 12
    assert result['usage']['output_tokens'] == 7


def test_translates_camelized_body_like_the_non_streaming_caller():
    # handleMessages camelizes the upstream body (snakeToCamel) before
    # translating — toolCalls/finishReason/promptTokens must still be read.
    camelized = snakeToCamel(_openai_response())
    result = _translateOpenaiToAnthropicResponse(camelized, 'deepseek-chat')
    assert result['content'][0]['text'] == 'Hello world'
    tool_use = [b for b in result['content'] if b.get('type') == 'tool_use']
    assert tool_use[0]['name'] == 'search_files'
    assert result['stop_reason'] == 'tool_use'


def test_text_only_response_maps_finish_reason():
    body = {
        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'hi'}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
    }
    result = _translateOpenaiToAnthropicResponse(body, 'm')
    assert result['content'] == [{'type': 'text', 'text': 'hi'}]
    assert result['stop_reason'] == 'end_turn'


def test_empty_choices_still_returns_a_message():
    result = _translateOpenaiToAnthropicResponse({'choices': [], 'usage': {}}, 'm')
    assert result['content'] == []
    assert result['model'] == 'm'


def test_malformed_tool_arguments_never_execute_as_empty_dict():
    body = {
        'choices': [
            {
                'index': 0,
                'message': {
                    'role': 'assistant',
                    'content': '',
                    'tool_calls': [
                        {'id': 'c1', 'type': 'function', 'function': {'name': 'x', 'arguments': 'not-json'}}
                    ],
                },
                'finish_reason': 'tool_calls',
            }
        ],
        'usage': {},
    }
    result = _translateOpenaiToAnthropicResponse(body, 'm')
    tool_use = [b for b in result['content'] if b.get('type') == 'tool_use']
    assert '_raw' in tool_use[0]['input']


def test_strip_none_deep_removes_nested_nulls():
    body = {
        'messages': [{'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'a', 'function': {'name': 'x', 'arguments': None}}]}],
        'tools': None,
        'model': 'm',
    }
    cleaned = strip_none_deep(body)
    assert 'content' not in cleaned['messages'][0]
    assert 'arguments' not in cleaned['messages'][0]['tool_calls'][0]['function']
    assert 'tools' not in cleaned
    assert cleaned['messages'][0]['role'] == 'assistant'


def test_case_converters_leave_tool_use_input_arguments_verbatim():
    from app.adapters.case_converters import camelToSnake

    body = {
        'messages': [
            {
                'role': 'assistant',
                'content': [
                    {'type': 'tool_use', 'id': 't1', 'name': 'edit_lines', 'input': {'filePath': 'a.py', 'maxResults': 3}}
                ],
            }
        ]
    }
    converted = camelToSnake(body)
    block = converted['messages'][0]['content'][0]
    # Tool argument names are the tool's own contract — casing must survive.
    assert block['input'] == {'filePath': 'a.py', 'maxResults': 3}
