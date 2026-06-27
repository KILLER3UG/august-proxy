"""Adapter unit tests."""
import pytest
from app.adapters.tool_classification import (
    get_tool_name_from_openai_tool, get_tool_name_from_anthropic_tool,
    classify_openai_tool_calls, classify_anthropic_tool_uses,
)
from app.adapters.proxy_tools import (
    is_managed_web_tool_name, is_managed_bash_tool_name,
    openai_to_anthropic_tool_definition, anthropic_to_openai_tool_definition,
    get_managed_anthropic_web_tool_definitions,
    sanitize_anthropic_tool_definition, dedupe_and_canonicalize_anthropic_tools,
    is_browser_automation_tool_name, format_managed_web_result,
)
from app.adapters.openai import (
    derive_session_id_from_openai, write_openai_sse_data, write_openai_sse_done,
    create_openai_stream_accumulator, accumulate_openai_chunk,
    build_openai_aggregated_from_stream, is_openai_tool_result_error,
)
from app.adapters.anthropic import (
    is_claude_family_model, resolve_claude_public_model_alias,
    resolve_claude_client_facing_model, normalize_system_blocks,
    system_blocks_to_text, build_anthropic_system_blocks,
    translate_messages, translate_messages_to_anthropic, build_openai_request,
    write_anthropic_sse_data, send_simulated_anthropic_stream,
    stream_openai_delta_as_anthropic, create_openai_to_anthropic_stream_state,
    handle_count_tokens,
)


class TestToolClassification:
    def test_get_tool_name(self):
        assert get_tool_name_from_openai_tool({"function": {"name": "test"}}) == "test"
        assert get_tool_name_from_openai_tool({"name": "test"}) == "test"
        assert get_tool_name_from_anthropic_tool({"name": "test"}) == "test"
        assert get_tool_name_from_openai_tool(None) is None

    def test_classify_openai(self):
        result = classify_openai_tool_calls(
            [{"function": {"name": "WebSearch"}, "id": "1"}],
            managed_local_tool_names={"WebSearch"},
        )
        assert result["has_managed"] is True
        assert result["can_execute_managed"] is True

    def test_classify_openai_mixed(self):
        result = classify_openai_tool_calls(
            [{"function": {"name": "WebSearch"}, "id": "1"},
             {"function": {"name": "client_tool"}, "id": "2"}],
            managed_local_tool_names={"WebSearch"},
        )
        assert result["has_managed"] is True
        assert result["has_client_or_unknown"] is True
        assert result["can_execute_managed"] is False

    def test_classify_anthropic(self):
        result = classify_anthropic_tool_uses(
            [{"name": "bash", "input": {"command": "ls"}}],
            managed_local_tool_names={"bash"},
        )
        assert result["has_managed"] is True


class TestProxyTools:
    def test_managed_tool_names(self):
        assert is_managed_web_tool_name("WebSearch") is True
        assert is_managed_web_tool_name("WebFetch") is True
        assert is_managed_web_tool_name("unknown") is False
        assert is_managed_bash_tool_name("bash") is True

    def test_browser_automation(self):
        assert is_browser_automation_tool_name("browser_navigate") is True
        assert is_browser_automation_tool_name("read_file") is False

    def test_tool_definitions(self):
        tools = get_managed_anthropic_web_tool_definitions()
        assert len(tools) == 5
        names = [t["name"] for t in tools]
        assert "WebSearch" in names
        assert "WebFetch" in names
        assert "mcp__workspace__bash" in names

    def test_format_converters(self):
        openai = {"type": "function", "function": {"name": "test", "description": "desc", "parameters": {"type": "object"}}}
        anthropic = openai_to_anthropic_tool_definition(openai)
        assert anthropic["name"] == "test"
        assert anthropic["description"] == "desc"

        back = anthropic_to_openai_tool_definition(anthropic)
        assert back["type"] == "function"
        assert back["function"]["name"] == "test"

    def test_sanitize_tool(self):
        result = sanitize_anthropic_tool_definition({"name": "  test  ", "description": "desc", "input_schema": {}})
        assert result is not None
        assert result["name"] == "test"

        result2 = sanitize_anthropic_tool_definition({"type": "function", "function": {"name": "fn_test"}})
        assert result2 is not None
        assert result2["name"] == "fn_test"

    def test_dedupe_tools(self):
        tools = [
            {"name": "WebSearch", "description": "", "input_schema": {"type": "object", "properties": {}}},
            {"name": "WebSearch", "description": "", "input_schema": {"type": "object", "properties": {}}},
            {"name": "my_tool", "description": "", "input_schema": {"type": "object", "properties": {}}},
        ]
        result = dedupe_and_canonicalize_anthropic_tools(tools)
        # Should deduplicate WebSearch and add canonical versions
        names = [t["name"] for t in result]
        assert names.count("WebSearch") == 1
        assert "my_tool" in names

    def test_format_web_result(self):
        result = format_managed_web_result({"query": "test", "results": [{"title": "R1", "url": "http://x.com"}]})
        assert "R1" in result
        assert "test" in result


