/**
 * MCP OAuth 2.0 Authorization Module
 *
 * Implements OAuth 2.0 PKCE (Proof Key for Code Exchange) flow for MCP servers.
 * Inspired by OpenCode's MCP OAuth implementation.
 *
 * Flow:
 *   1. Client generates code_verifier and code_challenge (SHA-256)
 *   2. Client starts a local HTTP callback server on a random port
 *   3. User is redirected to the authorization URL
 *   4. Auth server redirects back to localhost with authorization code
 *   5. Client exchanges the code for tokens (access + refresh)
 *   6. Tokens are persisted in config.json under mcpServers[serverName].oauth
 *   7. On subsequent requests, tokens are looked up and auto-refreshed if expired
 *
 * @module mcp-oauth
 */

const crypto = require('crypto');
const http = require('http');
const url = require('url');
const { getConfig, saveConfig } = require('../../lib/config');

// ─────────────────────────────────────────────────────────────
// In-memory pending OAuth flows
// Maps state -> { serverName, serverUrl, codeVerifier, port, res }
// ─────────────────────────────────────────────────────────────
const pendingAuthFlows = new Map();

/**
 * Generate a cryptographically random string of the given byte length,
 * returned as a base64url-encoded string (no padding).
 *
 * @param {number} byteLength - Number of random bytes (default: 32)
 * @returns {string} Base64url-encoded random string
 */
function randomBase64Url(byteLength = 32) {
    return crypto.randomBytes(byteLength)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Compute the SHA-256 digest of a string and return base64url-encoded.
 *
 * @param {string} input - Input string (e.g. code_verifier)
 * @returns {string} Base64url-encoded SHA-256 digest
 */
function sha256Base64Url(input) {
    return crypto.createHash('sha256')
        .update(input, 'utf8')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Find an available TCP port on localhost.
 *
 * @returns {Promise<number>} An available port number
 */
function findAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

/**
 * Read stored OAuth token data for a given MCP server from config.
 *
 * @param {string} serverName - Name of the MCP server
 * @returns {object|null} Token data or null if not found
 */
function readStoredToken(serverName) {
    try {
        const config = getConfig();
        const servers = config.mcpServers;
        if (!Array.isArray(servers)) return null;
        const server = servers.find(s => s && s.name === serverName);
        return server?.oauth || null;
    } catch (e) {
        console.error(`[MCP-OAuth] Failed to read token for '${serverName}': ${e.message}`);
        return null;
    }
}

/**
 * Initiate the OAuth PKCE authorization flow.
 *
 * Steps:
 *   1. Generate code_verifier (64 random bytes, base64url)
 *   2. Derive code_challenge (SHA-256 of verifier, base64url)
 *   3. Start a local HTTP callback server on a random available port
 *   4. Build the authorization URL with PKCE params
 *   5. Store pending auth state in memory
 *
 * The authorization URL should be opened in the user's browser.
 * After the user authenticates, the auth server redirects to
 * http://127.0.0.1:{port}?code=...&state=... and the callback
 * handler exchanges the code for tokens.
 *
 * @param {string} serverName - Name of the MCP server being authorized
 * @param {string} authUrl - Base authorization URL from the server's auth config
 * @param {object} [options] - Additional options
 * @param {string} [options.clientId] - OAuth client ID (if not using MCP native)
 * @param {string} [options.redirectUri] - Custom redirect URI (default: http://127.0.0.1:{port})
 * @param {string} [options.scope] - OAuth scope string
 * @returns {Promise<{authorizationUrl: string, state: string, port: number, codeVerifier: string}>}
 */
async function startOAuthFlow(serverName, authUrl, options = {}) {
    console.log(`[MCP-OAuth] Starting OAuth flow for '${serverName}'...`);

    // ── Generate PKCE values ──
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const state = randomBase64Url(32);

    // ── Find available port and start callback server ──
    const port = await findAvailablePort();
    const redirectUri = options.redirectUri || `http://127.0.0.1:${port}`;

    console.log(`[MCP-OAuth] Callback server listening on 127.0.0.1:${port}`);

    // ── Build authorization URL ──
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId || serverName,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: state,
    });
    if (options.scope) {
        params.set('scope', options.scope);
    }

    const authorizationUrl = `${authUrl}?${params.toString()}`;

    // ── Store pending state ──
    pendingAuthFlows.set(state, {
        serverName,
        serverUrl: authUrl,
        codeVerifier,
        port,
        redirectUri,
        clientId: options.clientId || serverName,
        scope: options.scope,
        startedAt: Date.now(),
    });

    console.log(`[MCP-OAuth] Authorization URL generated for '${serverName}'`);

    return {
        authorizationUrl,
        state,
        port,
        codeVerifier,
    };
}

