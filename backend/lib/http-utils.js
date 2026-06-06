function readRequestBody(req, { limitBytes = 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body, 'utf8') > limitBytes) {
                reject(new Error(`Request body exceeds ${limitBytes} bytes`));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function readJsonBody(req, options) {
    const body = await readRequestBody(req, options);
    if (!body.trim()) return {};
    return JSON.parse(body);
}

function sendJson(res, payload, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function sendText(res, text = 'OK', statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function sendError(res, error, statusCode = 500) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    sendJson(res, { error: message }, statusCode);
}

module.exports = {
    readJsonBody,
    readRequestBody,
    sendError,
    sendJson,
    sendText
};
