/**
 * session-tools.js — Session search and management tools.
 * Provides:
 * - august__search_sessions: FTS5 search across past sessions
 * - august__get_session: Get session details with optional messages
 * - august__list_sessions: List recent sessions with filters
 *
 * All tools safely handle when the session store is not initialized.
 */

const { z } = require('zod');

// ── Session Store Access ──

let _sessionStoreModule = null;
let _sessionStoreError = null;

function getSessionStore() {
  if (_sessionStoreModule) return _sessionStoreModule;
  try {
    _sessionStoreModule = require(require('path').join(__dirname, '..', 'storage', 'session-store'));
    return _sessionStoreModule;
  } catch (e) {
    _sessionStoreError = e.message;
    return null;
  }
}

function isSessionStoreAvailable() {
  const store = getSessionStore();
  if (!store) return false;
  try {
    return store.isReady ? store.isReady() : false;
  } catch (e) {
    return false;
  }
}

// ── Tool: august__search_sessions ──

const SEARCH_SESSIONS_SCHEMA = z.object({
  query: z.string().min(1).describe('Search query for full-text search across session messages and titles'),
  limit: z.number().int().min(1).max(100).optional().default(10).describe('Maximum number of results to return')
});

async function searchSessionsHandler(args) {
  const { query, limit } = args;

  if (!isSessionStoreAvailable()) {
    return {
      error: 'Session store is not available or not initialized.',
      note: 'The session store may need to be initialized first, or no sessions database exists yet.',
      results: [],
      count: 0
    };
  }

  try {
    const store = getSessionStore();
    if (typeof store.searchSessions === 'function') {
      const results = store.searchSessions(query, { limit: limit || 10 });
      if (!results || results.length === 0) {
        return { results: [], count: 0, query, message: 'No matching sessions found.' };
      }

      const sessions = results.map(r => ({
        id: r.id,
        title: r.title || '',
        agent_type: r.agent_type || '',
        status: r.status || '',
        message_count: r.message_count || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        snippet: r.snippet || ''
      }));

      return { results: sessions, count: sessions.length, query };
    }

    // Fallback: try searching messages FTS
    if (typeof store.searchMessages === 'function') {
      const results = store.searchMessages(query, { limit: limit || 10 });
      if (!results || results.length === 0) {
        return { results: [], count: 0, query, message: 'No matching messages found.' };
      }

      // Group results by session
      const sessionMap = new Map();
      for (const msg of results) {
        if (!sessionMap.has(msg.session_id)) {
          const session = store.getSession(msg.session_id);
          sessionMap.set(msg.session_id, {
            id: msg.session_id,
            title: session ? session.title : 'Unknown',
            snippet: msg.snippet || msg.content?.slice(0, 200) || '',
            relevance: (msg.rank || 0)
          });
        }
      }

      const sessions = Array.from(sessionMap.values()).slice(0, limit || 10);
      return { results: sessions, count: sessions.length, query, search_type: 'messages_fts' };
    }

    return { error: 'Session search not available in the current session store implementation.', results: [], count: 0 };
  } catch (e) {
    return { error: `Session search failed: ${e.message}`, results: [], count: 0 };
  }
}

// ── Tool: august__get_session ──

const GET_SESSION_SCHEMA = z.object({
  session_id: z.string().min(1).describe('The session ID to retrieve'),
  include_messages: z.boolean().optional().default(false).describe('Whether to include the session messages')
});