/**
 * Handle an incoming OAuth callback request.
 *
 * This is the HTTP request handler for the local callback server.
 * It extracts the authorization code and state from query params,
 * exchanges the code for tokens, stores them, and returns a response
 * to the browser.
 *
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @returns {Promise<void>}
 */
async function handleAuthCallback(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const { code, state, error: authError } = parsedUrl.query;

    // ── Check for auth server errors ──
    if (authError) {
        const message = `Authorization denied by server: ${authError}`;
        console.error(`[MCP-OAuth] ${message}`);
        sendCallbackResponse(res, false, message);
        return;
    }

    // ── Validate required params ──
    if (!code) {
        const message = 'Missing authorization code in callback';
        console.error(`[MCP-OAuth] ${message}`);
        sendCallbackResponse(res, false, message);
        return;
    }

    if (!state) {
        const message = 'Missing state parameter in callback';
        console.error(`[MCP-OAuth] ${message}`);
        sendCallbackResponse(res, false, message);
        return;
    }

    // ── Look up pending flow ──
    const flow = pendingAuthFlows.get(state);
    if (!flow) {
        const message = `Invalid or expired state parameter. Please restart the OAuth flow.`;
        console.error(`[MCP-OAuth] ${message}`);
        sendCallbackResponse(res, false, message);
        return;
    }

    // ── Clean up pending state ──
    pendingAuthFlows.delete(state);

    try {
        // ── Exchange authorization code for tokens ──
        const tokenData = await exchangeCodeForTokens(flow, code);

        // ── Persist tokens ──
        await saveToken(flow.serverName, tokenData);

        console.log(`[MCP-OAuth] Successfully authenticated '${flow.serverName}'`);
        sendCallbackResponse(res, true, `Successfully authenticated '${flow.serverName}'. You may close this window.`);
    } catch (err) {
        console.error(`[MCP-OAuth] Token exchange failed for '${flow.serverName}': ${err.message}`);
        sendCallbackResponse(res, false, `Token exchange failed: ${err.message}`);
    }
}

/**
 * Exchange an authorization code for access/refresh tokens.
 *
 * Makes a POST request to the token endpoint with the authorization code,
 * code_verifier, and client credentials.
 *
 * @param {object} flow - The pending OAuth flow object
 * @param {string} flow.serverUrl - Server base URL
 * @param {string} flow.codeVerifier - PKCE code verifier
 * @param {string} flow.redirectUri - Redirect URI
 * @param {string} flow.clientId - Client ID
 * @param {string} code - Authorization code from callback
 * @returns {Promise<object>} Token data { access_token, refresh_token?, expires_in?, token_type, scope? }
 */
async function exchangeCodeForTokens(flow, code) {
    const tokenUrl = flow.serverUrl.replace(/\/authorize$/, '/token');

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.codeVerifier,
    });

    console.log(`[MCP-OAuth] Exchanging authorization code for tokens at ${tokenUrl}...`);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorDetail;
        try {
            errorDetail = JSON.parse(errorText);
        } catch {
            errorDetail = { error: errorText };
        }
        throw new Error(`Token endpoint returned ${response.status}: ${errorDetail.error_description || errorDetail.error || errorText}`);
    }

    const tokenResponse = await response.json();

    // Validate response
    if (!tokenResponse.access_token) {
        throw new Error('Token endpoint did not return an access_token');
    }

    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token || null,
        expires_in: tokenResponse.expires_in || null,
        expires_at: tokenResponse.expires_in
            ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
            : null,
        token_type: tokenResponse.token_type || 'Bearer',
        scope: tokenResponse.scope || flow.scope || null,
    };
}

