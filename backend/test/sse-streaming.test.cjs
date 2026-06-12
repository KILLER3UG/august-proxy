const assert = require('node:assert/strict');
const test = require('node:test');
const { SseStreamParser } = require('../adapters/sse-parser');
const { classifyOpenAiToolCalls, classifyAnthropicToolUses } = require('../adapters/tool-classification');

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
