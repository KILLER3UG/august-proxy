const http = require('http');

// Simple mock LLM upstream for testing the proxy in parallel
// without hitting real provider rate limits.

const PORT = 9999;

function buildToolResponse(reqBody, stream) {
    const hasToolResults = reqBody.messages && reqBody.messages.some(m => m.role === 'tool');
    const id = 'chatcmpl-' + Math.random().toString(36).substr(2, 9);
    const model = reqBody.model || 'mock-model';

    if (hasToolResults) {
        const content = 'Based on the files you provided, this project contains a bridge configuration (bridge.js), package metadata (package.json), and documentation (README.md). It appears to be a standard Node.js proxy project.';
        if (stream) {
            const chunks = [
                { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
                ...splitIntoChunks(content, 20).map(text => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })),
                { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
            ];
            return chunks.map(c => 'data: ' + JSON.stringify(c)).join('\n') + '\n\ndata: [DONE]\n\n';
        } else {
            return JSON.stringify({
                id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model,
                choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 }
            });
        }
    } else {
        const toolCalls = [
            { id: 'call_listfiles_001', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: '.' }) } },
            { id: 'call_readpkg_002', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'package.json' }) } }
        ];
        if (stream) {
            const chunk1 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
            const chunk2 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCalls[0].id, type: 'function', function: { name: 'list_files', arguments: '' } }] }, finish_reason: null }] };
            const chunk3 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: null }] };
            const chunk4 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: toolCalls[1].id, type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] };
            const chunk5 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ file_path: 'package.json' }) } }] }, finish_reason: null }] };
            const chunk6 = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
            const chunks = [chunk1, chunk2, chunk3, chunk4, chunk5, chunk6];
            return chunks.map(c => 'data: ' + JSON.stringify(c)).join('\n') + '\n\ndata: [DONE]\n\n';
        } else {
            return JSON.stringify({
                id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model,
                choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 30, completion_tokens: 25, total_tokens: 55 }
            });
        }
    }
}

function splitIntoChunks(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.substring(i, i + size));
    }
    return chunks;
}

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const reqBody = JSON.parse(body);
            const wantsStream = reqBody.stream === true;
            const hasTools = reqBody.tools && reqBody.tools.length > 0;

            console.log(`[MockUpstream] ${req.url} stream=${wantsStream} tools=${hasTools} msgs=${reqBody.messages?.length}`);

            setTimeout(() => {
                if (hasTools) {
                    const responseBody = buildToolResponse(reqBody, wantsStream);
                    res.writeHead(200, { 'Content-Type': wantsStream ? 'text/event-stream' : 'application/json' });
                    res.end(responseBody);
                } else {
                    const content = 'Hello! I am a mock upstream model. How can I help you today?';
                    const id = 'chatcmpl-' + Math.random().toString(36).substr(2, 9);
                    const model = reqBody.model || 'mock-model';
                    if (wantsStream) {
                        const chunks = splitIntoChunks(content, 10).map(text => ({
                            id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model,
                            choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                        }));
                        chunks.push({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                        const sse = chunks.map(c => 'data: ' + JSON.stringify(c)).join('\n') + '\n\ndata: [DONE]\n\n';
                        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                        res.end(sse);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model,
                            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                            usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
                        }));
                    }
                }
            }, 100 + Math.random() * 200);
        } catch (e) {
            console.error('[MockUpstream] Error:', e.message);
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
        }
    });
});

server.listen(PORT, () => {
    console.log(`--- Mock Upstream Active on Port ${PORT} ---`);
});