/**
 * Refresh an expired access token using the refresh token.
 *
 * @param {string} serverName - Name of the MCP server
 * @param {object} tokenData - Current token data with refresh_token
 * @param {string} [tokenUrl] - Token endpoint URL (derived from config if not provided)
 * @returns {Promise<object>} Updated token data
 */
async function refreshAccessToken(serverName, tokenData, tokenUrl) {
    if (!tokenData.refresh_token) {
        throw new Error(`No refresh token available for '${serverName}'. Re-authentication required.`);
    }

    const refreshUrl = tokenUrl || tokenData._tokenEndpoint || null;
    if (!refreshUrl) {
        throw new Error(`No token endpoint URL available for '${serverName}'.`);
    }

    console.log(`[MCP-OAuth] Refreshing token for '${serverName}'...`);

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token,
        client_id: tokenData._clientId || serverName,
    });

    const response = await fetch(refreshUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorDetail;
        try {
            errorDetail = JSON.parse(errorText);
        } catch {
            errorDetail = { error: errorText };
        }

        // If the refresh token is invalid or revoked, clear auth and tell user to re-auth
        if (response.status === 400 || response.status === 401) {
            console.warn(`[MCP-OAuth] Refresh token invalid for '${serverName}'. Clearing auth.`);
            await clearAuth(serverName);
            throw new Error(`Refresh token expired or revoked for '${serverName}'. Please re-authenticate.`);
        }

        throw new Error(`Token refresh failed (${response.status}): ${errorDetail.error_description || errorDetail.error || errorText}`);
    }

    const tokenResponse = await response.json();

    if (!tokenResponse.access_token) {
        throw new Error('Token refresh response did not contain an access_token');
    }

    const updatedToken = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token || tokenData.refresh_token,
        expires_in: tokenResponse.expires_in || null,
        expires_at: tokenResponse.expires_in
            ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
            : null,
        token_type: tokenResponse.token_type || 'Bearer',
        scope: tokenResponse.scope || tokenData.scope,
    };

    // Preserve metadata
    if (tokenData._tokenEndpoint) updatedToken._tokenEndpoint = tokenData._tokenEndpoint;
    if (tokenData._clientId) updatedToken._clientId = tokenData._clientId;

    // Persist updated tokens
    await saveToken(serverName, updatedToken);

    console.log(`[MCP-OAuth] Token refreshed successfully for '${serverName}'`);
    return updatedToken;
}

/**
 * Get authorization headers for MCP requests to a given server.
 *
 * Looks up the stored token, refreshes if expired, and returns
 * the Authorization header object.
 *
 * @param {string} serverName - Name of the MCP server
 * @returns {Promise<object|null>} Headers object like { Authorization: 'Bearer <token>' } or null if not authenticated
 */
async function getAuthHeaders(serverName) {
    const tokenData = readStoredToken(serverName);
    if (!tokenData || !tokenData.access_token) {
        return null;
    }

    // Check if token is expired (with 5-minute buffer)
    if (tokenData.expires_at) {
        const now = Math.floor(Date.now() / 1000);
        const buffer = 300; // 5 minutes
        if (tokenData.expires_at <= now + buffer) {
            try {
                // Try to refresh
                const refreshed = await refreshAccessToken(serverName, tokenData);
                return {
                    'Authorization': `${refreshed.token_type || 'Bearer'} ${refreshed.access_token}`,
                };
            } catch (err) {
                console.error(`[MCP-OAuth] Token refresh failed for '${serverName}': ${err.message}`);
                // Return expired token - caller can handle the 401
                return {
                    'Authorization': `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}`,
                };
            }
        }
    }

    return {
        'Authorization': `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}`,
    };
}

/**
 * Check if an MCP server requires OAuth authentication.
 *
 * @param {object} serverConfig - MCP server configuration object
 * @returns {boolean} True if the server requires OAuth
 */
function isOAuthRequired(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object') return false;
    const auth = serverConfig.auth;
    return !!(auth && auth.type === 'oauth');
}

