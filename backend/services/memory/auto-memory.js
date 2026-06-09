const { readAugustCoreMemory, writeAugustCoreMemory } = require('../tools/august-tools');

/**
 * Extract plain text from a message content field.
 * Handles string content, Anthropic content arrays [{type:'text',text:'...'}],
 * and OpenAI content arrays [{type:'text',text:'...'}].
 * Strips images, tool_use, thinking blocks, etc.
 */
function extractTextFromContent(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .filter(b => b && (b.type === 'text' || b.type === 'output_text'))
        .map(b => b.text || '')
        .join('\n')
        .trim();
}

/**
 * Extract just the text from an assistant response object.
 * Handles both Anthropic format ({content:[...]}) and OpenAI format ({choices:[...]}).
 */
function extractAssistantText(assistantContent) {
    if (typeof assistantContent === 'string') return assistantContent.trim();
    if (!assistantContent || typeof assistantContent !== 'object') return '';

    // Anthropic format: { content: [{ type: 'text', text: '...' }, { type: 'thinking', ... }] }
    if (Array.isArray(assistantContent.content)) {
        return assistantContent.content
            .filter(b => b && b.type === 'text')
            .map(b => b.text || '')
            .join('\n')
            .trim();
    }

    // OpenAI format: { choices: [{ message: { content: '...' } }] }
    const choice = assistantContent.choices?.[0];
    if (choice?.message?.content) {
        return extractTextFromContent(choice.message.content);
    }

    return '';
}

const fs = require('fs');
const path = require('path');
const debugLogPath = path.join(__dirname, 'debug.txt');
const semanticMemory = require('./semantic-memory');
const { upsertLearnedGuideline } = require('./learned-guidelines');
const _origLog = console.log;
const _origWarn = console.warn;

console.log = function(...args) {
    if (typeof args[0] === 'string' && args[0].includes('[Auto-Memory]')) {
        try { fs.appendFileSync(debugLogPath, new Date().toISOString() + ' LOG: ' + args.join(' ') + '\n'); } catch(e){}
    }
    _origLog.apply(console, args);
};

console.warn = function(...args) {
    if (typeof args[0] === 'string' && args[0].includes('[Auto-Memory]')) {
        try { fs.appendFileSync(debugLogPath, new Date().toISOString() + ' WARN: ' + args.join(' ') + '\n'); } catch(e){}
    }
    _origWarn.apply(console, args);
};

function looksLikeProviderAlias(model) {
    const value = String(model || '').trim().toLowerCase();
    return value.startsWith('claude-') || value.startsWith('gpt-');
}

function providerErrorFromData(data) {
    if (!data || typeof data !== 'object') return '';
    if (data.base_resp && Number(data.base_resp.status_code || 0) !== 0) {
        return data.base_resp.status_msg || `provider status ${data.base_resp.status_code}`;
    }
    if (data.error) {
        if (typeof data.error === 'string') return data.error;
        return data.error.message || JSON.stringify(data.error);
    }
    return '';
}

function extractModelJsonText(data) {
    if (data?.choices?.[0]?.message) {
        return extractTextFromContent(data.choices[0].message.content);
    }
    if (data?.content?.[0]) {
        return data.content[0].text || '';
    }
    return '';
}

function cleanJsonPayload(text) {
    let cleanJsonStr = String(text || '').replace(/```json|```/gi, '').trim();
    cleanJsonStr = cleanJsonStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const firstBrace = cleanJsonStr.indexOf('{');
    const lastBrace = cleanJsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
        cleanJsonStr = cleanJsonStr.slice(firstBrace, lastBrace + 1);
    }
    return cleanJsonStr;
}

function resolveMemoryExtractionModel(cfg, upstreamModel, isAnthropicNative, targetUrl) {
    const configured = cfg.memoryExtractionModel || cfg.memoryModel;
    let model = configured || upstreamModel || cfg._upstreamModel || cfg.currentModel || 'MiniMax-M2.7';
    const isMiniMaxOpenAiCompat = !isAnthropicNative && String(targetUrl || '').includes('minimax');
    if (isMiniMaxOpenAiCompat && looksLikeProviderAlias(model)) {
        model = configured || 'MiniMax-M2.7';
    } else if (!isAnthropicNative && looksLikeProviderAlias(model)) {
        model = configured || (!looksLikeProviderAlias(cfg._upstreamModel) ? cfg._upstreamModel : null) || 'MiniMax-M2.7';
    }
    return model || 'MiniMax-M2.7';
}

