"""Test that Pydantic models correctly serialize snake_case fields as camelCase."""

import pytest
from app.models.anthropic import AnthropicRequest, ToolUseBlock, ToolResultBlock
from app.models.openai import ChatCompletionRequest, ToolCall, FunctionDefinition


class TestAliasGenerator:
    """Verify that snake_case Python fields serialize to camelCase JSON."""

    def test_anthropic_request_serializes_to_camel_case(self):
        """AnthropicRequest fields should serialize as camelCase."""
        req = AnthropicRequest(
            model='claude-3-sonnet', max_tokens=1000, stop_sequences=['END'], session_id='test-session-123'
        )

        # Serialize with by_alias=True to get camelCase keys
        data = req.model_dump(by_alias=True)

        # Verify snake_case Python fields become camelCase in JSON
        assert 'maxTokens' in data
        assert 'stopSequences' in data
        assert 'sessionId' in data
        assert data['maxTokens'] == 1000
        assert data['stopSequences'] == ['END']
        assert data['sessionId'] == 'test-session-123'

    def test_anthropic_request_deserializes_from_camel_case(self):
        """AnthropicRequest should accept camelCase JSON input."""
        data = {'model': 'claude-3-sonnet', 'maxTokens': 2000, 'stopSequences': ['STOP'], 'sessionId': 'session-456'}

        req = AnthropicRequest.model_validate(data)

        # Verify camelCase JSON becomes snake_case Python attributes
        assert req.model == 'claude-3-sonnet'
        assert req.max_tokens == 2000
        assert req.stop_sequences == ['STOP']
        assert req.session_id == 'session-456'

    def test_tool_use_block_serializes_to_camel_case(self):
        """ToolUseBlock should serialize with camelCase."""
        block = ToolUseBlock(id='tool-123', name='web_search', input={'query': 'test'})

        data = block.model_dump(by_alias=True)

        # All fields are already camelCase or single words, but verify structure
        assert data['id'] == 'tool-123'
        assert data['name'] == 'web_search'
        assert data['input'] == {'query': 'test'}

    def test_tool_result_block_serializes_to_camel_case(self):
        """ToolResultBlock should serialize with camelCase."""
        block = ToolResultBlock(tool_use_id='tool-123', content='Search results...', is_error=False)

        data = block.model_dump(by_alias=True)

        # Verify snake_case fields become camelCase
        assert 'toolUseId' in data
        assert 'isError' in data
        assert data['toolUseId'] == 'tool-123'
        assert data['isError'] is False

    def test_openai_request_serializes_to_camel_case(self):
        """ChatCompletionRequest should serialize with camelCase."""
        req = ChatCompletionRequest(model='gpt-4', max_tokens=500, session_id='openai-session-789')

        data = req.model_dump(by_alias=True)

        # Verify snake_case fields become camelCase
        assert 'maxTokens' in data
        assert 'sessionId' in data
        assert data['maxTokens'] == 500
        assert data['sessionId'] == 'openai-session-789'

    def test_populate_by_name_allows_both_formats(self):
        """Models should accept both snake_case and camelCase input."""
        # Test with snake_case
        req1 = AnthropicRequest(model='claude-3', max_tokens=100, session_id='snake-case')
        assert req1.max_tokens == 100
        assert req1.session_id == 'snake-case'

        # Test with camelCase
        req2 = AnthropicRequest.model_validate({'model': 'claude-3', 'maxTokens': 200, 'sessionId': 'camel-case'})
        assert req2.max_tokens == 200
        assert req2.session_id == 'camel-case'

    def test_extra_fields_pass_through(self):
        """Extra fields should pass through unchanged."""
        req = AnthropicRequest(model='claude-3', customField='custom-value', anotherExtra=123)

        # Serialize with by_alias=True
        data = req.model_dump(by_alias=True)

        # Extra fields should be preserved as-is
        assert data.get('customField') == 'custom-value'
        assert data.get('anotherExtra') == 123
