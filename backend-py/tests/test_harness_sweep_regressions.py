"""Regression tests for the workbench harness audit fixes (2026-08-11 sweep).

Covers: non-object tool args never executing as `{}` (both the Anthropic
stream aggregator and the text-tool protocol), get_session() preferring the
dispatch ContextVar, and _managedToolLoopCap honoring the documented default.
"""

import asyncio

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.stream_translate import AnthropicWorkbenchStreamAggregator


def _aggregate(input_json_parts: list[str]) -> dict:
    agg = AnthropicWorkbenchStreamAggregator()
    agg.on_event(
        {
            '_event_type': 'content_block_start',
            'index': 0,
            'content_block': {'type': 'tool_use', 'id': 't1', 'name': 'submit_todos'},
        }
    )
    for part in input_json_parts:
        agg.on_event(
            {
                '_event_type': 'content_block_delta',
                'index': 0,
                'delta': {'type': 'input_json_delta', 'partial_json': part},
            }
        )
    agg.on_event({'_event_type': 'content_block_stop', 'index': 0})
    return agg.result()


def test_non_object_json_args_are_marked_raw_not_executed():
    # A gateway emitting `"input": []` (valid JSON, not an object) must not
    # flatten to {} and run the tool with empty args.
    result = _aggregate(['[]'])
    (tool_use,) = result['tool_uses']
    assert '_raw' in tool_use['input']
    assert tool_use['input']['_raw'] == '[]'


def test_scalar_json_args_are_marked_raw():
    result = _aggregate(['42'])
    (tool_use,) = result['tool_uses']
    assert tool_use['input'] == {'_raw': '42'}


def test_object_args_still_parse():
    result = _aggregate(['{"todos": [', '"a"]}'])
    (tool_use,) = result['tool_uses']
    assert tool_use['input'] == {'todos': ['a']}


def test_text_protocol_garbage_marked_raw():
    calls = wb._parseTextToolCalls('[TOOLCALL] submit_todos|garbage-not-json')
    assert len(calls) == 1
    name, args = calls[0]
    assert name == 'submit_todos'
    assert '_raw' in args


def test_text_protocol_empty_args_stay_empty():
    calls = wb._parseTextToolCalls('[TOOLCALL] submit_todos|{}')
    assert calls[0][1] == {}


class _Sess:
    def __init__(self, sid: str, updatedAt: str = ''):
        self.id = sid
        self.updatedAt = updatedAt


def test_get_session_prefers_dispatch_contextvar(monkeypatch):
    from app.services.workbench.context import currentSessionId

    older = _Sess('older', updatedAt='2026-01-01')
    newer = _Sess('newer', updatedAt='2026-02-01')
    monkeypatch.setattr(wb, '_sessions', {'older': older, 'newer': newer})
    token = currentSessionId.set('older')
    try:
        # max-updatedAt would pick `newer`; the ContextVar must win.
        assert wb.get_session() is older
    finally:
        currentSessionId.reset(token)
    # Outside a dispatch, fall back to most recently touched.
    assert wb.get_session() is newer


def test_managed_tool_loop_cap_defaults_to_25(monkeypatch):
    monkeypatch.setattr(wb, 'MAX_MANAGED_TOOL_ROUNDS', 25)

    class _Cfg(dict):
        pass

    def _cfg_with(**kw):
        cfg = _Cfg()
        cfg.update(kw)
        return cfg

    monkeypatch.setattr(
        'app.services.brain_config_service.getRuntimeConfig',
        lambda: _cfg_with(),
    )
    assert wb._managedToolLoopCap() == 25

    monkeypatch.setattr(
        'app.services.brain_config_service.getRuntimeConfig',
        lambda: _cfg_with(maxWorkbenchToolLoops=7),
    )
    assert wb._managedToolLoopCap() == 7


@pytest.mark.asyncio
async def test_update_session_state_reports_timeout():
    from app.services.workbench.workbench import updateSessionState

    sess = _Sess('s')

    class _BrokenLock:
        async def acquire(self):
            raise asyncio.TimeoutError()

        def release(self):
            pass

    sess._state_lock = _BrokenLock()
    assert await updateSessionState(sess, {'phase': 'complete'}) is False
