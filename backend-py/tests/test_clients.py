"""Provider client unit tests."""

import pytest
from app.providers.clients.base import (
    SseStreamParser,
    ProviderResponse,
    estimateStringTokens,
    estimateTokens,
    formatTokenCount,
    parseRetryAfterMs,
    isRetryableStatus,
)
from app.providers.clients import getClient, AnthropicClient, OpenAIClient, GeminiClient, MiniMaxClient, BedrockClient


class TestBaseClient:
    def testSseParser(self):
        events = []
        parser = SseStreamParser(onEvent=lambda e, d: events.append((e, d)))
        parser.feed('event: message_start\ndata: {"type":"message_start"}\n\n')
        parser.flush()
        assert len(events) == 1
        assert events[0][0] == 'message_start'

    def testSseParserMultiple(self):
        events = []
        parser = SseStreamParser(onEvent=lambda e, d: events.append((e, d)))
        parser.feed('event: a\ndata: {"i":1}\n\nevent: b\ndata: {"i":2}\n\n')
        parser.flush()
        assert len(events) == 2

    def testRetryHelpers(self):
        assert isRetryableStatus(429) is True
        assert isRetryableStatus(503) is True
        assert isRetryableStatus(200) is False
        assert parseRetryAfterMs('5') == 5000
        assert parseRetryAfterMs('') is None

    def testTokenEstimation(self):
        assert estimateStringTokens('hello') > 0
        assert estimateStringTokens('') == 0
        assert estimateStringTokens(None) == 0
        total = estimateTokens([{'role': 'user', 'content': 'Hello world'}])
        assert total > 0

    def testFormatTokenCount(self):
        assert 'M' in formatTokenCount(1500000)
        assert 'K' in formatTokenCount(1500)
        assert formatTokenCount(500) == '500'

    def testProviderResponse(self):
        resp = ProviderResponse(status=200, body={'ok': True})
        assert resp.is_success is True
        assert resp.is_error is False
        assert resp.body_json == {'ok': True}
        resp2 = ProviderResponse(status=429, body='rate limited')
        assert resp2.is_success is False
        assert resp2.is_error is True


class TestAnthropicClient:
    def testAuthHeaders(self):
        client = AnthropicClient({'name': 'Anthropic'})
        headers = client.buildAuthHeaders('sk-test')
        assert headers['Authorization'] == 'Bearer sk-test'
        assert headers['anthropic-version'] == '2023-06-01'

    def testBaseUrl(self):
        client = AnthropicClient({'name': 'Anthropic'})
        url = client.resolveBaseUrl()
        assert url == 'https://api.anthropic.com'

    def testBaseUrlStripsTrailingV1(self):
        client = AnthropicClient({'name': 'Anthropic', 'baseUrl': 'https://api.anthropic.com/v1'})
        assert client.resolveBaseUrl() == 'https://api.anthropic.com'

    def testResolveApiKeyNoKey(self):
        client = AnthropicClient({'name': 'Anthropic'})
        key = client.resolveApiKey()
        assert key is None or key.startswith('sk-')


class TestOpenAIClient:
    def testAuthHeaders(self):
        client = OpenAIClient({'name': 'OpenAI'})
        headers = client.buildAuthHeaders('sk-test')
        assert headers['Authorization'] == 'Bearer sk-test'

    def testBaseUrl(self):
        client = OpenAIClient({'name': 'OpenAI', 'baseUrl': 'https://custom.api.com/v1'})
        url = client.resolveBaseUrl()
        assert url == 'https://custom.api.com/v1'


class TestGeminiClient:
    def testAuthHeaders(self):
        client = GeminiClient({'name': 'Google AI Studio'})
        headers = client.buildAuthHeaders('gemini-key')
        assert 'x-goog-api-key' in headers
        assert headers['x-goog-api-key'] == 'gemini-key'
        assert 'Authorization' not in headers

    def testBaseUrl(self):
        client = GeminiClient({'name': 'Google AI Studio'})
        url = client.resolveBaseUrl()
        assert 'googleapis.com' in url


class TestMiniMaxClient:
    def testExtendsAnthropic(self):
        client = MiniMaxClient({'name': 'MiniMax'})
        assert isinstance(client, AnthropicClient)

    def testBaseUrl(self):
        client = MiniMaxClient({'name': 'MiniMax', 'baseUrl': 'https://api.minimax.io/anthropic'})
        url = client.resolveBaseUrl()
        assert 'minimax.io' in url


class TestBedrockClient:
    def testAuthHeaders(self):
        client = BedrockClient({'name': 'AWS Bedrock'})
        headers = client.buildAuthHeaders(None)
        assert headers['Content-Type'] == 'application/json'

    def testApiKey(self):
        client = BedrockClient({'name': 'AWS Bedrock'})
        key = client.resolveApiKey()
        assert key is None or key == '__aws_sdk__'


class TestFactory:
    def testAnthropicMessages(self):
        client = getClient({'name': 'Anthropic', 'apiMode': 'anthropicMessages'})
        assert isinstance(client, AnthropicClient)

    def testOpenaiChat(self):
        client = getClient({'name': 'DeepSeek', 'apiMode': 'openaiChat'})
        assert isinstance(client, OpenAIClient)

    def testCodexResponses(self):
        client = getClient({'name': 'OpenAI API', 'apiMode': 'codexResponses'})
        assert isinstance(client, OpenAIClient)

    def testGeminiOpenai(self):
        client = getClient({'name': 'Google AI Studio', 'apiMode': 'geminiOpenai'})
        assert isinstance(client, GeminiClient)

    def testBedrockConverse(self):
        client = getClient({'name': 'AWS Bedrock', 'apiMode': 'bedrockConverse'})
        assert isinstance(client, BedrockClient)

    def testMinimax(self):
        client = getClient({'name': 'MiniMax', 'apiMode': 'minimax'})
        assert isinstance(client, MiniMaxClient)

    def testUnknownModeDefaultsToOpenai(self):
        client = getClient({'name': 'Unknown', 'apiMode': 'weird_format'})
        assert isinstance(client, OpenAIClient)
