const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { getConfig, saveConfig } = require('../../lib/config');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/contacts'
];

function nowIso() {
    return new Date().toISOString();
}

function encodeBase64Url(value) {
    return Buffer.from(value, 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function textResult(value) {
    return {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    };
}

function errorResult(error) {
    return {
        content: [{ type: 'text', text: error?.message || String(error) }],
        isError: true
    };
}

function getRawGoogleConnection() {
    const config = getConfig();
    return config.serviceConnections?.google || {};
}

function getGoogleWorkspaceStatus() {
    const raw = getRawGoogleConnection();
    const missingConfig = !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    return {
        name: 'google-workspace',
        connected: !!(raw.accessToken || raw.refreshToken || raw.email),
        account: raw.email,
        scopes: raw.scopes || GOOGLE_SCOPES,
        missingConfig,
        expiresAt: raw.expiresAt,
        updatedAt: raw.updatedAt,
        status: !!(raw.accessToken || raw.refreshToken || raw.email)
            ? (missingConfig ? 'connected_needs_client_secret_for_refresh' : 'connected')
            : 'disconnected'
    };
}

async function refreshGoogleAccessToken() {
    const raw = getRawGoogleConnection();
    const config = getConfig();
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set before refreshing Google Workspace tokens.');
    }
    if (!raw.refreshToken) {
        throw new Error('Google Workspace refresh token is missing. Reconnect Google in Services.');
    }

    const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: raw.refreshToken,
        grant_type: 'refresh_token'
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
    });

    let payload;
    try {
        payload = await res.json();
    } catch (e) {
        throw new Error('Google token refresh did not return JSON.');
    }

    if (!res.ok) {
        throw new Error(payload?.error_description || payload?.error || 'Google token refresh failed.');
    }

    const next = {
        ...raw,
        accessToken: payload.access_token,
        expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000,
        updatedAt: nowIso()
    };

    saveConfig({
        ...config,
        serviceConnections: {
            ...(config.serviceConnections || {}),
            google: next
        }
    });

    return next.accessToken;
}

async function getGoogleAccessToken() {
    const raw = getRawGoogleConnection();

    if (!raw.accessToken && !raw.refreshToken && !raw.email) {
        throw new Error('Google Workspace is not connected. Connect Google in Services first.');
    }

    const expiresSoon = raw.expiresAt && Date.now() >= Number(raw.expiresAt) - 60_000;
    if (!raw.accessToken) {
        return refreshGoogleAccessToken();
    }
    if (expiresSoon) {
        return refreshGoogleAccessToken();
    }
    return raw.accessToken;
}

async function googleRequest(path, options = {}) {
    const accessToken = await getGoogleAccessToken();
    const url = new URL(path, 'https://www.googleapis.com/');
    const res = await fetch(url, {
        ...options,
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...(options.headers || {})
        }
    });

    let payload;
    const rawText = await res.text();
    if (rawText) {
        try {
            payload = JSON.parse(rawText);
        } catch (e) {
            payload = { raw: rawText };
        }
    }

    if (!res.ok) {
        throw new Error(payload?.error?.message || payload?.message || `Google API request failed: ${res.status}`);
    }

    return payload || {};
}

function parseGmailHeaders(message) {
    const headers = {};
    for (const header of message?.payload?.headers || []) {
        if (header?.name) headers[header.name.toLowerCase()] = header.value || '';
    }
    return headers;
}

