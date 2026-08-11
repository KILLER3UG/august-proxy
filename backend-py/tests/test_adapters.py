"""Adapter unit tests."""

import pytest
from app.adapters import proxy_tool_defs
from app.adapters.anthropic import (
    buildAnthropicSystemBlocks,
    buildOpenaiRequest,
    createOpenaiToAnthropicStreamState,
    handleCountTokens,
    isClaudeFamilyModel,
    normalizeSystemBlocks,
    resolveClaudeClientFacingModel,
    resolveClaudePublicModelAlias,
    sendSimulatedAnthropicStream,
    streamOpenaiDeltaAsAnthropic,
    systemBlocksToText,
    translateMessages,
    translateMessagesToAnthropic,
    writeAnthropicSseData,
)
from app.adapters.openai import (
    accumulateOpenaiChunk,
    buildOpenaiAggregatedFromStream,
    createOpenaiStreamAccumulator,
    deriveSessionIdFromOpenai,
    isOpenaiToolResultError,
    writeOpenaiSseData,
    writeOpenaiSseDone,
)
from app.adapters.proxy_tools import (
    anthropic_to_openai_tool_definition,
    append_missing_tools,
    dedupe_and_canonicalize_anthropic_tools,
    format_managed_web_result,
    get_managed_anthropic_web_tool_definitions,
    get_tool_definition_name,
    is_browser_automation_tool_name,
    is_managed_bash_tool_name,
    is_managed_web_tool_name,
    openai_to_anthropic_tool_definition,
    sanitize_anthropic_tool_definition,
    sanitize_tool_schema,
)
from app.adapters.tool_classification import (
    classifyAnthropicToolUses,
    classifyOpenaiToolCalls,
    getToolNameFromAnthropicTool,
    getToolNameFromOpenaiTool,
)


class TestToolClassification:
    def testGetToolName(self):
        assert getToolNameFromOpenaiTool({'function': {'name': 'test'}}) == 'test'
        assert getToolNameFromOpenaiTool({'name': 'test'}) == 'test'
        assert getToolNameFromAnthropicTool({'name': 'test'}) == 'test'
        assert getToolNameFromOpenaiTool(None) is None

    def testClassifyOpenai(self):
        result = classifyOpenaiToolCalls(
            [{'function': {'name': 'WebSearch'}, 'id': '1'}], managedLocalToolNames={'WebSearch'}
        )
        assert result['has_managed'] is True
        assert result['can_execute_managed'] is True

    def testClassifyOpenaiMixed(self):
        result = classifyOpenaiToolCalls(
            [{'function': {'name': 'WebSearch'}, 'id': '1'}, {'function': {'name': 'client_tool'}, 'id': '2'}],
            managedLocalToolNames={'WebSearch'},
        )
        assert result['has_managed'] is True
        assert result['has_client_or_unknown'] is True
        assert result['can_execute_managed'] is False

    def testClassifyAnthropic(self):
        result = classifyAnthropicToolUses(
            [{'name': 'bash', 'input': {'command': 'ls'}}], managedLocalToolNames={'bash'}
        )
        assert result['has_managed'] is True


