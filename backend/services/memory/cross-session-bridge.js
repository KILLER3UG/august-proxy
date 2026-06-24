/**
 * cross-session-bridge.js — Links workbench sessions through shared memory.
 *
 * On session end:  summarizes the session and writes a checkpoint to core memory.
 * On session start: searches FTS for related sessions and injects recall block
 *                   via memory manager's prefetch path.
 *
 * Uses existing infrastructure: memory_fts FTS5 table, core memory checkpoints,
 * and the LLM summarization path.
 */

/**
 * Summarize and persist a completed session. Called from workbench session
 * lifecycle.
 * @param {string} sessionId - The session that just ended
 * @param {Array} messages - Full message array
 * @param {object} session - Session object (for LLM summarization)
 */
async function bridgeSessionEnd(sessionId, messages, session) {
  if (!messages || messages.length < 2) return;

  const userMsgs = messages.filter(m => m.role === 'user').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
  if (userMsgs < 1 || assistantMsgs < 1) return;

  try {
    // Extract a session summary via the LLM
    let summary;
    try {
      const { callWorkbenchTextOnlyModel } = require('../workbench/workbench');
      const transcript = messages
        .slice(-6)
        .map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          const text = extractText(m.content || '');
          return text ? `${role}: ${text.slice(0, 300)}` : null;
        })
        .filter(Boolean)
        .join('\n\n');

      summary = await callWorkbenchTextOnlyModel(session, {
        system: 'Summarize this conversation in 2-3 sentences. Include: what the user asked, what was discussed, and any decisions or action items.',
        user: transcript || 'No content.',
        maxTokens: 256
      });
    } catch {
      summary = `Session with ${userMsgs} user messages.`;
    }

    if (!summary || summary.trim().length < 5) return;

    // Persist as a checkpoint in core memory
    const { readAugustCoreMemory, writeAugustCoreMemory } = require('./core-memory');
    const { getMemoryManager } = require('./memory-manager');
    const memory = readAugustCoreMemory();
    if (!Array.isArray(memory.conversation_checkpoints)) {
      memory.conversation_checkpoints = [];
    }
    memory.conversation_checkpoints.push({
      topic: `Session ${sessionId.slice(0, 8)}`,
      summary: summary.trim().slice(0, 500),
      timestamp: new Date().toISOString(),
      sessionId
    });
    writeAugustCoreMemory(memory);

    // Notify memory providers
    try {
      getMemoryManager().notifyMemoryWrite('append', 'checkpoints', summary).catch(() => {});
    } catch {}
  } catch (err) {
    console.warn('[CrossSessionBridge] Session end error:', err.message);
  }
}

/**
 * Recall context from past sessions. Called from memory manager's prefetch
 * path at the start of a new turn.
 * @param {string} query - Current user query (for relevance search)
 * @param {string} sessionId - Current session ID
 * @returns {Promise<string>} - Recall text block (empty if nothing relevant)
 */
async function bridgeSessionStart(query, sessionId) {
  if (!query || query.trim().length < 5) return '';

  try {
    const { getFtsSearch } = require('./fts-search');
    const fts = getFtsSearch();

    // Try FTS5 first (checkpoints), then in-memory index
    let blocks = [];

    const sqliteResults = await fts.sqliteSearch(query, { maxResults: 3 });
    if (sqliteResults.length > 0) {
      blocks.push('<recall>');
      for (const r of sqliteResults) {
        blocks.push(`[${r.topic}] ${r.summary}`);
      }
      blocks.push('</recall>');
    }

    const inMemResults = await fts.search(query, { maxResults: 3, minScore: 0.15 });
    if (inMemResults.length > 0 && sqliteResults.length === 0) {
      blocks.push('<recall>');
      for (const r of inMemResults) {
        blocks.push(`[${r.session_id.slice(0, 8)}] ${r.snippets[0] || ''}`);
      }
      blocks.push('</recall>');
    }

    return blocks.join('\n');
  } catch (err) {
    console.warn('[CrossSessionBridge] Session start error:', err.message);
    return '';
  }
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b && (b.type === 'text' || b.type === 'output_text'))
      .map(b => b.text || b.output_text || '')
      .join('\n')
      .trim();
  }
  return '';
}

module.exports = { bridgeSessionEnd, bridgeSessionStart };