/**
 * Persist OAuth token data for an MCP server.
 *
 * Stores token data in config.json under mcpServers[serverName].oauth.
 * If the server config doesn't exist in the array yet, it creates a minimal entry.
 *
 * @param {string} serverName - Name of the MCP server
 * @param {object} tokenData - Token data to persist
 * @param {string} tokenData.access_token - Access token
 * @param {string|null} tokenData.refresh_token - Refresh token (optional)
 * @param {number|null} tokenData.expires_at - Unix timestamp when token expires (optional)
 * @param {string} tokenData.token_type - Token type (default: 'Bearer')
 * @param {string|null} tokenData.scope - OAuth scope (optional)
 * @returns {Promise<void>}
 */
async function saveToken(serverName, tokenData) {
    const config = getConfig();
    const servers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];

    const existingIndex = servers.findIndex(s => s && s.name === serverName);
    const oauthData = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        expires_at: tokenData.expires_at || null,
        token_type: tokenData.token_type || 'Bearer',
        scope: tokenData.scope || null,
        updated_at: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
        servers[existingIndex] = {
            ...servers[existingIndex],
            oauth: oauthData,
        };
    } else {
        servers.push({
            name: serverName,
            source: 'builtin',
            enabled: true,
            oauth: oauthData,
        });
    }

    config.mcpServers = servers;
    saveConfig(config);
    console.log(`[MCP-OAuth] Tokens saved for '${serverName}'`);
}

/**
 * Clear stored OAuth tokens for an MCP server.
 *
 * @param {string} serverName - Name of the MCP server
 * @returns {Promise<void>}
 */
async function clearAuth(serverName) {
    const config = getConfig();
    const servers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];
    const existingIndex = servers.findIndex(s => s && s.name === serverName);

    if (existingIndex >= 0) {
        const server = { ...servers[existingIndex] };
        delete server.oauth;
        servers[existingIndex] = server;
        config.mcpServers = servers;
        saveConfig(config);
        console.log(`[MCP-OAuth] Auth cleared for '${serverName}'`);
    }
}

/**
 * Create and start an HTTP callback server for handling OAuth redirects.
 *
 * The server listens on the specified port and uses handleAuthCallback
 * for all incoming requests. Returns the server instance and a promise
 * that resolves when the server is ready.
 *
 * @param {number} port - Port to listen on
 * @returns {Promise<http.Server>} The HTTP server instance
 */
function createCallbackServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                await handleAuthCallback(req, res);
            } catch (err) {
                console.error(`[MCP-OAuth] Callback handler error: ${err.message}`);
                sendCallbackResponse(res, false, 'Internal error processing authentication callback.');
            } finally {
                // Close the server after handling one callback
                server.close(() => {
                    console.log(`[MCP-OAuth] Callback server on port ${port} closed.`);
                });
            }
        });

        server.listen(port, '127.0.0.1', () => {
            console.log(`[MCP-OAuth] Callback server listening on 127.0.0.1:${port}`);
            resolve(server);
        });

        server.on('error', (err) => {
            console.error(`[MCP-OAuth] Failed to start callback server: ${err.message}`);
            reject(err);
        });
    });
}

/**
 * Send an HTML response to the browser after OAuth callback processing.
 *
 * @param {http.ServerResponse} res - HTTP response object
 * @param {boolean} success - Whether authentication was successful
 * @param {string} message - Message to display to the user
 */
function sendCallbackResponse(res, success, message) {
    const status = success ? 'Success' : 'Error';
    const color = success ? '#4CAF50' : '#f44336';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Authentication ${status}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
        .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 480px; }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 24px; margin: 0 0 8px 0; color: ${color}; }
        p { color: #666; margin: 0; line-height: 1.5; }
        .badge { display: inline-block; background: ${color}; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-top: 16px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">${success ? '✅' : '❌'}</div>
        <h1>${status}</h1>
        <p>${escapeHtml(message)}</p>
        <div class="badge">MCP OAuth</div>
    </div>
    <script>window.close();</script>
</body>
</html>`;

    res.writeHead(success ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(html);
}

/**
 * Minimal HTML entity escape for safe rendering in the response page.
 *
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = {
    startOAuthFlow,
    handleAuthCallback,
    getAuthHeaders,
    isOAuthRequired,
    saveToken,
    clearAuth,
    createCallbackServer,
    exchangeCodeForTokens,
    refreshAccessToken,
    readStoredToken,
};