async function getSessionHandler(args) {
  const { session_id, include_messages } = args;

  if (!isSessionStoreAvailable()) {
    return { error: 'Session store is not available or not initialized.' };
  }

  try {
    const store = getSessionStore();

    if (typeof store.getSession !== 'function') {
      return { error: 'Session retrieval not available.' };
    }

    const session = store.getSession(session_id);
    if (!session) {
      return { error: `Session "${session_id}" not found.`, found: false };
    }

    const result = {
      found: true,
      session: {
        id: session.id,
        title: session.title || '',
        agent_type: session.agent_type || '',
        provider: session.provider || '',
        model: session.model || '',
        status: session.status || '',
        cwd: session.cwd || '',
        task: session.task || '',
        parent_id: session.parent_id || null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        ended_at: session.ended_at || null,
        end_reason: session.end_reason || null,
        message_count: session.message_count || 0,
        tool_call_count: session.tool_call_count || 0,
        total_tokens: session.total_tokens || 0,
        total_cost: session.total_cost || 0,
        metadata: session.metadata || {}
      }
    };

    if (include_messages && typeof store.getMessages === 'function') {
      const messages = store.getMessages(session_id, { limit: 200 });
      result.messages = (messages || []).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content?.slice(0, 5000) || '',
        tool_calls: m.tool_calls || [],
        tool_name: m.tool_name || '',
        finish_reason: m.finish_reason || '',
        token_count: m.token_count || 0,
        created_at: m.created_at
      }));
      result.message_count = result.messages.length;
    }

    return result;
  } catch (e) {
    return { error: `Failed to get session: ${e.message}`, found: false };
  }
}

// ── Tool: august__list_sessions ──

const LIST_SESSIONS_SCHEMA = z.object({
  status: z.string().optional().describe('Filter by session status (e.g., idle, running, completed, failed)'),
  limit: z.number().int().min(1).max(200).optional().default(20).describe('Maximum number of sessions to return'),
  agent_type: z.string().optional().describe('Filter by agent type (e.g., general, build)')
});

async function listSessionsHandler(args) {
  const { status, limit, agent_type } = args;

  if (!isSessionStoreAvailable()) {
    return { error: 'Session store is not available or not initialized.', sessions: [], count: 0 };
  }

  try {
    const store = getSessionStore();

    if (typeof store.listSessions === 'function') {
      const results = store.listSessions({
        status: status || undefined,
        agent_type: agent_type || undefined,
        limit: limit || 20,
        order: 'newest'
      });

      if (!results || results.length === 0) {
        return { sessions: [], count: 0, message: 'No sessions found matching the criteria.' };
      }

      const sessions = results.map(s => ({
        id: s.id,
        title: s.title || '',
        agent_type: s.agent_type || '',
        status: s.status || '',
        message_count: s.message_count || 0,
        tool_call_count: s.tool_call_count || 0,
        total_tokens: s.total_tokens || 0,
        created_at: s.created_at,
        updated_at: s.updated_at,
        ended_at: s.ended_at || null
      }));

      return { sessions, count: sessions.length };
    }

    return { error: 'Session listing not available.', sessions: [], count: 0 };
  } catch (e) {
    return { error: `Failed to list sessions: ${e.message}`, sessions: [], count: 0 };
  }
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__search_sessions',
    description: 'Full-text search across past session messages and titles using FTS5. Returns matching sessions with snippets. Automatically handles when the session store is not initialized.',
    schema: SEARCH_SESSIONS_SCHEMA,
    handler: searchSessionsHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F50D}',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'session', source: 'missing-tools' }
  },
  {
    name: 'august__get_session',
    description: 'Get detailed information about a specific session including optional messages. Returns metadata, status, token counts, and more.',
    schema: GET_SESSION_SCHEMA,
    handler: getSessionHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F4DC}',
    timeoutMs: 15000,
    requiresEnv: [],
    metadata: { category: 'session', source: 'missing-tools' }
  },
  {
    name: 'august__list_sessions',
    description: 'List recent sessions with optional filtering by status and agent type. Returns the most recently updated sessions first.',
    schema: LIST_SESSIONS_SCHEMA,
    handler: listSessionsHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F4D1}',
    timeoutMs: 10000,
    requiresEnv: [],
    metadata: { category: 'session', source: 'missing-tools' }
  }
];

// ── Registration helper ──

function registerSessionTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerSessionTools,
  searchSessionsHandler,
  getSessionHandler,
  listSessionsHandler,
  isSessionStoreAvailable
};