class TestProxyTools:
    def testManagedToolNames(self):
        assert is_managed_web_tool_name('WebSearch') is True
        assert is_managed_web_tool_name('WebFetch') is True
        assert is_managed_web_tool_name('unknown') is False
        assert is_managed_bash_tool_name('bash') is True

    def testBrowserAutomation(self):
        assert is_browser_automation_tool_name('browser_navigate') is True
        assert is_browser_automation_tool_name('read_file') is False

    def testToolDefinitions(self):
        tools = get_managed_anthropic_web_tool_definitions()
        assert len(tools) == 5
        names = [t['name'] for t in tools]
        assert 'WebSearch' in names
        assert 'WebFetch' in names
        assert 'mcp__workspace__bash' in names

    def testFormatConverters(self):
        openai = {
            'type': 'function',
            'function': {'name': 'test', 'description': 'desc', 'parameters': {'type': 'object'}},
        }
        anthropic = openai_to_anthropic_tool_definition(openai)
        assert anthropic['name'] == 'test'
        assert anthropic['description'] == 'desc'
        back = anthropic_to_openai_tool_definition(anthropic)
        assert back['type'] == 'function'
        assert back['function']['name'] == 'test'

    def testSanitizeTool(self):
        result = sanitize_anthropic_tool_definition({'name': '  test  ', 'description': 'desc', 'input_schema': {}})
        assert result is not None
        assert result['name'] == 'test'
        result2 = sanitize_anthropic_tool_definition({'type': 'function', 'function': {'name': 'fn_test'}})
        assert result2 is not None
        assert result2['name'] == 'fn_test'
        assert sanitize_anthropic_tool_definition(None) is None
        assert sanitize_anthropic_tool_definition({'description': 'no name'}) is None

    def testSanitizeToolSchema(self):
        assert sanitize_tool_schema(None) == {'type': 'object', 'properties': {}}
        assert sanitize_tool_schema('bad') == {'type': 'object', 'properties': {}}
        filled = sanitize_tool_schema({'properties': {'a': {'type': 'string'}}})
        assert filled['type'] == 'object'
        assert 'a' in filled['properties']
        kept = sanitize_tool_schema({'type': 'object', 'properties': {}, 'required': ['x']})
        assert kept['required'] == ['x']

    def testGetToolDefinitionName(self):
        assert get_tool_definition_name({'name': 'alpha'}) == 'alpha'
        assert get_tool_definition_name({'type': 'function', 'function': {'name': 'beta'}}) == 'beta'
        assert get_tool_definition_name({}) == ''
        assert get_tool_definition_name({'function': 'not-a-dict'}) == ''

    def testAppendMissingTools(self):
        target: list[dict[str, object]] = [{'name': 'keep', 'input_schema': {}}]
        extra = [
            {'name': 'keep', 'input_schema': {}},
            {'name': 'new_one', 'input_schema': {}},
            {'type': 'function', 'function': {'name': 'openai_style'}},
            {'description': 'no name'},
        ]
        appended = append_missing_tools(target, extra)
        assert appended == ['new_one', 'openai_style']
        names = [get_tool_definition_name(t) for t in target]
        assert names == ['keep', 'new_one', 'openai_style']

    def testDedupeTools(self):
        tools = [
            {'name': 'WebSearch', 'description': '', 'input_schema': {'type': 'object', 'properties': {}}},
            {'name': 'WebSearch', 'description': '', 'input_schema': {'type': 'object', 'properties': {}}},
            {'name': 'my_tool', 'description': '', 'input_schema': {'type': 'object', 'properties': {}}},
            {'name': 'browser_navigate', 'description': '', 'input_schema': {'type': 'object', 'properties': {}}},
        ]
        result = dedupe_and_canonicalize_anthropic_tools(tools)
        names = [t['name'] for t in result]
        assert names.count('WebSearch') == 1
        assert 'my_tool' in names
        assert 'browser_navigate' not in names
        assert 'mcp__workspace__bash' in names

    def testDefinitionHelpersReexportedFromProxyTools(self):
        """Back-compat: definition helpers remain importable from proxy_tools."""
        assert sanitize_tool_schema is proxy_tool_defs.sanitize_tool_schema
        assert get_tool_definition_name is proxy_tool_defs.get_tool_definition_name
        assert append_missing_tools is proxy_tool_defs.append_missing_tools
        assert dedupe_and_canonicalize_anthropic_tools is proxy_tool_defs.dedupe_and_canonicalize_anthropic_tools
        assert openai_to_anthropic_tool_definition is proxy_tool_defs.openai_to_anthropic_tool_definition

    def testFormatWebResult(self):
        result = format_managed_web_result({'query': 'test', 'results': [{'title': 'R1', 'url': 'http://x.com'}]})
        assert 'R1' in result
        assert 'test' in result


