"""Golden contract tests for upstream serialization (Phase 1.5).

These tests freeze the exact JSON shape sent to upstream providers.
Any change to dump_openai_upstream_body / dump_anthropic_upstream_body
produces a visible assertion failure — preventing the next session_id:null
incident (see 0.12.21 fix in AGENTS.md).

To update golden expectations after an INTENTIONAL serialization change:
    1. Update the expected dict in this file.
    2. Verify the diff is what you intended.
    3. Run: uv run pytest tests/test_upstream_golden.py -v
"""

import pytest
from app.models.anthropic import AnthropicRequest, dump_anthropic_upstream_body
from app.models.openai import ChatCompletionRequest, dump_openai_upstream_body

# ─── OpenAI Golden Contracts ───────────────────────────────────────────────────


class TestOpenAIGolden:
    """Frozen shapes for dump_openai_upstream_body."""

    def test_basic_chat(self):
        """Simple chat request — no tools, no optional fields."""
        req = ChatCompletionRequest(
            model='gpt-4o',
            messages=[{'role': 'user', 'content': 'Hello'}],
            stream=False,
        )
        body = dump_openai_upstream_body(req)
        assert body == {
            'model': 'gpt-4o',
            'messages': [{'role': 'user', 'content': 'Hello'}],
            'stream': False,
        }

    def test_with_tools(self):
        """Chat with tool definitions forwarded."""
        req = ChatCompletionRequest(
            model='gpt-4o',
            messages=[{'role': 'user', 'content': 'What is 2+2?'}],
            stream=True,
            temperature=0.7,
        )
        # Simulate extra fields via dict input (as proxy receives)
        body_dict = req.model_dump(exclude_none=True)
        body_dict['tools'] = [
            {
                'type': 'function',
                'function': {
                    'name': 'calculator',
                    'description': 'Does math',
                    'parameters': {'type': 'object', 'properties': {'expr': {'type': 'string'}}},
                },
            }
        ]
        body_dict['tool_choice'] = 'auto'
        body = dump_openai_upstream_body(body_dict)
        assert body == {
            'model': 'gpt-4o',
            'messages': [{'role': 'user', 'content': 'What is 2+2?'}],
            'stream': True,
            'temperature': 0.7,
            'tools': [
                {
                    'type': 'function',
                    'function': {
                        'name': 'calculator',
                        'description': 'Does math',
                        'parameters': {'type': 'object', 'properties': {'expr': {'type': 'string'}}},
                    },
                }
            ],
            'tool_choice': 'auto',
        }

    def test_null_stripping(self):
        """session_id=None, user=None, metadata=None must NOT appear upstream.

        This is the exact bug that caused the 0.12.21 incident:
        OpenCode Console rejected `session_id: null` with a Zod error.
        """
        req = ChatCompletionRequest(
            model='deepseek-chat',
            messages=[{'role': 'user', 'content': 'hi'}],
            stream=False,
            session_id=None,
            user=None,
            metadata=None,
        )
        body = dump_openai_upstream_body(req)

        # Critical: none of these keys may appear
        assert 'session_id' not in body
        assert 'sessionId' not in body
        assert 'user' not in body
        assert 'metadata' not in body
        assert 'max_tokens' not in body  # None → excluded
        assert 'temperature' not in body  # None → excluded
        assert 'stop' not in body  # None → excluded

        # Only the non-null fields remain
        assert body == {
            'model': 'deepseek-chat',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'stream': False,
        }

    def test_dict_input_null_stripping(self):
        """Dict inputs (raw proxy passthrough) strip nulls + August routing keys.

        `user`/`metadata` are legitimate OpenAI fields and are kept when
        non-null (only nulls and August-internal `session_id`/`sessionId` go).
        """
        raw = {
            'model': 'gpt-4o-mini',
            'messages': [{'role': 'user', 'content': 'test'}],
            'stream': True,
            'session_id': 'sess_123',  # August-only, must be stripped
            'sessionId': 'sess_123',  # camelCase variant, also stripped
            'user': 'user_456',  # legitimate OpenAI field → kept
            'metadata': {'source': 'workbench'},  # legitimate OpenAI field → kept
            'temperature': None,  # null → stripped
            'max_tokens': 1024,  # non-null → kept
        }
        body = dump_openai_upstream_body(raw)
        assert body == {
            'model': 'gpt-4o-mini',
            'messages': [{'role': 'user', 'content': 'test'}],
            'stream': True,
            'max_tokens': 1024,
            'user': 'user_456',
            'metadata': {'source': 'workbench'},
        }


