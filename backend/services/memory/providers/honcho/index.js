/**
 * honcho/index.js — Honcho memory provider (external cloud backend).
 *
 * Stores and retrieves conversational memory via the Honcho API.
 * Requires HONCHO_API_KEY env var.
 *
 * Endpoints (configurable):
 *   baseUrl: https://api.honcho.ai/v1 (default)
 *   session endpoint: POST /sessions
 *   turn endpoint: POST /sessions/{id}/turns
 *   context endpoint: GET /sessions/{id}/context
 */

const MemoryProvider = require('../../memory-provider');

const DEFAULT_BASE_URL = 'https://api.honcho.ai/v1';

class HonchoProvider extends MemoryProvider {
  constructor() {
    super('honcho');
    this._sessionId = '';
    this._apiKey = '';
    this._baseUrl = DEFAULT_BASE_URL;
    this._externalSessionId = null;
  }

  async isAvailable() {
    return !!process.env.HONCHO_API_KEY;
  }

  async initialize(sessionId, config = {}) {
    this._sessionId = sessionId || 'default';
    this._apiKey = process.env.HONCHO_API_KEY || config.apiKey || '';
    this._baseUrl = config.baseUrl || DEFAULT_BASE_URL;

    if (!this._apiKey) {
      console.warn('[HonchoProvider] No API key available');
      return;
    }

    // Create a session on Honcho
    try {
      const res = await fetch(`${this._baseUrl}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`
        },
        body: JSON.stringify({
          session_id: this._sessionId,
          metadata: {}
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const data = await res.json();
        this._externalSessionId = data.id || this._sessionId;
        console.log(`[HonchoProvider] Session created: ${this._externalSessionId}`);
      } else if (res.status === 409) {
        // Session already exists
        this._externalSessionId = this._sessionId;
        console.log(`[HonchoProvider] Session resumed: ${this._externalSessionId}`);
      } else {
        const err = await res.text().catch(() => '');
        console.warn(`[HonchoProvider] Session creation failed: ${res.status} ${err.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn('[HonchoProvider] Initialization failed:', err.message);
    }

    this._initialized = true;
  }

  systemPromptBlock() {
    if (!this._apiKey) return '';
    return '<provider name="honcho">\nHoncho memory cloud backend is connected.\n</provider>';
  }

  async prefetch(query, sessionId = '') {
    if (!this._apiKey || !this._externalSessionId) return '';

    try {
      const res = await fetch(
        `${this._baseUrl}/sessions/${this._externalSessionId}/context?query=${encodeURIComponent(query || '')}`,
        {
          headers: {
            'Authorization': `Bearer ${this._apiKey}`
          },
          signal: AbortSignal.timeout(5000)
        }
      );

      if (!res.ok) return '';

      const data = await res.json();
      if (!data || !data.context) return '';

      return `<user_model>\n${data.context}\n</user_model>`;
    } catch (err) {
      console.warn('[HonchoProvider] Prefetch failed:', err.message);
      return '';
    }
  }

  async syncTurn(userContent, assistantContent, sessionId, messages) {
    if (!this._apiKey || !this._externalSessionId) return;
    if (!userContent && !assistantContent) return;

    try {
      await fetch(`${this._baseUrl}/sessions/${this._externalSessionId}/turns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`
        },
        body: JSON.stringify({
          user: String(userContent || '').slice(0, 4000),
          assistant: typeof assistantContent === 'string'
            ? assistantContent.slice(0, 4000)
            : JSON.stringify(assistantContent).slice(0, 4000),
          metadata: { session_id: sessionId }
        }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      console.warn('[HonchoProvider] Sync turn failed:', err.message);
    }
  }

  async onSessionEnd(messages) {
    if (!this._apiKey || !this._externalSessionId) return;

    try {
      await fetch(`${this._baseUrl}/sessions/${this._externalSessionId}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`
        },
        signal: AbortSignal.timeout(10000)
      });
      console.log(`[HonchoProvider] Session closed: ${this._externalSessionId}`);
    } catch (err) {
      console.warn('[HonchoProvider] Session close failed:', err.message);
    }
  }
}

module.exports = HonchoProvider;