class TestOpenAIAdapter:
    def test_session_derivation(self):
        sid = derive_session_id_from_openai({"sessionId": "test-123"})
        assert sid == "test-123"

        sid2 = derive_session_id_from_openai({"user": "user-abc"})
        assert sid2 == "user-abc"

    def test_sse_helpers(self):
        data = write_openai_sse_data({"choices": [{"delta": {"content": "hi"}}]})
        assert data.startswith("data: ")
        assert "[DONE]" in write_openai_sse_done()

    def test_stream_accumulation(self):
        acc = create_openai_stream_accumulator()
        accumulate_openai_chunk(acc, {"id": "test", "model": "gpt-4", "choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]})
        accumulate_openai_chunk(acc, {"choices": [{"delta": {"content": " world"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 3}})
        assert acc["content"] == "Hello world"
        assert acc["finish_reason"] == "stop"

        resp = build_openai_aggregated_from_stream(acc)
        assert resp["choices"][0]["message"]["content"] == "Hello world"
        assert resp["usage"]["prompt_tokens"] == 5

    def test_error_detection(self):
        assert is_openai_tool_result_error({"content": "Error: file not found"}) is True
        assert is_openai_tool_result_error({"content": "all good"}) is False


class TestAnthropicAdapter:
    def test_model_alias(self):
        assert is_claude_family_model("claude-sonnet-4-7") is True
        assert is_claude_family_model("gpt-4o") is False
        assert resolve_claude_public_model_alias("sonnet") == "claude-sonnet-4-6"
        assert resolve_claude_public_model_alias("opus") == "claude-opus-4-6"
        assert resolve_claude_client_facing_model("sonnet") == "claude-sonnet-4-6"

    def test_system_blocks(self):
        blocks = normalize_system_blocks("You are helpful.")
        assert len(blocks) == 1
        assert blocks[0]["type"] == "text"

        text = system_blocks_to_text(blocks)
        assert "helpful" in text

        enriched = build_anthropic_system_blocks("You are helpful.")
        assert len(enriched) >= 2  # original + August reminder
        assert any("August" in b.get("text", "") for b in enriched)

    def test_message_translation(self):
        anthropic_msgs = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": [{"type": "text", "text": "Hi!"}, {"type": "tool_use", "id": "tu_1", "name": "WebSearch", "input": {"query": "test"}}]},
            {"role": "tool", "content": "results", "tool_use_id": "tu_1"},
        ]
        openai_msgs = translate_messages(anthropic_msgs)
        assert len(openai_msgs) == 3
        assert openai_msgs[1]["role"] == "assistant"
        assert len(openai_msgs[1].get("tool_calls", [])) == 1

    def test_translate_preserves_tool_calls_with_string_content(self):
        """Regression: OpenAI-path assistant turns are stored as
        {content: <str>, tool_calls: [...]}. translate_messages must keep
        tool_calls so subsequent role:"tool" tool_call_id values resolve;
        otherwise the upstream provider 400s/empties on the re-call after
        tools (the 'chat aborts during tool use' bug)."""
        msgs = [
            {"role": "user", "content": "use a tool"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "echo", "arguments": '{"msg":"hi"}'}},
            ]},
            {"role": "tool", "tool_use_id": "call_1", "content": "hi"},
        ]
        out = translate_messages(msgs)
        asst = out[1]
        tcs = asst.get("tool_calls")
        assert tcs and len(tcs) == 1, "tool_calls must be preserved when content is a string"
        assert tcs[0]["id"] == "call_1"
        assert isinstance(tcs[0]["function"]["arguments"], str)
        tool_msg = out[2]
        assert tool_msg["role"] == "tool"
        assert tool_msg["tool_call_id"] == "call_1"
        assert tool_msg["tool_call_id"] in {tc["id"] for tc in tcs}

    def test_translate_to_anthropic_strips_signatureless_thinking(self):
        """Regression: streaming stores thinking blocks without a signature
        (signature_delta is not captured). Anthropic rejects assistant
        messages with a signature-less thinking block, aborting the re-call
        after tool execution on Claude models with thinking enabled."""
        msgs = [
            {"role": "user", "content": "use a tool"},
            {"role": "assistant", "content": [
                {"type": "thinking", "text": "reasoning..."},  # no signature
                {"type": "tool_use", "id": "tu_1", "name": "echo", "input": {}},
            ]},
            {"role": "tool", "tool_use_id": "tu_1", "content": "hi"},
        ]
        out = translate_messages_to_anthropic(msgs)
        asst = next(m for m in out if m.get("role") == "assistant")
        blocks = asst["content"]
        assert not any(b.get("type") == "thinking" and not b.get("signature") for b in blocks)
        assert any(b.get("type") == "tool_use" and b.get("id") == "tu_1" for b in blocks)
        # The tool_result blocks live in a (grouped) user-role message,
        # NOT the first user message (which is the original prompt string).
        user_tool = next(
            m for m in out
            if m.get("role") == "user"
            and isinstance(m.get("content"), list)
            and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in m["content"])
        )
        assert any(b.get("type") == "tool_result" and b.get("tool_use_id") == "tu_1"
                   for b in user_tool["content"])

    def test_openai_request_builder(self):
        req = build_openai_request(
            {"messages": [{"role": "user", "content": "Hello"}], "max_tokens": 4096},
            "gpt-4o",
        )
        assert req["model"] == "gpt-4o"
        assert len(req["messages"]) == 1

    def test_sse_writing(self):
        sse = write_anthropic_sse_data("message_start", {"type": "message_start", "message": {"id": "test"}})
        assert "message_start" in sse
        assert "test" in sse

    def test_simulated_stream(self):
        sim = send_simulated_anthropic_stream({
            "id": "msg_test", "model": "claude-3",
            "content": [{"type": "text", "text": "Hello!"}],
            "usage": {"input_tokens": 10, "output_tokens": 5},
        })
        assert len(sim) >= 4  # message_start, content_block_start, delta, stop

    def test_openai_to_anthropic_conversion(self):
        state = create_openai_to_anthropic_stream_state()
        events = stream_openai_delta_as_anthropic(
            {"id": "cmpl-1", "model": "gpt-4", "choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]},
            state,
        )
        assert len(events) >= 2

    @pytest.mark.asyncio
    async def test_count_tokens(self):
        result = await handle_count_tokens({"messages": [{"role": "user", "content": "Hello"}]})
        assert "input_tokens" in result
        assert result["estimated"] is True
