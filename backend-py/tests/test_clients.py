"""Provider client unit tests."""
import pytest
from app.providers.clients.base import (
    SseStreamParser, ProviderResponse, estimate_string_tokens, estimate_tokens,
    format_token_count, parse_retry_after_ms, is_retryable_status,
)
from app.providers.clients import (
    get_client, AnthropicClient, OpenAIClient, GeminiClient, MiniMaxClient, BedrockClient,
)


class TestBaseClient:
    def test_sse_parser(self):
        events = []
        parser = SseStreamParser(on_event=lambda e, d: events.append((e, d)))
        parser.feed('event: message_start\ndata: {"type":"message_start"}\n\n')
        parser.flush()
        assert len(events) == 1
        assert events[0][0] == "message_start"

    def test_sse_parser_multiple(self):
        events = []
        parser = SseStreamParser(on_event=lambda e, d: events.append((e, d)))
        parser.feed('event: a\ndata: {"i":1}\n\nevent: b\ndata: {"i":2}\n\n')
        parser.flush()
        assert len(events) == 2

    def test_retry_helpers(self):
        assert is_retryable_status(429) is True
        assert is_retryable_status(503) is True
        assert is_retryable_status(200) is False
        assert parse_retry_after_ms("5") == 5000
        assert parse_retry_after_ms("") is None

    def test_token_estimation(self):
        assert estimate_string_tokens("hello") > 0
        assert estimate_string_tokens("") == 0
        assert estimate_string_tokens(None) == 0
        total = estimate_tokens([{"role": "user", "content": "Hello world"}])
        assert total > 0

    def test_format_token_count(self):
        assert "M" in format_token_count(1_500_000)
        assert "K" in format_token_count(1500)
        assert format_token_count(500) == "500"

    def test_provider_response(self):
        resp = ProviderResponse(status=200, body={"ok": True})
        assert resp.is_success is True
        assert resp.is_error is False
        assert resp.body_json == {"ok": True}

        resp2 = ProviderResponse(status=429, body="rate limited")
        assert resp2.is_success is False
        assert resp2.is_error is True


class TestAnthropicClient:
    def test_auth_headers(self):
        client = AnthropicClient({"name": "Anthropic"})
        headers = client.build_auth_headers("sk-test")
        assert headers["Authorization"] == "Bearer sk-test"
        assert headers["anthropic-version"] == "2023-06-01"

    def test_base_url(self):
        client = AnthropicClient({"name": "Anthropic"})
        url = client.resolve_base_url()
        assert "anthropic.com" in url
        assert url.endswith("/v1")

    def test_resolve_api_key_no_key(self):
        client = AnthropicClient({"name": "Anthropic"})
        key = client.resolve_api_key()
        # Should return None if no env var is set
        assert key is None or key.startswith("sk-")


class TestOpenAIClient:
    def test_auth_headers(self):
        client = OpenAIClient({"name": "OpenAI"})
        headers = client.build_auth_headers("sk-test")
        assert headers["Authorization"] == "Bearer sk-test"

    def test_base_url(self):
        client = OpenAIClient({"name": "OpenAI", "base_url": "https://custom.api.com/v1"})
        url = client.resolve_base_url()
        assert url == "https://custom.api.com/v1"


class TestGeminiClient:
    def test_auth_headers(self):
        client = GeminiClient({"name": "Google AI Studio"})
        headers = client.build_auth_headers("gemini-key")
        assert "x-goog-api-key" in headers
        assert headers["x-goog-api-key"] == "gemini-key"
        assert "Authorization" not in headers

    def test_base_url(self):
        client = GeminiClient({"name": "Google AI Studio"})
        url = client.resolve_base_url()
        assert "googleapis.com" in url


class TestMiniMaxClient:
    def test_extends_anthropic(self):
        client = MiniMaxClient({"name": "MiniMax"})
        assert isinstance(client, AnthropicClient)

    def test_base_url(self):
        client = MiniMaxClient({"name": "MiniMax", "base_url": "https://api.minimax.io/anthropic"})
        url = client.resolve_base_url()
        assert "minimax.io" in url


class TestBedrockClient:
    def test_auth_headers(self):
        client = BedrockClient({"name": "AWS Bedrock"})
        headers = client.build_auth_headers(None)
        assert headers["Content-Type"] == "application/json"

    def test_api_key(self):
        client = BedrockClient({"name": "AWS Bedrock"})
        # Should return None if no AWS creds
        key = client.resolve_api_key()
        assert key is None or key == "__aws_sdk__"


class TestFactory:
    def test_anthropic_messages(self):
        client = get_client({"name": "Anthropic", "api_mode": "anthropic_messages"})
        assert isinstance(client, AnthropicClient)

    def test_openai_chat(self):
        client = get_client({"name": "DeepSeek", "api_mode": "openai_chat"})
        assert isinstance(client, OpenAIClient)

    def test_codex_responses(self):
        client = get_client({"name": "OpenAI API", "api_mode": "codex_responses"})
        assert isinstance(client, OpenAIClient)

    def test_gemini_openai(self):
        client = get_client({"name": "Google AI Studio", "api_mode": "gemini_openai"})
        assert isinstance(client, GeminiClient)

    def test_bedrock_converse(self):
        client = get_client({"name": "AWS Bedrock", "api_mode": "bedrock_converse"})
        assert isinstance(client, BedrockClient)

    def test_minimax(self):
        client = get_client({"name": "MiniMax", "api_mode": "minimax"})
        assert isinstance(client, MiniMaxClient)

    def test_unknown_mode_defaults_to_openai(self):
        client = get_client({"name": "Unknown", "api_mode": "weird_format"})
        assert isinstance(client, OpenAIClient)