# ─── Anthropic Golden Contracts ────────────────────────────────────────────────


class TestAnthropicGolden:
    """Frozen shapes for dump_anthropic_upstream_body."""

    def test_basic_messages(self):
        """Simple messages request with system prompt."""
        req = AnthropicRequest(
            model='claude-sonnet-4-20250514',
            max_tokens=1024,
            messages=[{'role': 'user', 'content': 'Hello Claude'}],
            system='You are helpful.',
            stream=False,
        )
        body = dump_anthropic_upstream_body(req)
        assert body == {
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 1024,
            'messages': [{'role': 'user', 'content': 'Hello Claude'}],
            'system': 'You are helpful.',
            'stream': False,
        }

    def test_with_tools(self):
        """Messages with tool definitions and tool_choice."""
        req = AnthropicRequest(
            model='claude-sonnet-4-20250514',
            max_tokens=2048,
            messages=[{'role': 'user', 'content': 'Search for X'}],
            stream=True,
            tools=[
                {
                    'name': 'web_search',
                    'description': 'Search the web',
                    'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}},
                }
            ],
            tool_choice={'type': 'auto'},
        )
        body = dump_anthropic_upstream_body(req)
        assert body == {
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 2048,
            'messages': [{'role': 'user', 'content': 'Search for X'}],
            'stream': True,
            'tools': [
                {
                    'name': 'web_search',
                    'description': 'Search the web',
                    'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}},
                }
            ],
            'tool_choice': {'type': 'auto'},
        }

    def test_null_stripping(self):
        """session_id=None and optional nulls must NOT appear upstream."""
        req = AnthropicRequest(
            model='claude-sonnet-4-20250514',
            max_tokens=512,
            messages=[{'role': 'user', 'content': 'hi'}],
            session_id=None,
            temperature=None,
            top_p=None,
            top_k=None,
            stop_sequences=None,
            tools=None,
            tool_choice=None,
            thinking=None,
        )
        body = dump_anthropic_upstream_body(req)

        # Critical: August-only and null keys must not appear
        assert 'session_id' not in body
        assert 'sessionId' not in body
        assert 'temperature' not in body
        assert 'top_p' not in body
        assert 'top_k' not in body
        assert 'stop_sequences' not in body
        assert 'tools' not in body
        assert 'tool_choice' not in body
        assert 'thinking' not in body
        assert 'system' not in body  # None → excluded
        assert 'metadata' not in body  # None → excluded

        assert body == {
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 512,
            'messages': [{'role': 'user', 'content': 'hi'}],
            'stream': False,
        }

    def test_dict_input_strips_august_keys(self):
        """Dict passthrough strips session_id/sessionId but keeps metadata."""
        raw = {
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 100,
            'messages': [{'role': 'user', 'content': 'test'}],
            'stream': False,
            'session_id': 'sess_abc',  # stripped
            'sessionId': 'sess_abc',  # stripped
            'metadata': {'user_id': 'u1'},  # NOT in Anthropic strip list → kept
            'system': None,  # null → stripped
        }
        body = dump_anthropic_upstream_body(raw)
        assert body == {
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 100,
            'messages': [{'role': 'user', 'content': 'test'}],
            'stream': False,
            'metadata': {'user_id': 'u1'},
        }
