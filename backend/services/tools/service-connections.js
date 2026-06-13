const crypto = require('crypto');
const { getConfig, saveConfig } = require('../../lib/config');
const { readJsonBody, sendError, sendJson } = require('../../lib/http-utils');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_SERVICES = ['Gmail read', 'Gmail send', 'Calendar', 'Drive', 'Docs', 'Sheets', 'Slides', 'Tasks', 'Contacts'];
const GOOGLE_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/contacts'
];

const oauthStates = new Map();

function nowIso() {
    return new Date().toISOString();
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function getServiceConnectionsRaw() {
    const config = getConfig();
    return config.serviceConnections && typeof config.serviceConnections === 'object'
        ? config.serviceConnections
        : {};
}

function saveServiceConnection(name, patch) {
    const config = getConfig();
    const current = getServiceConnectionsRaw();
    saveConfig({
        ...config,
        serviceConnections: {
            ...current,
            [name]: {
                ...(current[name] || {}),
                ...patch,
                updatedAt: nowIso()
            }
        }
    });
}

function deleteServiceConnection(name) {
    const config = getConfig();
    const current = getServiceConnectionsRaw();
    const next = { ...current };
    delete next[name];
    saveConfig({ ...config, serviceConnections: next });
}

function getGoogleStatus(raw) {
    const connected = !!(raw?.accessToken || raw?.refreshToken || raw?.email);
    const missingConfig = !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    return {
        name: 'google',
        label: 'Google Workspace',
        description: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts',
        services: GOOGLE_SERVICES,
        scopes: GOOGLE_SCOPES,
        status: connected ? 'connected' : (missingConfig ? 'needs_config' : 'disconnected'),
        connected,
        account: raw?.email,
        missingConfig,
        updatedAt: raw?.updatedAt
    };
}

function getGithubStatus(raw) {
    const connected = !!(raw?.token);
    return {
        name: 'github',
        label: 'GitHub',
        description: 'Repository access, PRs, issues, releases',
        services: ['Repositories', 'Pull requests', 'Issues', 'Gists'],
        scopes: ['repo', 'read:user', 'workflow', 'gist'],
        status: connected ? 'connected' : 'disconnected',
        connected,
        maskedToken: connected && raw?.token ? `${String(raw.token).slice(0, 8)}...${String(raw.token).slice(-4)}` : undefined,
        updatedAt: raw?.updatedAt
    };
}

function getSlackStatus(raw) {
    const connected = !!(raw?.botToken && raw?.teamId);
    return {
        name: 'slack',
        label: 'Slack',
        description: 'Messaging, channels, workspace tools',
        services: ['Channels', 'Messages', 'Files', 'Workspace'],
        scopes: ['chat:write', 'channels:read', 'files:read', 'users:read'],
        status: connected ? 'connected' : 'disconnected',
        connected,
        teamId: raw?.teamId,
        updatedAt: raw?.updatedAt
    };
}

function getServiceConnections() {
    const raw = getServiceConnectionsRaw();
    return {
        google: getGoogleStatus(raw.google),
        github: getGithubStatus(raw.github),
        slack: getSlackStatus(raw.slack)
    };
}

function getServiceConnectionsArray() {
    const connections = getServiceConnections();
    return Object.values(connections);
}

function getBaseUrl(req) {
    const host = req.headers.host || 'localhost:8085';
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || 'http');
    return `${proto}://${host}`;
}

function buildGoogleAuthUrl(req, email) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env before connecting Google.');
    }

    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${getBaseUrl(req)}/api/service-connections/google/callback`;
    const state = randomToken();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    oauthStates.set(state, { expiresAt, email: email || undefined });

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state
    });
    if (email) params.set('login_hint', email);

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeGoogleCode(code, redirectUri) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Google OAuth client id and secret are not configured.');
    }

    const form = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
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
        throw new Error('Google token exchange did not return JSON.');
    }

    if (!res.ok) {
        throw new Error(payload?.error_description || payload?.error || 'Google token exchange failed.');
    }

    return payload;
}

async function fetchGoogleUser(accessToken) {
    const res = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error('Google user info request failed.');
    return res.json();
}

function renderCallback(ok, message) {
    const status = ok ? 'Connected' : 'Connection failed';
    const safeMessage = String(message || '').replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${status}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #020617; color: #e2e8f0; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .card { width: min(420px, calc(100vw - 32px)); border: 1px solid #1e293b; border-radius: 20px; background: #0f172a; padding: 24px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 8px; background: ${ok ? '#22c55e' : '#ef4444'}; }
      code { color: #93c5fd; }
    </style>
  </head>
  <body>
    <div class="card">
      <p><span class="dot"></span><strong>${status}</strong></p>
      <p>${safeMessage}</p>
      <p style="color:#94a3b8">You can close this tab.</p>
    </div>
    <script>
      const origin = window.location.origin;
      window.opener?.postMessage({ type: 'august-service-connection', ok: ${ok ? 'true' : 'false'} }, origin);
      setTimeout(() => window.close(), 900);
    </script>
  </body>
</html>`;
}