function summarizeSnippet(text, maxLength = 180) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function fallbackExtraction(textOnlyMessages, assistantText, reason) {
    const lastUserText = textOnlyMessages[textOnlyMessages.length - 1]?.content || '';
    const topic = summarizeSnippet(lastUserText, 64) || 'Conversation checkpoint';
    const summary = [
        summarizeSnippet(lastUserText, 160),
        summarizeSnippet(assistantText, 180)
    ].filter(Boolean).join(' | ');

    return {
        add_facts: [],
        delete_facts: [],
        conversation_summary: {
            topic,
            summary: summary || `Auto-memory fallback checkpoint because extraction failed: ${reason || 'unknown'}`
        },
        semantic_facts: [],
        learned_guidelines: [],
        _fallbackReason: reason || 'provider unavailable'
    };
}

async function saveCheckpointToVectorDb(cfg, topic, summary) {
    const { saveCheckpointWithEmbedding } = require('./vector-db');
    let embeddingsUrl = cfg.targetUrl;
    if (embeddingsUrl && embeddingsUrl.includes('/anthropic')) {
        embeddingsUrl = embeddingsUrl.replace('/anthropic/v1/messages', '/v1/embeddings').replace('/anthropic', '/v1/embeddings');
    } else if (embeddingsUrl && embeddingsUrl.includes('/v1/')) {
        embeddingsUrl = embeddingsUrl.substring(0, embeddingsUrl.indexOf('/v1/') + 4) + 'embeddings';
    } else {
        embeddingsUrl = null;
    }

    const textToEmbed = `Topic: ${topic}\nSummary: ${summary}`;
    const fallbackSave = (reason) => {
        const saved = saveCheckpointWithEmbedding(topic, summary, null, {
            embeddingSource: `local-fallback:${summarizeSnippet(reason, 80) || 'embedding unavailable'}`
        });
        console.warn(`[Auto-Memory] Saved checkpoint with local vector fallback: ${reason}`);
        return saved;
    };

    if (!embeddingsUrl) return fallbackSave('embedding endpoint unavailable');

    try {
        const embedHeaders = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) {
            embedHeaders['Authorization'] = `Bearer ${cfg.apiKey}`;
            embedHeaders['x-api-key'] = cfg.apiKey;
        }

        const isMiniMaxEmbed = embeddingsUrl.includes('minimax');
        const embedModel = cfg.embeddingModel || (isMiniMaxEmbed ? 'embo-01' : 'text-embedding-3-small');
        const embedPayload = isMiniMaxEmbed
            ? { model: embedModel, texts: [textToEmbed], type: 'query' }
            : { model: embedModel, input: textToEmbed };

        const embedResponse = await fetch(embeddingsUrl, {
            method: 'POST',
            headers: embedHeaders,
            body: JSON.stringify(embedPayload),
            signal: AbortSignal.timeout(10000)
        });

        const raw = await embedResponse.text();
        if (!embedResponse.ok) {
            return fallbackSave(`HTTP ${embedResponse.status} ${raw.slice(0, 120)}`);
        }

        let embedData = {};
        try { embedData = JSON.parse(raw); } catch (e) {
            return fallbackSave(`embedding JSON parse failed: ${e.message}`);
        }

        const providerError = providerErrorFromData(embedData);
        if (providerError) return fallbackSave(providerError);

        const vector = isMiniMaxEmbed ? embedData.vectors?.[0] : embedData.data?.[0]?.embedding;
        if (!Array.isArray(vector)) return fallbackSave('provider returned no embedding vector');

        saveCheckpointWithEmbedding(topic, summary, vector, { embeddingSource: 'provider' });
        console.log(`[Auto-Memory] ✓ Saved checkpoint to Infinite Vector Database.`);
    } catch (err) {
        fallbackSave(err.message);
    }
}

/**
 * Fires asynchronously at the end of a successful conversation turn.
 * Extracts persistent facts from the conversation and saves them to August Core Memory.
 */
