/**
 * background-review.js — Post-turn memory extraction that runs asynchronously
 * after each conversation turn. Uses the existing workbench text-only model
 * call (same provider, non-streaming) to extract durable knowledge without
 * blocking the main conversation.
 *
 * Extracts:
 *   - Long-term user/project facts → semantic memory
 *   - User corrections/preferences → learned guidelines
 *   - Reusable procedures → skills catalog
 *   - Conversation summaries → checkpoints
 */

const REVIEW_SYSTEM_PROMPT = `You are a background memory reviewer integrated into August AI Workbench. Review the most recent user message and assistant response, then extract durable knowledge that will improve future conversations.

Respond ONLY with valid JSON. Do not include markdown formatting, commentary, or explanations.

{
  "facts": ["string"],
  "guidelines": [{ "text": "string", "confidence": 0.0-1.0 }],
  "skills": [{ "name": "string", "description": "string", "trigger": "string", "instructions": "string" }],
  "checkpoints": [{ "topic": "string", "summary": "string" }]
}

RULES:
- facts: Long-term user/project facts (preferences, tech stack, architecture decisions). Only extract what will still be true next week.
- guidelines: Specific coding/workflow rules the user stated or strongly implied. Set confidence based on explicitness (1.0 = explicit command, 0.5 = implied preference).
- skills: Only extract when the assistant demonstrated a clear reusable procedure (≥3 steps). Include trigger conditions and full instructions.
- checkpoints: One entry summarizing the current topic. Always include if the conversation is substantive.
- Return empty arrays when nothing to extract.
- Keep fact/guideline text concise (under 200 chars each).`;

/**
 * Run a background review of a conversation turn. Non-blocking — failures
 * are logged and swallowed.
 *
 * @param {string} userText - The user's message text
 * @param {string|object} assistantContent - The assistant's response (text or content blocks)
 * @param {string} sessionId - Workbench session ID
 * @param {Array} messages - Full conversation messages array
 * @param {object} session - Workbench session object (for callWorkbenchTextOnlyModel)
 */
async function spawnBackgroundReview(userText, assistantContent, sessionId, messages, session) {
    const assistantText = extractAssistantText(assistantContent);

    // Guard: both sides must have content
    if (!userText || userText.trim().length < 10) return;
    if (!assistantText || assistantText.length < 10) return;

    try {
        const { callWorkbenchTextOnlyModel } = require('../workbench/workbench');
        const reviewPrompt = buildReviewPrompt(userText, assistantText, messages);
        const response = await callWorkbenchTextOnlyModel(session, {
            system: REVIEW_SYSTEM_PROMPT,
            user: reviewPrompt,
            maxTokens: 512
        });

        const extracted = parseReviewResponse(response);
        if (!extracted) return;

        await persistExtractions(extracted, sessionId);
    } catch (err) {
        console.warn('[BackgroundReview] Review failed:', err.message);
    }
}

/**
 * Build the user portion of the review prompt.
 */
function buildReviewPrompt(userText, assistantText, messages) {
    const recentContext = messages
        .slice(-6)
        .map(m => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            const text = extractAssistantText(m.content || m);
            return text ? `${role}: ${text.slice(0, 500)}` : null;
        })
        .filter(Boolean)
        .join('\n\n');

    return [
        '### Recent conversation context\n',
        recentContext,
        '\n### Last user message\n',
        userText.slice(0, 1000),
        '\n### Assistant response\n',
        assistantText.slice(0, 2000),
        '\n\nExtract durable knowledge from this conversation turn.'
    ].join('\n');
}

/**
 * Parse the model's JSON response. Returns null on failure.
 */
function parseReviewResponse(raw) {
    if (!raw) return null;

    // Strip markdown fences if present
    let cleaned = raw.trim();
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) cleaned = jsonMatch[1].trim();

    // Find first { and last }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return {
            facts: Array.isArray(parsed.facts) ? parsed.facts : [],
            guidelines: Array.isArray(parsed.guidelines) ? parsed.guidelines : [],
            skills: Array.isArray(parsed.skills) ? parsed.skills : [],
            checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []
        };
    } catch {
        console.warn('[BackgroundReview] Failed to parse review response:', cleaned.slice(0, 200));
        return null;
    }
}

/**
 * Write extracted knowledge to the appropriate storage backends.
 */
async function persistExtractions(extracted, sessionId) {
    const results = { facts: 0, guidelines: 0, skills: 0, checkpoints: 0 };

    // Facts → semantic memory
    if (extracted.facts.length > 0) {
        try {
            const semanticMemory = require('./semantic-memory');
            for (const fact of extracted.facts) {
                const key = fact
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_|_$/g, '')
                    .slice(0, 80) || `fact_${Date.now()}`;
                semanticMemory.setFact(key, fact, 'background_review', null, sessionId, {
                    sourceType: 'background_review',
                    sourceSessionId: sessionId,
                    confidence: 0.5
                });
                results.facts++;
            }
        } catch (err) {
            console.warn('[BackgroundReview] Failed to save facts:', err.message);
        }
    }

    // Guidelines → learned guidelines (august_core_memory)
    if (extracted.guidelines.length > 0) {
        try {
            const { upsertLearnedGuideline } = require('./core-memory');
            for (const g of extracted.guidelines) {
                const text = typeof g === 'string' ? g : g.text;
                const confidence = typeof g === 'object' ? (g.confidence || 0.5) : 0.5;
                if (text && text.length > 5) {
                    upsertLearnedGuideline(text, {
                        source: 'background-review',
                        confidence,
                        status: 'pending'
                    });
                    results.guidelines++;
                }
            }
        } catch (err) {
            console.warn('[BackgroundReview] Failed to save guidelines:', err.message);
        }
    }

    // Skills → skills catalog
    if (extracted.skills.length > 0) {
        try {
            const skills = require('../tools/skills');
            for (const s of extracted.skills) {
                if (s.name && s.instructions && s.instructions.length > 20) {
                    skills.saveSkill({
                        name: s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64),
                        description: s.description || '',
                        trigger: s.trigger || '',
                        instructions: s.instructions
                    });
                    results.skills++;
                }
            }
        } catch (err) {
            console.warn('[BackgroundReview] Failed to save skills:', err.message);
        }
    }

    // Checkpoints → core memory checkpoints
    if (extracted.checkpoints.length > 0) {
        try {
            const { appendCheckpoint } = require('./core-memory');
            for (const cp of extracted.checkpoints) {
                if (cp.topic && cp.summary) {
                    appendCheckpoint({
                        topic: cp.topic,
                        summary: cp.summary,
                        timestamp: new Date().toISOString()
                    });
                    results.checkpoints++;
                }
            }
        } catch (err) {
            console.warn('[BackgroundReview] Failed to save checkpoints:', err.message);
        }
    }

    if (results.facts > 0 || results.guidelines > 0 || results.skills > 0 || results.checkpoints > 0) {
        console.log(`[BackgroundReview] Saved: ${results.facts} facts, ${results.guidelines} guidelines, ${results.skills} skills, ${results.checkpoints} checkpoints`);
    }
}

/**
 * Extract text from assistant content (handles string, Anthropic content blocks, etc.)
 */
function extractAssistantText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .filter(b => b && (b.type === 'text' || b.type === 'output_text'))
            .map(b => b.text || b.output_text || '')
            .join('\n')
            .trim();
    }
    if (content.content && Array.isArray(content.content)) {
        return extractAssistantText(content.content);
    }
    return '';
}

module.exports = { spawnBackgroundReview };