async function handleGoogleAuth(req, res) {
    const body = await readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email : undefined;
    const authUrl = buildGoogleAuthUrl(req, email);
    return sendJson(res, { authUrl });
}

async function handleGoogleCallback(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderCallback(false, error));
    }
    if (!code || !state) {
        return res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderCallback(false, 'Missing OAuth code or state.'));
    }

    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || pending.expiresAt < Date.now()) {
        return res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderCallback(false, 'OAuth state expired. Try again.'));
    }

    try {
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${getBaseUrl(req)}/api/service-connections/google/callback`;
        const tokens = await exchangeGoogleCode(code, redirectUri);
        const user = await fetchGoogleUser(tokens.access_token);
        const existing = getServiceConnectionsRaw().google || {};
        saveServiceConnection('google', {
            provider: 'google',
            status: 'connected',
            email: user.email || pending.email,
            scopes: GOOGLE_SCOPES,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || existing.refreshToken || existing.refresh_token,
            expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000,
            updatedAt: nowIso()
        });
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderCallback(true, `Connected as ${user.email || pending.email || 'Google'}.`));
    } catch (e) {
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderCallback(false, e.message));
    }
}

async function handleGoogleDelete(_req, res) {
    deleteServiceConnection('google');
    return sendJson(res, { status: 'ok', service: 'google' });
}

async function handleGithubConnect(req, res) {
    const body = await readJsonBody(req);
    const token = String(body.token || '').trim();
    if (!token) return sendError(res, new Error('GitHub token is required.'), 400);
    saveServiceConnection('github', {
        provider: 'github',
        status: 'connected',
        token,
        scopes: ['repo', 'read:user', 'workflow', 'gist']
    });
    return sendJson(res, { status: 'ok', service: 'github' });
}

async function handleGithubDelete(_req, res) {
    deleteServiceConnection('github');
    return sendJson(res, { status: 'ok', service: 'github' });
}

async function handleSlackConnect(req, res) {
    const body = await readJsonBody(req);
    const botToken = String(body.botToken || '').trim();
    const teamId = String(body.teamId || '').trim();
    if (!botToken || !teamId) return sendError(res, new Error('Slack bot token and team id are required.'), 400);
    saveServiceConnection('slack', {
        provider: 'slack',
        status: 'connected',
        botToken,
        teamId,
        scopes: ['chat:write', 'channels:read', 'files:read', 'users:read']
    });
    return sendJson(res, { status: 'ok', service: 'slack' });
}

async function handleSlackDelete(_req, res) {
    deleteServiceConnection('slack');
    return sendJson(res, { status: 'ok', service: 'slack' });
}

async function handleServiceConnectionRoutes(req, res, urlText) {
    const url = new URL(urlText, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/service-connections' && req.method === 'GET') {
        sendJson(res, { connections: getServiceConnections() });
        return true;
    }

    if (pathname === '/api/service-connections/google/auth' && req.method === 'POST') {
        try {
            await handleGoogleAuth(req, res);
            return true;
        } catch (e) {
            sendError(res, e, 400);
            return true;
        }
    }

    if (pathname === '/api/service-connections/google/callback' && req.method === 'GET') {
        await handleGoogleCallback(req, res);
        return true;
    }

    if (pathname === '/api/service-connections/google' && req.method === 'DELETE') {
        await handleGoogleDelete(req, res);
        return true;
    }

    if (pathname === '/api/service-connections/github' && req.method === 'POST') {
        try {
            await handleGithubConnect(req, res);
            return true;
        } catch (e) {
            sendError(res, e, 400);
            return true;
        }
    }

    if (pathname === '/api/service-connections/github' && req.method === 'DELETE') {
        await handleGithubDelete(req, res);
        return true;
    }

    if (pathname === '/api/service-connections/slack' && req.method === 'POST') {
        try {
            await handleSlackConnect(req, res);
            return true;
        } catch (e) {
            sendError(res, e, 400);
            return true;
        }
    }

    if (pathname === '/api/service-connections/slack' && req.method === 'DELETE') {
        await handleSlackDelete(req, res);
        return true;
    }

    return false;
}

module.exports = {
    getServiceConnections,
    getServiceConnectionsArray,
    handleServiceConnectionRoutes
};