async function extractAndSaveMemories(userMessages, assistantContent, cfg, upstreamModel, clientId) {
    try {
        const memory = readAugustCoreMemory();
        const currentContext = memory.global_context || "No cross-session context established.";
        
        // Grab the last 2 user messages, extract only text (strip images/files)
        const recentUserMsgs = (userMessages || []).filter(m => m.role === 'user').slice(-2);
        if (recentUserMsgs.length === 0) {
            console.log('[Auto-Memory] Skipped: no user messages found in conversation');
            return;
        }

        const textOnlyMessages = recentUserMsgs.map(m => {
            console.log(`[Auto-Memory] Raw user message content: ${JSON.stringify(m.content)}`);
            return {
                role: 'user',
                content: extractTextFromContent(m.content)
            };
        }).filter(m => m.content.length > 0);

        if (textOnlyMessages.length === 0) {
            console.log('[Auto-Memory] Skipped: user messages contained no text (images/files only)');
            return;
        }

        // Extract just the text from the assistant response (strip thinking, metadata)
        const assistantText = extractAssistantText(assistantContent);
        if (!assistantText || assistantText.length < 10) {
            console.log('[Auto-Memory] Skipped: assistant response too short or empty');
            return;
        }

        console.log(`[Auto-Memory] Starting extraction... (${textOnlyMessages.length} user msgs, ${assistantText.length} chars assistant text, model=${upstreamModel})`);

        // Retrieve current semantic facts to inject in the prompt for deduplication
        const semanticFactsText = semanticMemory.getAllFacts()
            .map(f => `- ${f.key} (${f.category}): ${f.value}`)
            .join('\n');
        const systemPrompt = `You are a background Memory Extractor for a personal AI assistant.
Your job is to read the latest user message and the assistant response and extract:
1. Core Memory Facts: Long-term, persistent facts about the user, their projects, their tech stack, or their preferences.
2. Semantic Facts: Structured key-value properties describing user preferences, details, projects, or workflow rules.
3. Conversation Checkpoint: A brief summary of what is happening in this conversation turn.
4. Learned Guidelines: Persistent coding/workflow instructions, rules, corrections, or developer habits learned dynamically from this turn (e.g. "always use const instead of var", "when pushing, run build first", "prefer async/await over promises"). Only extract rules that the user has explicitly stated, corrected, or clearly implied.

CURRENT CORE MEMORY:
${currentContext}

CURRENT SEMANTIC MEMORY:
${semanticFactsText || 'None recorded yet.'}

GUIDELINES FOR CORE & SEMANTIC FACTS:
- Only extract long-term, durable facts that will remain true next week (e.g. tech stack, preferences, project architecture, connected devices).
- DO NOT extract transient debugging info, line numbers, temporary variables, terminal command lines, package versions, or compilation error messages. Route active task context *exclusively* to the conversation checkpoint.
- Perform semantic deduplication: if a fact is already represented in either CURRENT CORE MEMORY or CURRENT SEMANTIC MEMORY (even if phrased differently), DO NOT extract it.
- If the user contradicts a current fact, specify the old fact in "delete_facts" and the new fact in "add_facts".
- If no new facts are found, return empty arrays.
- Category for semantic facts must be one of: 'user_preference', 'user_detail', 'project_info', 'workflow_rule', 'session_temp'.
- For semantic facts, key must be a snake_case string (e.g. 'local_build_preference').

GUIDELINES FOR CONVERSATION CHECKPOINT:
- Always provide a 1-sentence summary of the current topic (unless it's just a greeting).
- Topic should be 2-5 words.
- Summary should be a high-level description of what the user is working on or discussing.

GUIDELINES FOR LEARNED GUIDELINES:
- Extract specific rules/instructions about coding styles, workflow steps, or agent behavior.
- Only extract rules that are generalizable across sessions (not specific to a single bug or file name).
- Deduplicate: do not extract rules that already exist in the user profile or current context.

Respond ONLY with valid JSON in this exact format:
{
  "add_facts": ["The user works on august-proxy project."],
  "delete_facts": ["The user works on hermes-desktop project."],
  "conversation_summary": {
    "topic": "Refactoring Memory System",
    "summary": "User is combining redundant LLM calls in auto-memory.js into a single unified request."
  },
  "semantic_facts": [
    {
      "key": "project_august_proxy",
      "value": "August Proxy is a persistent shared brain project.",
      "category": "project_info"
    }
  ],
  "learned_guidelines": [
    "Always run builds and linter tests before git push."
  ]
}`;

        // Determine the best endpoint to use from cfg
        let targetUrl = cfg.targetUrl;

        // Detect Anthropic-native endpoints that have no OpenAI-compatible alternative
        const isAnthropicNative = (
            targetUrl.includes('api.anthropic.com') ||
            (targetUrl.includes('/v1/messages') && !targetUrl.includes('/chat/completions') && !targetUrl.includes('minimax'))
        ) && !targetUrl.includes('/anthropic/v1/messages'); // Minimax wrapper handled below

        let response;
        if (isAnthropicNative) {
            console.log(`[Auto-Memory] Using Anthropic-native format -> ${targetUrl}`);
            const anthropicPayload = {
                model: upstreamModel || 'claude-sonnet-4-6',
                max_tokens: 500,
                temperature: 0.1,
                system: systemPrompt,
                messages: [
                    ...textOnlyMessages,
                    { role: 'assistant', content: assistantText },
                    { role: 'user', content: 'Extract memory now. Return ONLY raw JSON without markdown formatting.' }
                ]
            };
            const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
            if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

            response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(anthropicPayload),
                signal: AbortSignal.timeout(30000)
            });
        } else {
            // Rewrite to OpenAI-compatible endpoint
            if (targetUrl.includes('/anthropic/v1/messages')) {
                targetUrl = targetUrl.replace('/anthropic/v1/messages', targetUrl.includes('minimax') ? '/v1/text/chatcompletion_v2' : '/v1/chat/completions');
            } else if (targetUrl.includes('/anthropic')) {
                targetUrl = targetUrl.replace('/anthropic', '/v1/text/chatcompletion_v2');
            }
            console.log(`[Auto-Memory] Using OpenAI-compatible format -> ${targetUrl}`);

            // Ensure we never send fake Claude/GPT client aliases to OpenAI-compatible upstreams.
            const memModel = resolveMemoryExtractionModel(cfg, upstreamModel, isAnthropicNative, targetUrl);
            
            const payload = {
                model: memModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...textOnlyMessages,
                    { role: "assistant", content: assistantText },
                    { role: "user", content: "Extract memory now. Return ONLY raw JSON without markdown formatting. You MUST start your response IMMEDIATELY with the '{' character. Do not output any thinking or analysis text before the JSON object." }
                ],
                max_tokens: 1500,
                temperature: 0.1
            };

            const headers = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) {
                headers['Authorization'] = `Bearer ${cfg.apiKey}`;
                headers['x-api-key'] = cfg.apiKey;
            }

            response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000)
            });
        }

        let extracted;
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            const reason = `HTTP ${response.status}: ${errBody.slice(0, 200)}`;
            console.warn(`[Auto-Memory] Extraction API returned ${reason}. Using local fallback checkpoint.`);
            extracted = fallbackExtraction(textOnlyMessages, assistantText, reason);
        } else {
            const data = await response.json();
            const extractionProviderError = providerErrorFromData(data);
            if (extractionProviderError) {
                console.warn(`[Auto-Memory] Extraction provider error: ${extractionProviderError}. Using local fallback checkpoint.`);
                extracted = fallbackExtraction(textOnlyMessages, assistantText, extractionProviderError);
            } else {
                const jsonStr = extractModelJsonText(data);

                if (!jsonStr) {
                    console.log('[Auto-Memory] Extraction model returned empty content; using local fallback checkpoint.');
                    extracted = fallbackExtraction(textOnlyMessages, assistantText, 'empty extraction response');
                } else {
                    console.log(`[Auto-Memory] Raw extraction response: ${jsonStr.slice(0, 200)}`);
                    try {
                        extracted = JSON.parse(cleanJsonPayload(jsonStr));
                    } catch (parseErr) {
                        console.warn(`[Auto-Memory] Extraction JSON parse failed: ${parseErr.message}. Using local fallback checkpoint.`);
                        extracted = fallbackExtraction(textOnlyMessages, assistantText, parseErr.message);
                    }
                }
            }
        }
        
        let updatedContext = currentContext;
        let modified = false;

        if (extracted.delete_facts && Array.isArray(extracted.delete_facts) && extracted.delete_facts.length > 0) {
            let lines = updatedContext.split('\n');
            lines = lines.filter(line => !extracted.delete_facts.some(d => line.toLowerCase().includes(d.toLowerCase())));
            updatedContext = lines.join('\n');
            modified = true;
        }

        if (extracted.add_facts && Array.isArray(extracted.add_facts) && extracted.add_facts.length > 0) {
            for (const fact of extracted.add_facts) {
                if (!updatedContext.includes(fact)) {
                    updatedContext += (updatedContext ? '\n' : '') + `- ${fact}`;
                    modified = true;
                }
            }
        }

        let pendingGuidelines = 0;
        if (extracted.learned_guidelines && Array.isArray(extracted.learned_guidelines) && extracted.learned_guidelines.length > 0) {
            for (const rule of extracted.learned_guidelines) {
                const cleanedRule = typeof rule === 'string' ? rule.trim() : String(rule).trim();
                if (cleanedRule) {
                    const saved = upsertLearnedGuideline(cleanedRule, {
                        source: clientId || 'auto-memory',
                        confidence: 0.6,
                        status: 'pending'
                    });
                    if (saved?.status === 'pending') pendingGuidelines++;
                }
            }
        }

        if (extracted.conversation_summary && extracted.conversation_summary.topic && extracted.conversation_summary.summary) {
            if (!memory.conversation_checkpoints) memory.conversation_checkpoints = [];
            memory.conversation_checkpoints.push({
                topic: extracted.conversation_summary.topic,
                summary: extracted.conversation_summary.summary,
                timestamp: new Date().toISOString()
            });
            // Keep only the last 15 checkpoints in the core memory
            if (memory.conversation_checkpoints.length > 15) {
                memory.conversation_checkpoints.shift();
            }

            // --- VECTOR DB INTEGRATION ---
            await saveCheckpointToVectorDb(
                cfg,
                extracted.conversation_summary.topic,
                extracted.conversation_summary.summary
            );

            modified = true;
        }

        if (modified) {
            memory.global_context = updatedContext.trim() || "No cross-session context established.";
            writeAugustCoreMemory(memory);
            console.log(`[Auto-Memory] ✓ Background core memory extraction successful. Added ${extracted.add_facts?.length || 0} facts, deleted ${extracted.delete_facts?.length || 0} facts, queued ${pendingGuidelines} learned guideline(s) for review, added checkpoint: ${!!extracted.conversation_summary}.`);
        } else {
            console.log('[Auto-Memory] No new persistent core facts found in this turn.');
        }

        // Save semantic facts from unified payload
        if (extracted.semantic_facts && Array.isArray(extracted.semantic_facts) && extracted.semantic_facts.length > 0) {
            const sourceId = clientId || 'unknown';
            let semCount = 0;
            for (const fact of extracted.semantic_facts) {
                if (fact.key && fact.value) {
                    try {
                        semanticMemory.setFact(
                            fact.key,
                            fact.value,
                            fact.category || 'user_preference',
                            null,
                            sourceId
                        );
                        semCount++;
                    } catch (err) {
                        console.warn(`[Auto-Memory] Failed to save semantic fact ${fact.key}: ${err.message}`);
                    }
                }
            }
            if (semCount > 0) {
                console.log(`[Auto-Memory] ✓ Extracted and saved ${semCount} semantic facts (source: ${sourceId})`);
            }
        }

        try {
            const { indexCoreMemory } = require('./graph-memory');
            indexCoreMemory();
            console.log('[Auto-Memory] ✓ Synced extracted memory into local graph memory.');
        } catch (graphErr) {
            console.warn(`[Auto-Memory] Graph memory sync skipped: ${graphErr.message}`);
        }

    } catch (e) {
        console.warn('[Auto-Memory] Background extraction failed:', e.message);
        require('fs').appendFileSync(require('path').join(__dirname, 'debug.txt'), new Date().toISOString() + ' ERROR: ' + e.message + '\n' + e.stack + '\n');
    }
}

module.exports = { extractAndSaveMemories, extractTextFromContent, extractAssistantText };