function extractGmailBody(message) {
    const parts = message?.payload?.parts || [];
    const candidates = message?.payload?.body?.data
        ? [message.payload.body]
        : parts;

    for (const part of candidates) {
        if (part?.mimeType === 'text/plain' && part?.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
    }
    for (const part of candidates) {
        if (part?.mimeType === 'text/html' && part?.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
    }
    return '';
}

function buildGmailMessage({ to, from, cc, bcc, subject, body, html }) {
    const lines = [];
    if (from) lines.push(`From: ${from}`);
    lines.push(`To: ${to}`);
    if (cc) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
    if (bcc) lines.push(`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}`);
    lines.push(`Subject: ${subject}`);
    lines.push('MIME-Version: 1.0');
    lines.push(`Content-Type: text/${html ? 'html' : 'plain'}; charset="utf-8"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(body || '');
    return encodeBase64Url(lines.join('\r\n'));
}

function registerGoogleWorkspaceTools(server) {
    server.registerTool('google_workspace_status', {
        description: 'Check whether Google Workspace OAuth is connected for this August Proxy instance.',
        inputSchema: {}
    }, async () => textResult(getGoogleWorkspaceStatus()));

    server.registerTool('gmail_search', {
        description: 'Search Gmail messages. Use Gmail query syntax, for example: is:unread, from:boss@company.com, newer_than:7d.',
        inputSchema: {
            query: z.string().default(''),
            maxResults: z.number().int().min(1).max(50).default(10)
        },
    }, async ({ query, maxResults }) => {
        const payload = await googleRequest(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
        const messages = payload.messages || [];
        const details = await Promise.all(messages.map(message => googleRequest(`/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
        return textResult(details.map(message => {
            const headers = parseGmailHeaders(message);
            return {
                id: message.id,
                threadId: message.threadId,
                from: headers.from,
                to: headers.to,
                subject: headers.subject,
                date: headers.date,
                snippet: message.snippet
            };
        }));
    });

    server.registerTool('gmail_get', {
        description: 'Read one Gmail message by ID, including plain text or HTML body.',
        inputSchema: {
            messageId: z.string(),
            format: z.enum(['full', 'metadata', 'raw']).default('full')
        },
    }, async ({ messageId, format }) => {
        const message = await googleRequest(`/gmail/v1/users/me/messages/${messageId}?format=${format}`);
        return textResult({
            id: message.id,
            threadId: message.threadId,
            labels: message.labelIds || [],
            headers: parseGmailHeaders(message),
            body: format === 'full' ? extractGmailBody(message) : undefined,
            raw: format === 'raw' ? message.raw : undefined
        });
    });

    server.registerTool('gmail_send', {
        description: 'Send a Gmail message. Confirm recipients and content with the user before calling this tool.',
        inputSchema: {
            to: z.string(),
            subject: z.string(),
            body: z.string(),
            from: z.string().optional(),
            cc: z.array(z.string()).optional(),
            bcc: z.array(z.string()).optional(),
            html: z.boolean().default(false)
        },
    }, async (args) => {
        const rawMessage = buildGmailMessage(args);
        const payload = await googleRequest('/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: rawMessage })
        });
        return textResult({ id: payload.id, threadId: payload.threadId });
    });

    server.registerTool('calendar_list', {
        description: 'List Google Calendar events in a time range.',
        inputSchema: {
            calendarId: z.string().default('primary'),
            start: z.string(),
            end: z.string(),
            maxResults: z.number().int().min(1).max(250).default(10),
            orderBy: z.enum(['startTime', 'updated']).default('startTime'),
            singleEvents: z.boolean().default(true)
        },
    }, async ({ calendarId, start, end, maxResults, orderBy, singleEvents }) => {
        const params = new URLSearchParams({
            timeMin: start,
            timeMax: end,
            maxResults: String(maxResults),
            orderBy,
            singleEvents: String(singleEvents)
        });
        const payload = await googleRequest(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
        return textResult(payload.items || []);
    });

    server.registerTool('calendar_create', {
        description: 'Create a Google Calendar event. Confirm event details with the user before calling this tool.',
        inputSchema: {
            summary: z.string(),
            start: z.string(),
            end: z.string(),
            description: z.string().optional(),
            location: z.string().optional(),
            attendees: z.array(z.string()).optional(),
            calendarId: z.string().default('primary')
        },
    }, async ({ calendarId, summary, start, end, description, location, attendees }) => {
        const event = {
            summary,
            start: { dateTime: start },
            end: { dateTime: end },
            description,
            location,
            attendees: attendees?.map(email => ({ email }))
        };
        const payload = await googleRequest(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event)
        });
        return textResult({ id: payload.id, htmlLink: payload.htmlLink });
    });

    server.registerTool('drive_search', {
        description: 'Search Google Drive files by query.',
        inputSchema: {
            query: z.string().default('trashed = false'),
            maxResults: z.number().int().min(1).max(100).default(10),
            fields: z.string().default('files(id,name,mimeType,modifiedTime,webViewLink,owners,parents,size)')
        },
    }, async ({ query, maxResults, fields }) => {
        const params = new URLSearchParams({ q: query, pageSize: String(maxResults), orderBy: 'modifiedTime desc', fields });
        const payload = await googleRequest(`/drive/v3/files?${params}`);
        return textResult(payload.files || []);
    });

    server.registerTool('drive_get', {
        description: 'Get Google Drive file metadata by file ID.',
        inputSchema: {
            fileId: z.string(),
            fields: z.string().optional()
        },
    }, async ({ fileId, fields }) => {
        const params = fields ? new URLSearchParams({ fields }) : undefined;
        const payload = await googleRequest(`/drive/v3/files/${encodeURIComponent(fileId)}${params ? `?${params}` : ''}`);
        return textResult(payload);
    });

    server.registerTool('sheets_get', {
        description: 'Read values from a Google Sheet.',
        inputSchema: {
            spreadsheetId: z.string(),
            range: z.string()
        },
    }, async ({ spreadsheetId, range }) => {
        const payload = await googleRequest(`/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
        return textResult(payload);
    });

    server.registerTool('sheets_append', {
        description: 'Append rows to a Google Sheet. Confirm the sheet ID, range, and values with the user before calling this tool.',
        inputSchema: {
            spreadsheetId: z.string(),
            range: z.string(),
            values: z.array(z.array(z.string())),
            valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('USER_ENTERED')
        },
    }, async ({ spreadsheetId, range, values, valueInputOption }) => {
        const params = new URLSearchParams({ valueInputOption });
        const payload = await googleRequest(`/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values })
        });
        return textResult(payload);
    });

    server.registerTool('docs_get', {
        description: 'Read text from a Google Doc.',
        inputSchema: {
            documentId: z.string()
        },
    }, async ({ documentId }) => {
        const doc = await googleRequest(`/docs/v1/documents/${encodeURIComponent(documentId)}`);
        const text = (doc.body?.content || [])
            .flatMap(element => element.paragraph?.elements || [])
            .map(element => element.textRun?.content || '')
            .join('');
        return textResult({ title: doc.title, text });
    });

    server.registerTool('docs_create', {
        description: 'Create a Google Doc and optionally append initial body text. Confirm title and content with the user before calling this tool.',
        inputSchema: {
            title: z.string(),
            body: z.string().optional()
        },
    }, async ({ title, body }) => {
        const doc = await googleRequest('/docs/v1/documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        if (body) {
            await googleRequest(`/docs/v1/documents/${doc.documentId}:batchUpdate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        insertText: {
                            text: body,
                            endOfSegmentLocation: {}
                        }
                    }]
                })
            });
        }
        return textResult({ documentId: doc.documentId, url: doc.documentUrl });
    });

    server.registerTool('contacts_list', {
        description: 'List Google Contacts for the connected account.',
        inputSchema: {
            maxResults: z.number().int().min(1).max(100).default(20)
        },
    }, async ({ maxResults }) => {
        const params = new URLSearchParams({
            personFields: 'names,emailAddresses,phoneNumbers',
            pageSize: String(maxResults)
        });
        const payload = await googleRequest(`https://people.googleapis.com/v1/people/me/connections?${params}`);
        return textResult(payload.connections || []);
    });
}

async function main() {
    const server = new McpServer({ name: 'google-workspace', version: '1.0.0' }, { capabilities: { logging: {} } });
    registerGoogleWorkspaceTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[google-workspace-mcp] ready');
}

if (require.main === module) {
    main().catch(error => {
        console.error('[google-workspace-mcp] failed:', error);
        process.exit(1);
    });
}

module.exports = {
    getGoogleAccessToken,
    getGoogleWorkspaceStatus,
    googleRequest,
    registerGoogleWorkspaceTools
};
