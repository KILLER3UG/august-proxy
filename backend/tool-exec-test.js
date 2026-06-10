// tool-exec-test.js — Tests the tool execution flow end-to-end
process.env.PORT = '9292';

(async () => {
const handler = require('./index.js');
const { Readable } = require('stream');

// Set up a fake provider with a working API key
const { saveProfile, getProfile } = require('./lib/config');
const pConfig = getProfile('codex') || {};
console.log('Backend online. Testing tool execution flow...\n');

// Test 1: Verify tool definitions are injected
const { getProxyOpenAiToolDefinitions } = require('./adapters/proxy-tools');
const defs = getProxyOpenAiToolDefinitions();
const names = defs.map(d => d.function?.name || d.name);
console.log(`Tool definitions injected: ${names.length}`);
console.log(`  Has august__recall: ${names.includes('august__recall')}`);
console.log(`  Has august__bash: ${names.includes('august__bash')}`);
console.log(`  Has bash/mcp__workspace__bash: ${names.includes('bash') || names.includes('mcp__workspace__bash')}`);

// Test 2: Check isProxyManagedLocalToolName
const { isProxyManagedLocalToolName } = require('./adapters/proxy-tools');
console.log(`\nisProxyManagedLocalToolName('august__recall'): ${isProxyManagedLocalToolName('august__recall')}`);
console.log(`isProxyManagedLocalToolName('august__bash'): ${isProxyManagedLocalToolName('august__bash')}`);
console.log(`isProxyManagedLocalToolName('bash'): ${isProxyManagedLocalToolName('bash')}`);

// Test 3: Check executeAugustToolCall
const { executeAugustToolCall } = require('./services/tools/august-tools');
console.log('\nTesting executeAugustToolCall...');
try {
    const result = await executeAugustToolCall('august__list_facts', { category: 'user' }, false);
    console.log(`  august__list_facts: OK — ${String(result).substring(0, 100)}...`);
} catch (e) {
    console.log(`  august__list_facts: ERROR — ${e.message}`);
}

try {
    const result = await executeAugustToolCall('august__recall', { query: 'test' }, false);
    console.log(`  august__recall: OK — ${String(result).substring(0, 100)}...`);
} catch (e) {
    console.log(`  august__recall: ERROR — ${e.message}`);
}

// Test 4: Check the mockRes SSE translation for tool calls
console.log('\nTesting mockRes SSE translation for tool_calls...');
const http = require('http');
const chunks = [];
const mockRes = new http.ServerResponse({ method: 'GET' });
mockRes._implicitHeader = () => {};
const origWrite = mockRes.write.bind(mockRes);
mockRes.write = function(chunk) {
    const str = chunk.toString();
    chunks.push(str);
    // Parse each data: line
    const lines = str.split('\n');
    for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
                const data = JSON.parse(line.slice(6));
                const text = data.content || data.choices?.[0]?.delta?.content || '';
                const toolCalls = data.choices?.[0]?.delta?.tool_calls;
                const finishReason = data.choices?.[0]?.finish_reason;
                if (text) console.log(`  mockRes text: "${text.substring(0, 50)}..."`);
                if (finishReason) console.log(`  mockRes finish_reason: ${finishReason}`);
                if (toolCalls) console.log(`  mockRes tool_calls: ${toolCalls.length} tool(s)`);
            } catch (e) {
                // Not JSON
            }
        }
    }
};
mockRes.writeHead = (status, headers) => {};
mockRes.end = () => {};

// Simulate a tool_calls SSE event
const sseData = JSON.stringify({
    id: 'test-1',
    object: 'chat.completion.chunk',
    choices: [{
        index: 0,
        delta: {
            role: 'assistant',
            content: '',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'august__recall', arguments: '{}' } }]
        },
        finish_reason: 'tool_calls'
    }]
});
console.log('\n  Sending tool_calls SSE chunk to mockRes...');
const sseLine = `data: ${sseData}\n\n`;
mockRes.write(sseLine);
const lastChunks = chunks[chunks.length - 1];
console.log(`  Last chunk starts with data: ${lastChunks.startsWith('data: ')}`);
if (!lastChunks.startsWith('data: [DONE]')) {
    try {
        const parsed = JSON.parse(lastChunks.slice(6));
        const content = parsed.content || parsed.choices?.[0]?.delta?.content || '';
        const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
        console.log(`  Content extracted: "${content.substring(0, 80)}"`);
        console.log(`  Tool calls forwarded: ${toolCalls ? toolCalls.length : 0}`);
    } catch (e) {
        console.log(`  Raw output: ${lastChunks.substring(0, 100)}...`);
    }
}

console.log('\nDone.');
process.exit(0);
})();
