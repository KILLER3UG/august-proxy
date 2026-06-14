const assert = require('node:assert/strict');
const test = require('node:test');
const { SseStreamParser } = require('../adapters/sse-parser');
const { classifyOpenAiToolCalls, classifyAnthropicToolUses } = require('../adapters/tool-classification');
const { mergeOpenAiCompatibleProfile } = require('../adapters/openai');

test('SseStreamParser preserves partial JSON spacing and flushes final event', () => {
    const events = [];
    const parser = new SseStreamParser((event, data) => events.push({ event, data }));

    parser.feed('event: message\ndata: {"tool_use": "partial arg with spaces"}');
    parser.flush();

    assert.deepEqual(events, [
        {
            event: 'message',
            data: '{"tool_use": "partial arg with spaces"}'
        }
    ]);
});

test('SseStreamParser joins split data lines', () => {
    const events = [];
    const parser = new SseStreamParser((event, data) => events.push({ event, data }));

    parser.feed('event: message\ndata: {"input":\n');
    parser.feed('data:  "a"}\n\n');

    assert.deepEqual(events, [
        {
            event: 'message',
            data: '{"input":\n "a"}'
        }
    ]);
});

test('OpenAI tool-call classification separates managed, client, and mixed turns', () => {
    const managed = new Set(['august__read_file', 'august__search']);
    const client = new Set(['client_tool']);

    const managedOnly = classifyOpenAiToolCalls([
        { id: 'call_1', type: 'function', function: { name: 'august__read_file', arguments: '{"path":"package.json"}' } },
        { id: 'call_2', type: 'function', function: { name: 'august__search', arguments: '{"query":"node"}' } }
    ], managed, client);
    assert.equal(managedOnly.canExecuteManaged, true);
    assert.equal(managedOnly.hasClientOrUnknown, false);
    assert.equal(managedOnly.managedToolCalls.length, 2);

    const clientOnly = classifyOpenAiToolCalls([
        { id: 'call_1', type: 'function', function: { name: 'client_tool', arguments: '{}' } }
    ], managed, client);
    assert.equal(clientOnly.canExecuteManaged, false);
    assert.equal(clientOnly.hasClientOrUnknown, true);
    assert.equal(clientOnly.toolCalls.length, 1);

    const mixed = classifyOpenAiToolCalls([
        { id: 'call_1', type: 'function', function: { name: 'august__read_file', arguments: '{"path":"package.json"}' } },
        { id: 'call_2', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }
    ], managed, client);
    assert.equal(mixed.canExecuteManaged, false);
    assert.equal(mixed.hasClientOrUnknown, true);
    assert.equal(mixed.toolCalls.length, 2);
});

test('OpenAI request profile overrides shared codex profile', () => {
    const cfg = mergeOpenAiCompatibleProfile({
        targetUrl: 'https://session-a.example/v1',
        apiKey: 'session-a-key',
        currentModel: 'session-a-model',
        _upstreamModel: 'session-a-upstream',
    }, {
        targetUrl: 'https://shared.example/v1',
        apiKey: 'shared-key',
        currentModel: 'shared-model',
        _upstreamModel: 'shared-upstream',
    });

    assert.equal(cfg.currentModel, 'session-a-model');
    assert.equal(cfg._upstreamModel, 'session-a-upstream');
    assert.equal(cfg.targetUrl, 'https://session-a.example/v1/chat/completions');
});

test('OpenAI request profile fills missing upstream model from request currentModel', () => {
    const cfg = mergeOpenAiCompatibleProfile({
        targetUrl: 'https://session-b.example/v1',
        apiKey: 'session-b-key',
        currentModel: 'session-b-model',
    }, {
        targetUrl: 'https://shared.example/v1',
        apiKey: 'shared-key',
        currentModel: 'shared-model',
        _upstreamModel: 'shared-upstream',
    });

    assert.equal(cfg.currentModel, 'session-b-model');
    assert.equal(cfg._upstreamModel, 'session-b-model');
});

test('OpenAI request profile falls back to shared profile when request profile is empty', () => {
    const cfg = mergeOpenAiCompatibleProfile(null, {
        targetUrl: 'https://shared.example/v1',
        apiKey: 'shared-key',
        currentModel: 'shared-model',
        _upstreamModel: 'shared-upstream',
    });

    assert.equal(cfg.currentModel, 'shared-model');
    assert.equal(cfg._upstreamModel, 'shared-upstream');
    assert.equal(cfg.targetUrl, 'https://shared.example/v1/chat/completions');
});

test('Anthropic tool-use classification treats mixed turns as client-owned', () => {
    const managed = new Set(['august__read_file']);
    const client = new Set(['client_tool']);

    const managedOnly = classifyAnthropicToolUses([
        { type: 'tool_use', id: 'toolu_1', name: 'august__read_file', input: { path: 'package.json' } }
    ], managed, client);
    assert.equal(managedOnly.canExecuteManaged, true);
    assert.equal(managedOnly.hasClientOrUnknown, false);
    assert.equal(managedOnly.managedToolUses.length, 1);

    const mixed = classifyAnthropicToolUses([
        { type: 'tool_use', id: 'toolu_1', name: 'august__read_file', input: { path: 'package.json' } },
        { type: 'tool_use', id: 'toolu_2', name: 'client_tool', input: {} }
    ], managed, client);
    assert.equal(mixed.canExecuteManaged, false);
    assert.equal(mixed.hasClientOrUnknown, true);
    assert.equal(mixed.toolUses.length, 2);
});
