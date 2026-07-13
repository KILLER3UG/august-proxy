"""Throwaway verification: run v3 proxy test logic against a LOCAL mock
OpenAI endpoint (no external network / key needed) to prove the adapter path,
provider registration, and assertions are wired correctly. Not committed.

Contract notes (observed against the real OpenAI adapter):
- Non-streaming returns the raw OpenAI `choices` shape (the proxy always keeps
  managed tool defs loaded, so this path goes through the aggregated builder and
  adds id/object/created/usage, but content stays at choices[0].message.content).
- Streaming yields SSE *strings* (data: ...\\n\\n), terminated by data: [DONE].
- The mock emits a WebSearch tool call; because the proxy passes an empty
  managedLocalToolNames set, local execution does not fire and the stream passes
  the tool call through and stops at the tool_calls finish_reason.
"""

from __future__ import annotations
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

LOCAL_URL = 'http://127.0.0.1:8753/v1/chat/completions'
LOCAL_KEY = 'sk-local-test'


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        stream = body.get('stream', False)
        if stream:
            tc = {'id': 'call_1', 'function': {'name': 'WebSearch', 'arguments': '{"query":"x"}'}}
            chunks = [
                {'choices': [{'delta': {'tool_calls': [tc]}, 'finish_reason': None}]},
                {'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}]},
                {'choices': [{'delta': {'content': 'paris is the capital'}, 'finish_reason': None}]},
                {'choices': [{'delta': {}, 'finish_reason': 'stop'}]},
            ]
            data = ''.join(f'data: {json.dumps(c)}\n\n' for c in chunks) + 'data: [DONE]\n\n'
        else:
            data = json.dumps(
                {'choices': [{'message': {'role': 'assistant', 'content': 'pong'}}], 'model': body.get('model', 'x')}
            )
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if not stream else 'text/event-stream')
        self.end_headers()
        self.wfile.write(data.encode() if not stream else data.encode())

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 8753), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import pytest  # noqa: E402
import tempfile  # noqa: E402
from unittest import mock  # noqa: E402

# Register provider pointing at local mock
from app.services import config_service, provider_credentials  # noqa: E402

tmp = tempfile.mkdtemp()
path = os.path.join(tmp, 'providers.json')
path_obj = __import__('pathlib').Path(path)
path_obj.write_text(
    json.dumps(
        {
            'providers': [
                {
                    'id': 'local',
                    'name': 'test-model',
                    'baseUrl': 'http://127.0.0.1:8753/v1',
                    'apiFormat': 'openaiChat',
                    'apiKey': LOCAL_KEY,
                    'enabled': True,
                    'aliases': ['test-model'],
                }
            ]
        }
    ),
    encoding='utf-8',
)
config_service.dataPath = lambda name, *a, **kw: path_obj if name == 'providers.json' else path_obj
provider_credentials.invalidate()

from app.adapters import openai as openaiAdapter  # noqa: E402
from app.adapters.proxy_tools import get_managed_anthropic_web_tool_definitions  # noqa: E402


async def _collect(it):
    out = []
    async for c in it:
        out.append(c)
    return out


# --- Non-streaming: raw choices shape ---
body = {'model': 'test-model', 'messages': [{'role': 'user', 'content': 'x'}], 'stream': False}
res, _ = asyncio.run(openaiAdapter.handleChatCompletions(body, request=None))
assert isinstance(res, dict), f'expected dict, got {type(res).__name__}'
content = res['choices'][0]['message']['content']
print('NONSTREAM content=', content)
assert 'pong' in content.lower(), f"expected 'pong' in {content!r}"

# --- Streaming: SSE strings, terminated by [DONE], passes tool call through ---
body2 = {'model': 'test-model', 'messages': [{'role': 'user', 'content': 'x'}], 'stream': True}
res2, _ = asyncio.run(openaiAdapter.handleChatCompletions(body2, request=None))
ev = asyncio.run(_collect(res2))
joined = ''.join(ev)
print('STREAM num_events=', len(ev), 'ends_with_DONE=', joined.strip().endswith('data: [DONE]'))
assert ev and all(isinstance(e, str) for e in ev), 'stream must yield SSE strings'
assert joined.strip().endswith('data: [DONE]'), 'stream must terminate with [DONE]'
assert 'websearch' in joined.lower(), 'mock tool call (WebSearch) should pass through'

# --- Managed-tool path: OpenAI adapter, tools supplied; stream stays wired ---
body3 = {
    'model': 'test-model',
    'messages': [{'role': 'user', 'content': 'search'}],
    'stream': True,
    'tools': get_managed_anthropic_web_tool_definitions(),
}
res3, _ = asyncio.run(openaiAdapter.handleChatCompletions(body3, request=None))
ev3 = asyncio.run(_collect(res3))
joined3 = ''.join(ev3)
print('MANAGED-TOOL num_events=', len(ev3), 'ends_with_DONE=', joined3.strip().endswith('data: [DONE]'))
assert ev3 and all(isinstance(e, str) for e in ev3), 'managed-tool stream must yield SSE strings'
assert joined3.strip().endswith('data: [DONE]'), 'managed-tool stream must terminate with [DONE]'
assert 'websearch' in joined3.lower(), 'mock tool call (WebSearch) should pass through'

srv.shutdown()
print('VERIFY OK')