class TestOpenAIAdapter:
    def testSessionDerivation(self):
        sid = deriveSessionIdFromOpenai({'sessionId': 'test-123'})
        assert sid == 'test-123'
        sid2 = deriveSessionIdFromOpenai({'user': 'user-abc'})
        assert sid2 == 'user-abc'

    def testSseHelpers(self):
        data = writeOpenaiSseData({'choices': [{'delta': {'content': 'hi'}}]})
        assert data.startswith('data: ')
        assert '[DONE]' in writeOpenaiSseDone()

    def testStreamAccumulation(self):
        acc = createOpenaiStreamAccumulator()
        accumulateOpenaiChunk(
            acc, {'id': 'test', 'model': 'gpt-4', 'choices': [{'delta': {'content': 'Hello'}, 'finish_reason': None}]}
        )
        accumulateOpenaiChunk(
            acc,
            {
                'choices': [{'delta': {'content': ' world'}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 5, 'completion_tokens': 3},
            },
        )
        assert acc.content == 'Hello world'
        assert acc.finish_reason == 'stop'
        resp = buildOpenaiAggregatedFromStream(acc)
        assert resp['choices'][0]['message']['content'] == 'Hello world'
        assert resp['usage']['prompt_tokens'] == 5

    def testErrorDetection(self):
        assert isOpenaiToolResultError({'content': 'Error: file not found'}) is True
        assert isOpenaiToolResultError({'content': 'all good'}) is False


class TestAnthropicAdapter:
    def testModelAlias(self):
        assert isClaudeFamilyModel('claude-sonnet-4-7') is True
        assert isClaudeFamilyModel('gpt-4o') is False
        assert resolveClaudePublicModelAlias('sonnet') == 'claude-sonnet-4-6'
        assert resolveClaudePublicModelAlias('opus') == 'claude-opus-4-6'
        assert resolveClaudeClientFacingModel('sonnet') == 'claude-sonnet-4-6'

    def testSystemBlocks(self):
        blocks = normalizeSystemBlocks('You are helpful.')
        assert len(blocks) == 1
        assert blocks[0]['type'] == 'text'
        text = systemBlocksToText(blocks)
        assert 'helpful' in text
        enriched = buildAnthropicSystemBlocks('You are helpful.')
        assert len(enriched) >= 2
        assert any(('August' in b.get('text', '') for b in enriched))

    def testMessageTranslation(self):
        anthropicMsgs = [
            {'role': 'user', 'content': 'Hello'},
            {
                'role': 'assistant',
                'content': [
                    {'type': 'text', 'text': 'Hi!'},
                    {'type': 'tool_use', 'id': 'tu_1', 'name': 'WebSearch', 'input': {'query': 'test'}},
                ],
            },
            {'role': 'tool', 'content': 'results', 'tool_use_id': 'tu_1'},
        ]
        openaiMsgs = translateMessages(anthropicMsgs)
        assert len(openaiMsgs) == 3
        assert openaiMsgs[1]['role'] == 'assistant'
        assert len(openaiMsgs[1].get('tool_calls', [])) == 1

    def testTranslatePreservesToolCallsWithStringContent(self):
        """Regression: OpenAI-path assistant turns are stored as
        {content: <str>, tool_calls: [...]}. translate_messages must keep
        tool_calls so subsequent role:"tool" tool_call_id values resolve;
        otherwise the upstream provider 400s/empties on the re-call after
        tools (the 'chat aborts during tool use' bug)."""
        msgs = [
            {'role': 'user', 'content': 'use a tool'},
            {
                'role': 'assistant',
                'content': '',
                'tool_calls': [
                    {'id': 'call_1', 'type': 'function', 'function': {'name': 'echo', 'arguments': '{"msg":"hi"}'}}
                ],
            },
            {'role': 'tool', 'tool_use_id': 'call_1', 'content': 'hi'},
        ]
        out = translateMessages(msgs)
        asst = out[1]
        tcs = asst.get('tool_calls')
        assert tcs and len(tcs) == 1, 'tool_calls must be preserved when content is a string'
        assert tcs[0]['id'] == 'call_1'
        assert isinstance(tcs[0]['function']['arguments'], str)
        toolMsg = out[2]
        assert toolMsg['role'] == 'tool'
        assert toolMsg['tool_call_id'] == 'call_1'
        assert toolMsg['tool_call_id'] in {tc['id'] for tc in tcs}

    def testTranslateToAnthropicStripsSignaturelessThinking(self):
        """Anthropic rejects assistant messages with a signature-less thinking
        block. Unsigned blocks must still be stripped on re-call."""
        msgs = [
            {'role': 'user', 'content': 'use a tool'},
            {
                'role': 'assistant',
                'content': [
                    {'type': 'thinking', 'text': 'reasoning...'},
                    {'type': 'tool_use', 'id': 'tu_1', 'name': 'echo', 'input': {}},
                ],
            },
            {'role': 'tool', 'tool_use_id': 'tu_1', 'content': 'hi'},
        ]
        out = translateMessagesToAnthropic(msgs)
        asst = next((m for m in out if m.get('role') == 'assistant'))
        blocks = asst['content']
        assert not any((b.get('type') == 'thinking' and (not b.get('signature')) for b in blocks))
        assert any((b.get('type') == 'tool_use' and b.get('id') == 'tu_1' for b in blocks))
        userTool = next(
            (
                m
                for m in out
                if m.get('role') == 'user'
                and isinstance(m.get('content'), list)
                and any((isinstance(b, dict) and b.get('type') == 'tool_result' for b in m['content']))
            )
        )
        assert any((b.get('type') == 'tool_result' and b.get('tool_use_id') == 'tu_1' for b in userTool['content']))

    def testTranslateToAnthropicKeepsSignedThinking(self):
        msgs = [
            {'role': 'user', 'content': 'use a tool'},
            {
                'role': 'assistant',
                'content': [
                    {
                        'type': 'thinking',
                        'thinking': 'reasoning...',
                        'text': 'reasoning...',
                        'signature': 'sig_abc',
                    },
                    {'type': 'tool_use', 'id': 'tu_1', 'name': 'echo', 'input': {}},
                ],
            },
            {'role': 'tool', 'tool_use_id': 'tu_1', 'content': 'hi'},
        ]
        out = translateMessagesToAnthropic(msgs)
        asst = next((m for m in out if m.get('role') == 'assistant'))
        thinking = [b for b in asst['content'] if b.get('type') == 'thinking']
        assert len(thinking) == 1
        assert thinking[0].get('signature') == 'sig_abc'

    def testOpenaiRequestBuilder(self):
        req = buildOpenaiRequest({'messages': [{'role': 'user', 'content': 'Hello'}], 'max_tokens': 4096}, 'gpt-4o')
        assert req['model'] == 'gpt-4o'
        assert len(req['messages']) == 1

    def testSseWriting(self):
        sse = writeAnthropicSseData('message_start', {'type': 'message_start', 'message': {'id': 'test'}})
        assert 'message_start' in sse
        assert 'test' in sse

    def testSimulatedStream(self):
        sim = sendSimulatedAnthropicStream(
            {
                'id': 'msg_test',
                'model': 'claude-3',
                'content': [{'type': 'text', 'text': 'Hello!'}],
                'usage': {'input_tokens': 10, 'output_tokens': 5},
            }
        )
        assert len(sim) >= 4

    def testOpenaiToAnthropicConversion(self):
        state = createOpenaiToAnthropicStreamState()
        events = streamOpenaiDeltaAsAnthropic(
            {'id': 'cmpl-1', 'model': 'gpt-4', 'choices': [{'delta': {'content': 'Hi'}, 'finish_reason': 'stop'}]},
            state,
        )
        assert len(events) >= 2

    @pytest.mark.asyncio
    async def testCountTokens(self):
        result = await handleCountTokens({'messages': [{'role': 'user', 'content': 'Hello'}]})
        assert 'input_tokens' in result
        assert result['estimated'] is True


class TestManagedOpenaiToolCallCasing:
    """Regression: the non-streaming /v1/chat/completions managed loop reads
    `tool_calls` AFTER snakeToCamel renamed it to `toolCalls` — managed tool
    calls were silently dropped and the client got an empty response."""

    @staticmethod
    def _round1ToolCallResponse() -> dict[str, object]:
        return {
            'id': 'chatcmpl-1',
            'model': 'x',
            'choices': [
                {
                    'message': {
                        'role': 'assistant',
                        'content': '',
                        'tool_calls': [
                            {
                                'id': 'call_1',
                                'type': 'function',
                                'function': {'name': 'bash', 'arguments': '{"command": "echo hi"}'},
                            }
                        ],
                    },
                    'finish_reason': 'tool_calls',
                }
            ],
            'usage': {'prompt_tokens': 5, 'completion_tokens': 3, 'total_tokens': 8},
        }

    @staticmethod
    def _round2TextResponse() -> dict[str, object]:
        return {
            'id': 'chatcmpl-2',
            'model': 'x',
            'choices': [{'message': {'role': 'assistant', 'content': 'done'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 7, 'completion_tokens': 2, 'total_tokens': 9},
        }

    @pytest.mark.asyncio
    async def testManagedToolCallsAreDetectedAndExecuted(self, monkeypatch):
        from app.adapters import openai as mod
        from app.adapters import proxy_tools

        async def fake_execute(toolName, args, workspace_path=None, onProgress=None, parentSignal=None):
            return {'stdout': f'output of {args.get("command", "")}', 'stderr': '', 'exit_code': 0}

        monkeypatch.setattr(proxy_tools, 'execute_managed_proxy_tool', fake_execute)

        captured: list[dict[str, object]] = []

        class FakeClient:
            async def requestJson(self, method, url, headers, body=None):
                captured.append(body or {})
                from app.providers.clients.base import ProviderResponse

                if len(captured) == 1:
                    return ProviderResponse(status=200, body=TestManagedOpenaiToolCallCasing._round1ToolCallResponse())
                return ProviderResponse(status=200, body=TestManagedOpenaiToolCallCasing._round2TextResponse())

        messages, usage = await mod.resolveManagedOpenaiToolCalls(
            messages=[{'role': 'user', 'content': 'run ls'}],
            model='x',
            upstreamUrl='https://example.test/v1/chat/completions',
            upstreamHeaders={},
            knownTools=[],
            managedLocalToolNames={'bash'},
            clientToolNames=set(),
            client=FakeClient(),
        )
        # Round 1 (tool call) + round 2 (final text) — the loop must NOT exit
        # on round 1 just because the response was camelized.
        assert len(captured) == 2
        # The round-2 upstream body must carry the executed tool result.
        round2Messages = captured[1].get('messages', [])
        assert isinstance(round2Messages, list) and round2Messages
        toolResults = [m for m in round2Messages if m.get('role') == 'tool']
        assert toolResults, 'no tool result in round-2 messages'
        assert 'output of echo hi' in toolResults[0]['content']
        # The final messages end with the round-2 assistant answer.
        assert messages[-1].get('content') == 'done'
        # Usage must survive from the raw (pre-camelize) body — the last
        # round's usage wins (existing behavior).
        assert usage is not None and usage.get('prompt_tokens') == 7

    @pytest.mark.asyncio
    async def testClientToolCallsArePreservedForPassthrough(self, monkeypatch):
        from app.adapters import openai as mod

        captured: list[dict[str, object]] = []

        class FakeClient:
            async def requestJson(self, method, url, headers, body=None):
                captured.append(body or {})
                from app.providers.clients.base import ProviderResponse

                return ProviderResponse(
                    status=200,
                    body={
                        'id': 'chatcmpl-3',
                        'model': 'x',
                        'choices': [
                            {
                                'message': {
                                    'role': 'assistant',
                                    'content': '',
                                    'tool_calls': [
                                        {
                                            'id': 'call_2',
                                            'type': 'function',
                                            'function': {'name': 'my_client_tool', 'arguments': '{}'},
                                        }
                                    ],
                                },
                                'finish_reason': 'tool_calls',
                            }
                        ],
                    },
                )

        messages, _ = await mod.resolveManagedOpenaiToolCalls(
            messages=[{'role': 'user', 'content': 'call your tool'}],
            model='x',
            upstreamUrl='https://example.test/v1/chat/completions',
            upstreamHeaders={},
            knownTools=[],
            managedLocalToolNames={'bash'},
            clientToolNames={'my_client_tool'},
            client=FakeClient(),
        )
        # The client-owned tool call must be returned to the caller for
        # passthrough — reading the camelized `toolCalls` key is required.
        last = messages[-1]
        toolCalls = last.get('toolCalls') or last.get('tool_calls')
        assert toolCalls, 'client tool calls lost after camelization'
        assert toolCalls[0]['function']['name'] == 'my_client_tool'


class TestManagedToolRound2Body:
    """Round-2 tool_result messages must be role:'user'-wrapped per the
    Messages API — a bare tool_result block appended to messages 400s
    strict Anthropic gateways (regression for the managed web/bash tools)."""

    @staticmethod
    def _toolUseResponse(toolId: str) -> dict[str, object]:
        return {
            'id': 'msg_1',
            'model': 'claude-x',
            'content': [
                {'type': 'tool_use', 'id': toolId, 'name': 'bash', 'input': {'command': 'echo hi'}}
            ],
            'stop_reason': 'tool_use',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
        }

    @staticmethod
    def _textResponse() -> dict[str, object]:
        return {
            'id': 'msg_2',
            'model': 'claude-x',
            'content': [{'type': 'text', 'text': 'done'}],
            'stop_reason': 'end_turn',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
        }

    @pytest.mark.asyncio
    async def testAnthropicUpstreamRound2WrapsToolResults(self, monkeypatch):
        from app.adapters import anthropic as mod

        async def fake_execute(toolName, args, workspace_path=None, onProgress=None, parentSignal=None):
            return f'output of {args.get("command", "")}'

        monkeypatch.setattr(mod, 'execute_managed_proxy_tool', fake_execute)

        captured: list[dict[str, object]] = []

        class FakeClient:
            async def requestJson(self, method, url, headers, body=None):
                captured.append(body or {})
                if len(captured) == 1:
                    from app.providers.clients.base import ProviderResponse

                    return ProviderResponse(status=200, body=TestManagedToolRound2Body._toolUseResponse('toolu_1'))
                from app.providers.clients.base import ProviderResponse

                return ProviderResponse(status=200, body=TestManagedToolRound2Body._textResponse())

        messages, usage = await mod.resolveManagedAnthropicToolUses(
            messages=[{'role': 'user', 'content': 'run ls'}],
            system=[],
            model='claude-x',
            upstreamUrl='https://example.test/v1/messages',
            upstreamHeaders={},
            isAnthropicUpstream=True,
            knownTools=[],
            managedLocalToolNames={'bash'},
            clientToolNames=set(),
            client=FakeClient(),
        )
        assert len(captured) == 2
        round2Messages = captured[1].get('messages', [])
        assert isinstance(round2Messages, list) and round2Messages
        # The tool result must live inside a role:'user' message.
        last = round2Messages[-1]
        assert last.get('role') == 'user'
        content = last.get('content')
        assert isinstance(content, list)
        assert content[0]['type'] == 'tool_result'
        assert content[0]['tool_use_id'] == 'toolu_1'
        assert 'echo hi' in content[0]['content']
        # And the final messages returned carry the same valid shape.
        assert any(
            m.get('role') == 'user' and isinstance(m.get('content'), list)
            and m['content'][0].get('type') == 'tool_result'
            for m in messages
        ), 'no user-wrapped tool_result in final messages'

    @pytest.mark.asyncio
    async def testOpenaiUpstreamRound2UnwrapsToolResults(self, monkeypatch):
        from app.adapters import anthropic as mod

        async def fake_execute(toolName, args, workspace_path=None, onProgress=None, parentSignal=None):
            return 'out'

        monkeypatch.setattr(mod, 'execute_managed_proxy_tool', fake_execute)

        captured: list[dict[str, object]] = []

        class FakeClient:
            async def requestJson(self, method, url, headers, body=None):
                captured.append(body or {})
                from app.providers.clients.base import ProviderResponse

                if len(captured) == 1:
                    return ProviderResponse(
                        status=200,
                        body={
                            'id': 'cmpl_1',
                            'model': 'gpt-x',
                            'choices': [
                                {
                                    'message': {
                                        'role': 'assistant',
                                        'content': '',
                                        'tool_calls': [
                                            {
                                                'id': 'toolu_2',
                                                'type': 'function',
                                                'function': {
                                                    'name': 'bash',
                                                    'arguments': '{"command": "echo hi"}',
                                                },
                                            }
                                        ],
                                    },
                                    'finish_reason': 'tool_calls',
                                }
                            ],
                        },
                    )
                return ProviderResponse(
                    status=200,
                    body={
                        'id': 'cmpl_2',
                        'model': 'gpt-x',
                        'choices': [{'message': {'role': 'assistant', 'content': 'done'}, 'finish_reason': 'stop'}],
                    },
                )

        await mod.resolveManagedAnthropicToolUses(
            messages=[{'role': 'user', 'content': 'run ls'}],
            system=[],
            model='gpt-x',
            upstreamUrl='https://example.test/chat/completions',
            upstreamHeaders={},
            isAnthropicUpstream=False,
            knownTools=[],
            managedLocalToolNames={'bash'},
            clientToolNames=set(),
            client=FakeClient(),
        )
        assert len(captured) == 2
        round2Messages = captured[1].get('messages', [])
        assert isinstance(round2Messages, list) and round2Messages
        # OpenAI wire format: the wrapped user message must translate back
        # into a role:'tool' message with the tool_call_id preserved.
        toolMessages = [m for m in round2Messages if m.get('role') == 'tool']
        assert toolMessages, f'no role:"tool" message in round-2 body: {round2Messages}'
        assert toolMessages[0].get('tool_call_id') == 'toolu_2'
        # And the round-1 assistant tool call must survive the round trip
        # (regression: camelized `toolCalls` used to be lost).
        assistantWithCalls = [
            m for m in round2Messages if m.get('role') == 'assistant' and m.get('tool_calls')
        ]
        assert assistantWithCalls, f'no assistant tool_calls in round-2 body: {round2Messages}'
