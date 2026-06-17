const { getProfile, syncClaudePublicAlias } = require('../lib/config');
const { logActivity, endRequest, captureRequest, captureResponse, captureTokens, captureError } = require('../lib/logger');
const { applySelfHealToMessages } = require('../services/workbench/selfheal');
const { getModelContextWindow, saveModelContextWindow, loadModelContextWindow } = require('../lib/models');
const { estimateTokens, formatTokenCount } = require('../lib/tokens');
const { buildFriendlyRateLimitMessage, getRetryDelayMs, isRetryableStatus } = require('../lib/upstream');
const { executeManagedWebTool } = require('../services/tools/local-web');
const { getCoworkToolDefinitions } = require('../services/tools/cowork-tools');
const { validateToolArguments, buildValidationErrorToolMessage } = require('../services/workbench/validator');
const { recordToolFailure } = require('../services/memory/tool-failure-memory');
const { getBrainConfig } = require('../services/memory/brain-orchestrator');
const { sanitizeToolSchema } = require('../services/tools/mcp-client');
const { executeToolBatch } = require('../services/workbench/tool-executor');
const { isOpenAiToolCallParallelSafe, isAnthropicToolUseParallelSafe, parseOpenAiToolArgs } = require('../services/workbench/managed-tool-policy');
const { LlmAdapterBase } = require('./base');
const { resolveModelAlias, resolveModelAliasDetails } = require('../providers/model-list');
const { SseStreamParser } = require('./sse-parser');
const { classifyOpenAiToolCalls, classifyAnthropicToolUses, getToolNameFromOpenAiTool } = require('./tool-classification');
const { buildSystemBlocks: buildContextSystemBlocks, isMiniMaxTarget } = require('../services/memory/context-builder');
const {
    MANAGED_WEB_TOOL_NAMES,
    isManagedWebToolName,
    getManagedWebToolKind,
    getManagedAnthropicWebToolDefinitions,
    sanitizeAnthropicToolDefinition,
    dedupeAndCanonicalizeAnthropicTools,
    getCanonicalManagedAnthropicWebTools,
    getMcpToolDefinitions,
    getAugustToolDefinitions,
    openAiToAnthropicToolDefinition,
    anthropicToOpenAiToolDefinition,
    getCanonicalCoworkAnthropicTools,
    getCanonicalManagedAnthropicOpenAiWebTools: getCanonicalManagedOpenAiWebTools,
    getProxyOpenAiToolDefinitionsForAnthropic: getProxyOpenAiToolDefinitions,
    getToolDefinitionName,
    appendMissingAnthropicTools,
    appendMissingOpenAiTools,
    isProxyManagedLocalToolName,
    rememberManagedLocalToolDefinitions,
    buildClientToolGuidance,
    isBrowserAutomationToolName,
    getManagedWebLocalToolName,
    formatManagedWebResult,
    formatManagedToolResult,
    executeManagedProxyTool
} = require('./proxy-tools');

const CLAUDE_PUBLIC_MODEL_ALIAS = 'claude-opus-4-6';
const KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = new Set([
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6'
]);
const adapterBase = new LlmAdapterBase({ profileName: 'claude', logPrefix: 'Anthropic' });

/** True for Claude family model ids (claude-*) or the public alias names. */
function isClaudeFamilyModel(model) {
    if (typeof model !== 'string') return false;
    const lower = model.trim().toLowerCase();
    if (!lower) return false;
    if (lower.startsWith('claude-')) return true;
    if (KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES.has(model)) return true;
    return lower === 'sonnet' || lower === 'opus' || lower === 'best' || lower === 'opusplan';
}

function isMiniMaxModel(model) {
    return adapterBase.isMiniMaxModel(model);
}

function resolveClaudePublicModelAlias(requestedModel) {
    if (typeof requestedModel !== 'string') return CLAUDE_PUBLIC_MODEL_ALIAS;
    const normalized = requestedModel.trim();
    if (!normalized) return CLAUDE_PUBLIC_MODEL_ALIAS;
    const lowered = normalized.toLowerCase();
    if (lowered === 'sonnet' || lowered === 'sonnet[1m]') return 'claude-sonnet-4-6';
    if (lowered === 'opus' || lowered === 'opus[1m]' || lowered === 'best' || lowered === 'opusplan') return 'claude-opus-4-6';
    if (KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES.has(normalized)) return normalized;
    if (lowered.startsWith('claude-')) return normalized;
    return CLAUDE_PUBLIC_MODEL_ALIAS;
}

function resolveClaudeClientFacingModel(requestedModel) {
    if (typeof requestedModel === 'string') {
        const normalized = requestedModel.trim();
        if (normalized) return normalized;
    }
    return resolveClaudePublicModelAlias(requestedModel);
}

function resolveClaudeUpstreamConfig(profile, requestedAlias) {
    const publicAlias = resolveClaudePublicModelAlias(requestedAlias);
    const aliasTargets = profile?.aliasTargets && typeof profile.aliasTargets === 'object'
        ? profile.aliasTargets
        : null;
    const aliasRoute = aliasTargets?.[publicAlias];

    if (!aliasRoute || typeof aliasRoute !== 'object') {
        return {
            ...profile,
            publicModelAlias: publicAlias
        };
    }

    const resolved = {
        ...profile,
        publicModelAlias: publicAlias,
        currentModel: aliasRoute.currentModel || aliasRoute.model || profile.currentModel,
        targetUrl: aliasRoute.targetUrl || aliasRoute.url || profile.targetUrl,
        apiKey: aliasRoute.apiKey || profile.apiKey
    };

    if (aliasRoute.contextWindow !== undefined) resolved.contextWindow = aliasRoute.contextWindow;
    if (aliasRoute.contextModelId !== undefined) resolved.contextModelId = aliasRoute.contextModelId;

    return resolved;
}

function getClaudeBackendModel(profile, fallbackModel) {
    return profile?._upstreamModel || profile?.upstreamModel || profile?.currentModel || fallbackModel || 'unknown';
}

function shouldPreserveClaudeAliasForAnthropicUpstream(publicModelAlias) {
    return typeof publicModelAlias === 'string'
        && publicModelAlias.toLowerCase().startsWith('claude-');
}

function normalizeSystemBlocks(system) {
    if (!system) return [];
    if (typeof system === 'string') {
        return [{ type: 'text', text: system }];
    }
    if (Array.isArray(system)) {
        return system
            .filter(Boolean)
            .map(block => {
                if (typeof block === 'string') {
                    return { type: 'text', text: block };
                }
                if (block && typeof block === 'object') {
                    return block;
                }
                return { type: 'text', text: String(block) };
            });
    }
    return [{ type: 'text', text: String(system) }];
}

function systemBlocksToText(system) {
    return normalizeSystemBlocks(system)
        .map(block => {
            if (block.type === 'text') return block.text || '';
            return JSON.stringify(block);
        })
        .filter(Boolean)
        .join('\n');
}

function buildOpenAISystemPrompt(system) {
    const provided = systemBlocksToText(system);
    if (provided.length > 8000) {
        console.warn(`[Proxy System Prompt]: OpenAI system prompt is ${provided.length} chars — may be truncated by upstream model. Consider reducing system prompt size.`);
    } else {
        console.log(`[Proxy System Prompt]: OpenAI system prompt length=${provided.length} chars`);
    }
    return provided;
}

function buildAnthropicSystemBlocks(system) {
    const blocks = normalizeSystemBlocks(system);
    const totalChars = blocks.reduce((sum, b) => sum + (b.text || '').length, 0);
    if (totalChars > 8000) {
        console.warn(`[Proxy System Prompt]: Anthropic system blocks total ${totalChars} chars — may be truncated by upstream model.`);
    } else {
        console.log(`[Proxy System Prompt]: Anthropic system blocks total=${totalChars} chars`);
    }
    return blocks;
}

// ── Mid-session drift prevention ──
// After ~50K tokens of context LLMs start ignoring system prompt rules.
// Inject a brief rule reminder into the message stream every 8 tool-result turns.
const AUGUST_REMINDER = {
    role: 'user',
    content: '[AUGUST] ' +
             'Remember the AUGUST personality contract: address the user as "Sir", be direct and concise, ' +
             'use semantic memory tools for durable facts, signal completion with "Done, Sir." ' +
             'Continue the same reasoning chain across tool rounds.'
};

const RULE_REMINDER_MESSAGE = {
    role: 'user',
    content: '[SYSTEM REMINDER] Continue the same reasoning chain across tool rounds. ' +
             'Explore first, present a plan and wait for explicit user approval before mutating changes, use PowerShell on Windows, ' +
             'and verify concrete results instead of guessing.'
};

const CLAUDE_CODE_NATIVE_TOOL_NAMES = new Set([
    'Agent',
    'Task',
    'Bash',
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'Glob',
    'Grep',
    'LS',
    'TodoWrite'
]);

const CLAUDE_CODE_NATIVE_GUARD = [
    '[CLAUDE CODE / NATIVE SUBAGENT GUARD]',
    'You are running through August Proxy with Claude Code-style native tools.',
    'Read-only exploration is allowed. TodoWrite/todo updates are internal task state and must not be described as project file updates.',
    'Before using any native mutating tool or command that can change system state (Bash with non-read-only commands, Write, Edit, MultiEdit, NotebookEdit, file-changing MCP tools, skill/plugin/MCP imports, installs, deletes, moves, background processes), first present a concise implementation plan and wait for explicit user approval in chat.',
    'If approval is missing, do not call the mutating tool. Stop and ask the user to approve the plan.',
    'For subagent exploration tasks, report concrete evidence: files read, commands/tools used, key findings, and limits or uncertainty. Do not claim broad understanding unless the files actually read support it.',
    'When the task is read-only, say explicitly that no project files were changed.'
].join('\n');

function getToolNames(tools) {
    return (Array.isArray(tools) ? tools : [])
        .map(tool => tool?.name || tool?.function?.name || '')
        .filter(Boolean);
}

function hasClaudeCodeNativeTooling(tools) {
    return getToolNames(tools).some(name => CLAUDE_CODE_NATIVE_TOOL_NAMES.has(name));
}

function buildClaudeCodeNativeGuidance(tools) {
    return hasClaudeCodeNativeTooling(tools) ? CLAUDE_CODE_NATIVE_GUARD : '';
}

function appendTextToSystemBlocks(system, text) {
    if (!text) return system;
    const blocks = normalizeSystemBlocks(system);
    const firstTextBlock = blocks.find(block => block?.type === 'text');
    if (firstTextBlock) {
        firstTextBlock.text = `${firstTextBlock.text || ''}\n\n---\n\n${text}`.trim();
        return blocks;
    }
    return [{ type: 'text', text }, ...blocks];
}

function countToolResultTurns(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.filter(m =>
        m.role === 'tool' ||
        (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))
    ).length;
}

function shouldInjectReminderMessage(messages) {
    const toolTurns = countToolResultTurns(messages);
    // Inject after every 8 tool-result turns (but not at zero)
    return toolTurns > 0 && toolTurns % 8 === 0;
}

function shouldInjectAugustReminder(messages) {
    const toolTurns = countToolResultTurns(messages);
    // Inject August personality reminder every 16 turns
    return toolTurns > 0 && toolTurns % 16 === 0;
}

function extractToolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text') return part.text || '';
                return JSON.stringify(part);
            })
            .join('\n');
    }
    if (content && typeof content === 'object' && content.type === 'text') {
        return content.text || '';
    }
    return String(content || '');
}

function shouldRepairManagedWebToolResult(toolName, content) {
    if (!isManagedWebToolName(toolName)) return false;
    const text = extractToolResultText(content).toLowerCase();
    if (!text) return false;
    return (
        text.includes('access to this website is blocked by your network egress settings') ||
        text.includes('only 127.0.0.1 is allowed access') ||
        text.includes('only allows localhost') ||
        text.includes('blocked for external domains') ||
        text.includes("wasn't able to fetch") ||
        text.includes('failed to fetch')
    );
}

async function repairManagedWebToolResults(anthropicMessages) {
    if (!Array.isArray(anthropicMessages) || anthropicMessages.length === 0) {
        return { messages: anthropicMessages, repairedCount: 0 };
    }

    const repairedMessages = [];
    const toolUseById = new Map();
    let repairedCount = 0;

    for (const message of anthropicMessages) {
        const clonedMessage = message && typeof message === 'object'
            ? {
                ...message,
                content: Array.isArray(message.content)
                    ? message.content.map(block => (block && typeof block === 'object' ? { ...block } : block))
                    : message.content
            }
            : message;

        if (Array.isArray(clonedMessage?.content)) {
            for (const block of clonedMessage.content) {
                if (block?.type === 'tool_use' && block.id) {
                    toolUseById.set(block.id, {
                        name: block.name,
                        input: block.input || {}
                    });
                }
            }

            for (const block of clonedMessage.content) {
                if (block?.type !== 'tool_result' || !block.tool_use_id) continue;

                const priorToolUse = toolUseById.get(block.tool_use_id);
                const toolName = priorToolUse?.name;
                if (!toolName || !shouldRepairManagedWebToolResult(toolName, block.content)) continue;

                try {
                    const repairedResult = await executeManagedWebTool(
                        getManagedWebLocalToolName(toolName),
                        priorToolUse.input || {}
                    );
                    block.content = formatManagedWebResult(repairedResult);
                    repairedCount += 1;
                    logActivity('WEB', `${toolName} tool_result repaired locally after client-side fetch failure`);
                } catch (error) {
                    console.warn(`[Proxy Web Repair]: Failed to repair ${toolName} result locally:`, error.message);
                }
            }
        }

        repairedMessages.push(clonedMessage);
    }

    return { messages: repairedMessages, repairedCount };
}

// ── Parse SSE stream into a complete Chat Completions JSON object ──
function parseSSEToJSON(sseText) {
    return adapterBase.parseOpenAIChatSSE(sseText);
}

// ── Parse native Anthropic SSE stream into a complete Anthropic JSON object ──
function parseAnthropicSSEToJSON(sseText) {
    const lines = sseText.split('\n');
    let id = '';
    let model = '';
    let role = 'assistant';
    let content = [];
    let stop_reason = null;
    let stop_sequence = null;
    let usage = { input_tokens: 0, output_tokens: 0 };

    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
            const evt = JSON.parse(jsonStr);
            if (evt.type === 'message_start' && evt.message) {
                id = evt.message.id;
                model = evt.message.model;
                role = evt.message.role;
                if (evt.message.usage) {
                    usage.input_tokens = evt.message.usage.input_tokens || 0;
                    usage.output_tokens = evt.message.usage.output_tokens || 0;
                }
            } else if (evt.type === 'content_block_start' && evt.content_block) {
                const block = { type: evt.content_block.type };
                if (block.type === 'text') block.text = evt.content_block.text || '';
                if (block.type === 'thinking') block.thinking = evt.content_block.thinking || '';
                if (block.type === 'tool_use') {
                    block.id = evt.content_block.id;
                    block.name = evt.content_block.name;
                    block.input = evt.content_block.input || {};
                }
                content[evt.index] = block;
            } else if (evt.type === 'content_block_delta' && evt.delta) {
                const block = content[evt.index];
                if (block) {
                    if (evt.delta.type === 'text_delta') block.text = (block.text || '') + (evt.delta.text || '');
                    if (evt.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + (evt.delta.thinking || '');
                    if (evt.delta.type === 'input_json_delta') {
                        // For simplicity, we store the raw string delta and parse it at the end
                        block._input_delta = (block._input_delta || '') + (evt.delta.partial_json || '');
                    }
                }
            } else if (evt.type === 'message_delta' && evt.delta) {
                if (evt.delta.stop_reason) stop_reason = evt.delta.stop_reason;
                if (evt.delta.stop_sequence) stop_sequence = evt.delta.stop_sequence;
                if (evt.usage) {
                    usage.output_tokens = usage.output_tokens || evt.usage.output_tokens || 0;
                }
            }
        } catch (e) { /* ignore parse errors */ }
    }

    // Post-process content blocks
    content = content.filter(Boolean).map(block => {
        if (block._input_delta) {
            try { block.input = JSON.parse(block._input_delta); }
            catch (e) { block.input = {}; }
            delete block._input_delta;
        }
        return block;
    });

    return {
        id,
        type: 'message',
        role,
        content,
        model,
        stop_reason,
        stop_sequence,
        usage
    };
}

// ── Deterministic bidirectional tool ID mapping (no global state) ──
// We encode the OpenAI call_id into the Anthropic tool_use_id using base64url,
// so we can decode it back on the next turn without any shared maps.
function getAnthropicId(openaiId) {
    if (!openaiId) return 'toolu_' + Math.random().toString(36).substring(2, 14);
    const encoded = Buffer.from(openaiId).toString('base64url');
    return 'toolu_' + encoded;
}

function getOpenAIId(anthropicId) {
    if (!anthropicId || !anthropicId.startsWith('toolu_')) return null;
    const encoded = anthropicId.slice(6); // strip 'toolu_'
    try {
        return Buffer.from(encoded, 'base64url').toString('utf8');
    } catch (e) {
        return null;
    }
}

// ── Tool definition translation ──
function translateTools(anthropicTools, ctx) {
    if (!anthropicTools) return undefined;
    const translated = anthropicTools.map(t => {
        // Claude Code tools are passed through as-is
        return {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: sanitizeToolSchema(t.input_schema),
                strict: t.strict
            }
        };
    });
    const injected = appendMissingOpenAiTools(translated, [
        ...getCoworkToolDefinitions(),
        ...getCanonicalManagedOpenAiWebTools()
    ]);
    if (injected.length > 0) {
        console.log('[Proxy Tools]: Injected OpenAI-compatible proxy tools:', injected);
    }
    rememberManagedLocalToolDefinitions(translated, ctx);
    ctx.lastKnownTools = translated;
    return translated;
}

function convertThinkingBlockToReasoningDetail(block, index) {
    if (!block || block.type !== 'thinking' || !block.thinking) return null;
    const detail = {
        type: 'reasoning.text',
        text: block.thinking
    };
    if (block.id !== undefined) detail.id = block.id;
    if (block.index !== undefined) detail.index = block.index;
    else detail.index = index;
    if (block.format !== undefined) detail.format = block.format;
    if (block.signature !== undefined) detail.signature = block.signature;
    return detail;
}

function convertReasoningDetailToThinkingBlock(detail, index) {
    if (!detail || typeof detail !== 'object') return null;
    const thinkingText = detail.text || detail.thinking || '';
    if (!thinkingText) return null;
    const block = {
        type: 'thinking',
        thinking: thinkingText
    };
    if (detail.id !== undefined) block.id = detail.id;
    if (detail.index !== undefined) block.index = detail.index;
    else block.index = index;
    if (detail.format !== undefined) block.format = detail.format;
    if (detail.signature !== undefined) block.signature = detail.signature;
    return block;
}

function sanitizeMessagesForOpenAIUpstream(messages, backendModel, targetUrl) {
    const isMiniMax = isMiniMaxTarget({ model: backendModel, targetUrl });
    return (messages || []).map(message => {
        if (!message || typeof message !== 'object') return message;
        const sanitized = { ...message };
        if (!isMiniMax) {
            delete sanitized.reasoning;
            delete sanitized.reasoning_content;
            delete sanitized.reasoning_details;
        }
        return sanitized;
    });
}

async function executeManagedToolCalls(toolCalls, knownTools, requestPayload, workspacePath = null, onToolEvent = null, parentSignal = null) {
    const executeOne = async (toolCall) => {
        const toolName = toolCall?.function?.name;

        // ── Validate arguments against schema BEFORE execution ──
        // If invalid, feed the error back as a tool message so M2.7 can self-correct.
        // We pass 'messages' to allow the validator to enforce the plan.md gate.
        const validation = validateToolArguments(toolCall, knownTools, requestPayload ? requestPayload.messages : []);
        if (!validation.valid) {
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolCall.id, error: validation.error, status: 'error', duration: 0 });
            console.warn(`[Proxy Validator]: Tool call '${toolName}' rejected:`, validation.error);
            return buildValidationErrorToolMessage(toolCall.id, toolName, validation.error);
        }

        const parsedArgs = parseOpenAiToolArgs(toolCall);
        const contextStr = parsedArgs && typeof parsedArgs === 'object'
            ? Object.entries(parsedArgs).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
            : '';
        if (onToolEvent) onToolEvent({ type: 'tool_call', name: toolName, context: contextStr, id: toolCall.id, status: 'running' });

        const startTime = Date.now();
        try {
            let result;
            result = await executeManagedProxyTool(toolName, parsedArgs, workspacePath, (progressText) => {
                if (onToolEvent) {
                    onToolEvent({ type: 'tool_progress', name: toolName, id: toolCall.id, preview: progressText });
                }
            }, parentSignal);
            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolCall.id, summary: String(result).substring(0, 2000), status: 'done', duration });

            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: formatManagedToolResult(toolName, result)
            };
        } catch (e) {
            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolCall.id, error: e.message, status: 'error', duration });
            recordToolFailure({
                toolName,
                args: parsedArgs,
                error: e,
                phase: 'anthropic-openai-managed-tool'
            });
            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: `Error: ${e.message}`
            };
        }
    };

    return executeToolBatch(toolCalls, executeOne, {
        parallel: getBrainConfig().adapterParallelTools === true,
        canRunInParallel: isOpenAiToolCallParallelSafe
    });
}

async function resolveManagedWebToolCalls(initialData, oReq, cfg, clientToolNames = new Set(), workspacePath = null, onToolEvent = null, parentSignal = null, streamFirstTurn = true) {
    let data = initialData;
    let requestPayload = {
        ...oReq,
        messages: Array.isArray(oReq.messages) ? [...oReq.messages] : []
    };

    for (let attempt = 0; attempt < 4; attempt++) {
        if (parentSignal && parentSignal.aborted) {
            throw new Error('Request aborted by client');
        }

        const choice = data?.choices?.[0];
        const message = choice?.message;
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) return data;

        const managedToolCalls = toolCalls.filter(tc =>
            isProxyManagedLocalToolName(tc?.function?.name) && !clientToolNames.has(tc?.function?.name)
        );
        if (managedToolCalls.length === 0) return data;

        if (managedToolCalls.length !== toolCalls.length) {
            console.warn('[Proxy Tools]: Mixed managed and unmanaged tool calls detected. Returning raw tool calls to client.');
            return data;
        }

        emitOpenAiMessageContentForAnthropic(message, onToolEvent, streamFirstTurn, attempt);

        requestPayload.messages.push({
            role: 'assistant',
            content: message?.content || '',
            reasoning: message?.reasoning,
            reasoning_content: message?.reasoning_content,
            reasoning_details: message?.reasoning_details,
            tool_calls: toolCalls
        });
        requestPayload.messages.push(...await executeManagedToolCalls(managedToolCalls, requestPayload.tools, requestPayload, workspacePath, onToolEvent, parentSignal));

        const outgoingPayload = {
            ...requestPayload,
            messages: sanitizeMessagesForOpenAIUpstream(requestPayload.messages, requestPayload.model, cfg.targetUrl)
        };

        const localAbortCtrl = new AbortController();
        const onParentAbort = () => localAbortCtrl.abort();
        if (parentSignal) {
            if (parentSignal.aborted) {
                throw new Error('Request aborted by client');
            }
            parentSignal.addEventListener('abort', onParentAbort);
        }
        const timeoutId = setTimeout(() => {
            localAbortCtrl.abort();
        }, 300000);

        const response = await fetch(cfg.targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify(outgoingPayload),
            signal: localAbortCtrl.signal
        }).finally(() => {
            clearTimeout(timeoutId);
            if (parentSignal) {
                parentSignal.removeEventListener('abort', onParentAbort);
            }
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
        }

        if (response.headers.get('content-type')?.includes('text/event-stream')) {
            data = parseSSEToJSON(rawBody);
        } else {
            data = JSON.parse(rawBody);
            if (data.data && data.data.choices) data = data.data;
        }
    }

    return data;
}

// ── Message translation: Anthropic -> OpenAI ──
async function translateMessages(anthropicMessages, ctx) {
    const openaiMessages = [];
    const repaired = await repairManagedWebToolResults(anthropicMessages);
    const repairedAnthropicMessages = repaired.messages;
    if (ctx && repaired.repairedCount > 0) {
        ctx.repairedManagedWebToolResultCount = (ctx.repairedManagedWebToolResultCount || 0) + repaired.repairedCount;
    }

    repairedAnthropicMessages.forEach(m => {
        if (Array.isArray(m.content)) {
            // Handle ALL tool_result blocks (there may be multiple if the model called several tools)
            const toolResultBlocks = m.content.filter(c => c.type === 'tool_result');
            if (toolResultBlocks.length > 0) {
                toolResultBlocks.forEach(toolResultBlock => {
                    const openaiId = getOpenAIId(toolResultBlock.tool_use_id);
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: openaiId || toolResultBlock.tool_use_id,
                        content: extractToolResultText(toolResultBlock.content)
                    });
                });
                // If the same user message also carries text, emit it as a separate user message
                const textParts = m.content
                    .filter(c => c.type !== 'tool_result' && c.type !== 'thinking')
                    .map(c => c.text || JSON.stringify(c))
                    .filter(Boolean);
                if (textParts.length > 0) {
                    openaiMessages.push({
                        role: 'user',
                        content: textParts.join('\n')
                    });
                }
            } else if (m.role === 'assistant') {
                // Assistant message with tool_use blocks -> needs tool_calls array
                const textParts = [];
                const toolCalls = [];
                const reasoningParts = [];
                const reasoningDetails = [];

                m.content.forEach((c, index) => {
                    if (c.type === 'text') {
                        textParts.push(c.text);
                    } else if (c.type === 'thinking') {
                        // Extract native Anthropic thinking into OpenAI-style reasoning_content
                        if (c.thinking) reasoningParts.push(c.thinking);
                        const detail = convertThinkingBlockToReasoningDetail(c, index);
                        if (detail) reasoningDetails.push(detail);
                    } else if (c.type === 'tool_use') {
                        const openaiId = getOpenAIId(c.id) || c.id;
                        toolCalls.push({
                            id: openaiId,
                            type: 'function',
                            function: {
                                name: c.name,
                                arguments: JSON.stringify(c.input || {})
                            }
                        });
                    }
                });

                const msg = {
                    role: 'assistant',
                    content: textParts.join('\n') || ''
                };
                const reasoning = reasoningParts.join('\n\n');
                if (reasoning) {
                    msg.reasoning_content = reasoning;
                }
                if (reasoningDetails.length > 0) {
                    msg.reasoning_details = reasoningDetails;
                }
                if (toolCalls.length > 0) {
                    msg.tool_calls = toolCalls;
                }
                openaiMessages.push(msg);
            } else {
                // Regular multi-part content (text blocks, etc.)
                // Exclude thinking blocks from the text-join to avoid cluttering prompt
                const reasoningDetails = m.role === 'assistant'
                    ? m.content
                        .map((c, index) => convertThinkingBlockToReasoningDetail(c, index))
                        .filter(Boolean)
                    : [];
                const reasoning = reasoningDetails.map(detail => detail.text).join('\n\n');
                const textOnly = m.content
                    .filter(c => c.type !== 'thinking')
                    .map(c => c.text || JSON.stringify(c))
                    .join('\n');
                
                const msg = {
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: textOnly
                };
                if (reasoning) msg.reasoning_content = reasoning;
                if (reasoningDetails.length > 0) msg.reasoning_details = reasoningDetails;
                openaiMessages.push(msg);
            }
        } else {
            openaiMessages.push({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            });
        }
    });

    // Merge consecutive same-role messages (except tool)
    const merged = [];
    openaiMessages.forEach(m => {
        const last = merged[merged.length - 1];
        if (last && last.role === m.role && m.role !== 'tool') {
            last.content += '\n\n' + m.content;
            if (m.reasoning_content) {
                last.reasoning_content = last.reasoning_content
                    ? `${last.reasoning_content}\n\n${m.reasoning_content}`
                    : m.reasoning_content;
            }
            if (m.reasoning_details?.length) {
                last.reasoning_details = (last.reasoning_details || []).concat(m.reasoning_details);
            }
            if (m.tool_calls?.length) {
                last.tool_calls = (last.tool_calls || []).concat(m.tool_calls);
            }
        } else {
            merged.push(m);
        }
    });

    return merged;
}

// ── Build OpenAI request from Anthropic request ──
async function buildOpenAIRequest(aReq, ctx, cfg, clientId) {
    const openaiMessages = [];
    const backendModel = getClaudeBackendModel(cfg, aReq.model);

    // System prompt: AUGUST context first, then MiniMax contract for MiniMax targets
    const augustSystem = buildContextSystemBlocks(aReq.system, {
        model: backendModel,
        targetUrl: cfg.targetUrl,
        includeMiniMaxContract: false,
        clientId
    });
    const systemPrompt = buildOpenAISystemPrompt(augustSystem);
    openaiMessages.push({ role: 'system', content: systemPrompt });

    openaiMessages.push(...await translateMessages(aReq.messages, ctx));

    if (ctx.repairedManagedWebToolResultCount > 0) {
        openaiMessages.push({
            role: 'user',
            content: '[SYSTEM NOTE] A previously blocked web fetch/search result was repaired locally by the proxy and the tool result above now contains the successful fetched content. Treat that tool result as authoritative and continue from it directly. Do not claim network egress is blocked, and do not refetch the same public page with browser or shell tools unless the repaired content is empty.'
        });
    }

    // Tool result scrubbing
    openaiMessages.forEach(m => {
        if (m.role === 'tool' && typeof m.content === 'string') {
            const lines = m.content.split('\n');
            const cleanLines = lines.filter(line =>
                !line.includes('node_modules/') &&
                !line.includes('.git/') &&
                !line.includes('dist/') &&
                !line.includes('build/')
            );
            m.content = cleanLines.join('\n');
        }
    });

    // Self-healing: enhance error tool results so the model can fix them
    applySelfHealToMessages(openaiMessages);

    // ── Smart context compaction (only when approaching model's limit) ──
    const requestModel = backendModel || getClaudeBackendModel(cfg, 'unknown');
    let contextWindow = loadModelContextWindow('claude', requestModel);
    if (!contextWindow) {
        const modelInfo = await getModelContextWindow(requestModel, cfg.targetUrl, cfg.apiKey);
        contextWindow = modelInfo.inputTokens;
        saveModelContextWindow('claude', requestModel, contextWindow);
    }
    // For MiniMax M2.7, use output-token-aware threshold because it has a COMBINED
    // input+output budget (not separate pools like most models).
    // Formula: contextWindow - max_tokens_reserve - thinking_reserve - safety_buffer
    const threshold = adapterBase.getCompactionThreshold(contextWindow, {
        model: requestModel,
        requestedMaxTokens: aReq.max_tokens
    });
    const estimatedTokens = estimateTokens(openaiMessages, aReq.tools);
    adapterBase.logContextBudget({
        model: requestModel,
        contextWindow,
        estimatedTokens,
        threshold,
        requestedMaxTokens: aReq.max_tokens
    });

    if (estimatedTokens > threshold) {
        console.log(`[Proxy Compaction]: ${formatTokenCount(estimatedTokens)} tokens exceeds ${formatTokenCount(threshold)} threshold. Compacting...`);
        const systemMsgs = openaiMessages.filter(m => m.role === 'system');
        const otherMsgs = openaiMessages.filter(m => m.role !== 'system');
        let kept = otherMsgs;
        while (kept.length > 1) {
            const testMessages = [...systemMsgs, ...kept];
            const testTokens = estimateTokens(testMessages, aReq.tools);
            if (testTokens <= threshold) break;
            const first = kept[0];
            let dropCount = 1;
            if (first.role === 'assistant' && first.tool_calls?.length > 0) {
                const callIds = new Set(first.tool_calls.map(tc => tc.id));
                while (dropCount < kept.length
                    && kept[dropCount]?.role === 'tool'
                    && kept[dropCount]?.tool_call_id
                    && callIds.has(kept[dropCount].tool_call_id)) {
                    dropCount++;
                }
            }
            kept = kept.slice(dropCount);
        }
        openaiMessages.length = 0;
        openaiMessages.push(...systemMsgs, ...kept);
        const newEstimate = estimateTokens(openaiMessages, aReq.tools);
        console.log(`[Proxy Compaction]: Trimmed from ${otherMsgs.length} to ${kept.length} non-system messages. New estimate: ${formatTokenCount(newEstimate)}`);

        // If still over threshold, truncate individual long messages
        if (newEstimate > threshold) {
            openaiMessages.forEach(m => {
                if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 8000) {
                    m.content = m.content.substring(0, 8000) + '\n\n[TRUNCATED]';
                }
            });
            const finalEstimate = estimateTokens(openaiMessages, aReq.tools);
            console.log(`[Proxy Compaction]: Also truncated long tool results. Final estimate: ${formatTokenCount(finalEstimate)}`);
        }
        logActivity('COMPACT', `Claude: ${formatTokenCount(estimatedTokens)} -> ${formatTokenCount(estimateTokens(openaiMessages, aReq.tools))} tokens (${formatTokenCount(contextWindow)} window)`);
    }

    const oReq = {
        model: backendModel,
        messages: sanitizeMessagesForOpenAIUpstream(openaiMessages, backendModel, cfg.targetUrl)
    };

    adapterBase.applyGenerationDefaults(oReq, aReq, {
        model: backendModel,
        isAnthropicPath: false
    });
    if (aReq.stop_sequences) oReq.stop = aReq.stop_sequences;

    console.log(`[Proxy Params]: max_tokens=${oReq.max_tokens}, msg_count=${openaiMessages.length}, temp=${oReq.temperature}, top_p=${oReq.top_p}, top_k=${oReq.top_k}`);

    // Translate tool_choice if present
    if (aReq.tool_choice) {
        const tc = aReq.tool_choice;
        if (tc === 'auto') oReq.tool_choice = 'auto';
        else if (tc === 'none') oReq.tool_choice = 'none';
        else if (tc === 'any') oReq.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) {
            oReq.tool_choice = { type: 'function', function: { name: tc.name } };
        }
    }

    // Tools: use request tools, or if request has tool messages but no tools, try to infer from history
    const hasToolMessages = openaiMessages.some(m => m.role === 'tool');
    if (aReq.tools && aReq.tools.length > 0) {
        oReq.tools = translateTools(aReq.tools, ctx);
    } else if (hasToolMessages && ctx.lastKnownTools.length > 0) {
        console.log('[Proxy Tools]: Reusing cached tools for tool-result turn');
        oReq.tools = ctx.lastKnownTools;
        rememberManagedLocalToolDefinitions(oReq.tools, ctx);
    } else {
        oReq.tools = getProxyOpenAiToolDefinitions();
        rememberManagedLocalToolDefinitions(oReq.tools, ctx);
        console.log('[Proxy Tools]: Injected default OpenAI-compatible MCP/August/Cowork/web tools');
    }

    return oReq;
}

function shouldUseAnthropicUpstream(targetUrl) {
    if (!targetUrl) return false;
    try {
        const parsed = new URL(targetUrl);
        return /\/v1\/messages$/i.test(parsed.pathname) ||
            /\/anthropic(\/|$)/i.test(parsed.pathname) ||
            parsed.hostname === 'api.anthropic.com';
    } catch (e) {
        return /\/v1\/messages$/i.test(targetUrl) || /\/anthropic(\/|$)/i.test(targetUrl);
    }
}

function toOpenAiCompatibleTargetUrl(targetUrl) {
    let target = String(targetUrl || '').trim();
    if (!target) return '';
    if (/\/chat\/completions$/i.test(target) || /\/text\/chatcompletion_v2$/i.test(target)) return target;
    target = target.replace(/\/+$/, '');
    if (/\/v\d+$/i.test(target)) return `${target}/chat/completions`;
    return `${target}/v1/chat/completions`;
}

function buildAnthropicHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
    };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

// ── Helper to intercept client tool failures and run proxy fallback ──
async function fallbackClientFailedToolsAnthropic(upstreamReq) {
    if (!upstreamReq || !Array.isArray(upstreamReq.messages)) return;
    const lastMsg = upstreamReq.messages[upstreamReq.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || !Array.isArray(lastMsg.content)) return;

    for (const block of lastMsg.content) {
        if (block?.type === 'tool_result' && block.is_error) {
            const toolUseId = block.tool_use_id;
            if (!toolUseId) continue;

            // Search backward for the assistant message containing the tool use
            let toolName = null;
            let toolInput = null;
            for (let i = upstreamReq.messages.length - 2; i >= 0; i--) {
                const msg = upstreamReq.messages[i];
                if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    const found = msg.content.find(b => b?.type === 'tool_use' && b.id === toolUseId);
                    if (found) {
                        toolName = found.name;
                        toolInput = found.input;
                        break;
                    }
                }
            }

            if (toolName && isProxyManagedLocalToolName(toolName)) {
                console.log(`[Proxy Fallback]: Client tool '${toolName}' (${toolUseId}) failed. Executing proxy fallback...`);
                try {
                    const localResult = await executeManagedProxyTool(toolName, toolInput);
                    block.content = formatManagedToolResult(toolName, localResult);
                    block.is_error = false;
                    console.log(`[Proxy Fallback]: Successfully recovered tool '${toolName}' execution.`);
                } catch (err) {
                    console.warn(`[Proxy Fallback]: Proxy fallback for '${toolName}' also failed:`, err.message);
                }
            }
        }
    }
}

function buildAnthropicUpstreamRequest(aReq, cfg, upstreamModelOverride, clientId) {
    const upstreamReq = {
        model: upstreamModelOverride || getClaudeBackendModel(cfg, aReq.model),
        messages: Array.isArray(aReq.messages) ? aReq.messages : []
    };

    // AUGUST context first, then MiniMax contract for MiniMax targets
    const augustSystem = buildContextSystemBlocks(aReq.system, {
        model: upstreamReq.model,
        targetUrl: cfg.targetUrl,
        includeMiniMaxContract: false,
        clientId
    });
    upstreamReq.system = augustSystem;

    // Mid-session drift prevention: inject rule reminders every 8 tool-result turns
    if (isMiniMaxModel(upstreamReq.model) || isMiniMaxTarget({ targetUrl: cfg.targetUrl })) {
        if (shouldInjectAugustReminder(upstreamReq.messages)) {
            const lastIdx = upstreamReq.messages.length - 1;
            const lastMsg = upstreamReq.messages[lastIdx];
            const hasToolResult = lastMsg?.role === 'tool' ||
                (Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b?.type === 'tool_result'));
            if (hasToolResult) {
                upstreamReq.messages.push(AUGUST_REMINDER);
                console.log(`[Proxy Reminder]: Appended AUGUST personality reminder after tool_result`);
            } else {
                upstreamReq.messages = [
                    ...upstreamReq.messages.slice(0, lastIdx),
                    AUGUST_REMINDER,
                    lastMsg
                ];
                console.log(`[Proxy Reminder]: Injected AUGUST personality reminder at message index ${lastIdx}`);
            }
        }
        if (shouldInjectReminderMessage(upstreamReq.messages)) {
            const lastIdx = upstreamReq.messages.length - 1;
            const lastMsg = upstreamReq.messages[lastIdx];
            const hasToolResult = lastMsg?.role === 'tool' ||
                (Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b?.type === 'tool_result'));
            if (hasToolResult) {
                upstreamReq.messages.push(RULE_REMINDER_MESSAGE);
                console.log(`[Proxy Reminder]: Appended mid-session rule reminder after tool_result`);
            } else {
                upstreamReq.messages = [
                    ...upstreamReq.messages.slice(0, lastIdx),
                    RULE_REMINDER_MESSAGE,
                    lastMsg
                ];
                console.log(`[Proxy Reminder]: Injected mid-session rule reminder at message index ${lastIdx}`);
            }
        }
    }

    const backendModel = upstreamModelOverride || getClaudeBackendModel(cfg, aReq.model);
    adapterBase.applyGenerationDefaults(upstreamReq, aReq, {
        model: backendModel,
        isAnthropicPath: true
    });
    if (aReq.thinking !== undefined) upstreamReq.thinking = aReq.thinking;
    if (aReq.stop_sequences) upstreamReq.stop_sequences = aReq.stop_sequences;
    if (aReq.tools && aReq.tools.length > 0) {
        // Smart client (e.g. Claude Desktop). Copy client tools, then strip browser-automation
        // tools and inject local web tools so the proxy can intercept them regardless of provider.
        upstreamReq.tools = dedupeAndCanonicalizeAnthropicTools(aReq.tools);
        const mappedMcpTools = getMcpToolDefinitions().map(openAiToAnthropicToolDefinition);
        const mappedAugustTools = getAugustToolDefinitions().map(openAiToAnthropicToolDefinition);
        const injectedTools = appendMissingAnthropicTools(upstreamReq.tools, [
            ...getCanonicalManagedAnthropicWebTools(),
            ...getCanonicalCoworkAnthropicTools(),
            ...mappedAugustTools,
            ...mappedMcpTools
        ]);
        if (injectedTools.length > 0) {
            console.log('[Proxy] Injected managed compatibility tools for all providers:', injectedTools);
        }
    } else {
        // Dumb client (e.g. Mobile App). Inject MCP + Cowork + August + web tools -- always.
        const mappedMcpTools = getMcpToolDefinitions().map(openAiToAnthropicToolDefinition);
        const mappedCoworkTools = getCanonicalCoworkAnthropicTools();
        const mappedAugustTools = getAugustToolDefinitions().map(openAiToAnthropicToolDefinition);
        const mappedWebTools = getCanonicalManagedAnthropicWebTools();
        upstreamReq.tools = [ ...mappedMcpTools, ...mappedCoworkTools, ...mappedAugustTools, ...mappedWebTools ];
    }
    if (aReq.tool_choice) upstreamReq.tool_choice = aReq.tool_choice;
    if (aReq.metadata) upstreamReq.metadata = aReq.metadata;
    if (aReq.stream !== undefined) upstreamReq.stream = aReq.stream;
    const extraSystemGuidance = [
        buildClientToolGuidance(aReq.tools),
        buildClaudeCodeNativeGuidance(aReq.tools)
    ].filter(Boolean).join('\n\n---\n\n');
    upstreamReq.system = appendTextToSystemBlocks(upstreamReq.system, extraSystemGuidance);
    return upstreamReq;
}

function normalizeAnthropicToolsForNativeUpstream(upstreamReq, ctx) {
    if (!Array.isArray(upstreamReq.tools) || upstreamReq.tools.length === 0) return upstreamReq;

    // We no longer need to translate local-web tools.
    // MCP tools are inherently Anthropic-compatible.
    return upstreamReq;
}

async function executeManagedAnthropicToolUses(toolUses, knownTools, requestPayload, workspacePath = null, onToolEvent = null, parentSignal = null) {
    const executeOne = async (toolUse) => {
        const toolName = toolUse?.name;

        // ── Validate arguments against schema BEFORE execution (Anthropic path) ──
        // Convert Anthropic tool_use format to the shape validateToolArguments expects.
        const syntheticCall = {
            function: {
                name: toolName,
                arguments: JSON.stringify(toolUse?.input || {})
            }
        };
        const validation = validateToolArguments(syntheticCall, knownTools, requestPayload ? requestPayload.messages : []);
        if (!validation.valid) {
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolUse.id, error: validation.error, status: 'error', duration: 0 });
            console.warn(`[Proxy Validator]: Anthropic tool_use '${toolName}' rejected:`, validation.error);
            return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `[Validation Error] Tool '${toolName}' rejected before execution:\n` +
                         `${validation.error}\n\n` +
                         `[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.`
            };
        }

        const parsedArgs = toolUse?.input || {};
        const contextStr = parsedArgs && typeof parsedArgs === 'object'
            ? Object.entries(parsedArgs).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
            : '';
        if (onToolEvent) onToolEvent({ type: 'tool_call', name: toolName, context: contextStr, id: toolUse.id, status: 'running' });

        const startTime = Date.now();
        try {
            let result;
            result = await executeManagedProxyTool(toolName, parsedArgs, workspacePath, (progressText) => {
                if (onToolEvent) {
                    onToolEvent({ type: 'tool_progress', name: toolName, id: toolUse.id, preview: progressText });
                }
            }, parentSignal);

            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolUse.id, summary: String(result).substring(0, 2000), status: 'done', duration });
            return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: formatManagedToolResult(toolName, result)
            };
        } catch (e) {
            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: toolUse.id, error: e.message, status: 'error', duration });
            recordToolFailure({
                toolName,
                args: parsedArgs,
                error: e,
                phase: 'anthropic-managed-tool'
            });
            return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${e.message}`
            };
        }
    };

    return executeToolBatch(toolUses, executeOne, {
        parallel: getBrainConfig().adapterParallelTools === true,
        canRunInParallel: isAnthropicToolUseParallelSafe
    });
}
/**
 * Simulates an Anthropic SSE stream from a fully-resolved JSON response.
 * Used when the client requested stream:true but we forced stream:false upstream
 * in order to intercept and execute managed local tool calls (web search / fetch).
 * This ensures Claude Desktop receives proper streaming SSE events.
 */
function sendSimulatedAnthropicStream(res, parsed, clientFacingModel, preludeEvents = []) {
    const msgId = parsed.id || 'msg_' + Math.random().toString(36).substring(2, 14);
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // 1. message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: msgId, type: 'message', role: 'assistant', content: [],
            model: clientFacingModel,
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: parsed.usage?.input_tokens || 0, output_tokens: 0 }
        }
    })}\n\n`);

    let index = 0;
    for (const evt of preludeEvents || []) {
        if (!evt || typeof evt !== 'object') continue;
        if (evt.type === 'thinking') {
            streamAnthropicContentBlock(res, { type: 'thinking', thinking: evt.content || evt.thinking || '' }, index++);
        } else if (evt.type === 'text') {
            streamAnthropicContentBlock(res, { type: 'text', text: evt.content || evt.text || '' }, index++);
        } else if (evt.type === 'tool_use') {
            streamAnthropicContentBlock(res, {
                type: 'tool_use',
                id: evt.id || 'toolu_' + Math.random().toString(36).substring(2, 14),
                name: evt.name,
                input: normalizeToolUseInput(evt.input ?? evt.arguments)
            }, index++);
        } else {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
    }

    const blocks = Array.isArray(parsed.content) ? parsed.content : [];
    blocks.forEach((block, blockIndex) => {
        // 2. content_block_start
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start', index,
            content_block: {
                type: block.type,
                ...(block.type === 'text'     ? { text: '' }     : {}),
                ...(block.type === 'thinking' ? { thinking: '' } : {}),
                ...(block.type === 'tool_use'
                    ? {
                        id: block.id,
                        name: block.name,
                        input: {}
                    }
                    : {})
            }
        })}\n\n`);

        // 3. content_block_delta (full content in one delta — no chunking needed)
        if (block.type === 'thinking') {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index,
                delta: { type: 'thinking_delta', thinking: block.thinking || '' }
            })}\n\n`);
        } else if (block.type === 'tool_use') {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
            })}\n\n`);
        } else {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index,
                delta: { type: 'text_delta', text: block.text || '' }
            })}\n\n`);
        }

        // 4. content_block_stop
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop', index
        })}\n\n`);
        index++;
    });

    // 5. message_delta
    res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: parsed.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: parsed.usage?.output_tokens || 0 }
    })}\n\n`);

    // 6. message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
}

function writeAnthropicSSEHeaders(res) {
    if (!res.headersSent) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }
}

function streamAnthropicContentBlock(res, block, index) {
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index,
        content_block: {
            type: block.type,
            ...(block.type === 'text' ? { text: '' } : {}),
            ...(block.type === 'thinking' ? { thinking: '' } : {}),
            ...(block.type === 'tool_use' ? { id: block.id, name: block.name, input: {} } : {})
        }
    })}\n\n`);

    if (block.type === 'thinking') {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index,
            delta: { type: 'thinking_delta', thinking: block.thinking || '' }
        })}\n\n`);
    } else if (block.type === 'tool_use') {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
        })}\n\n`);
    } else {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index,
            delta: { type: 'text_delta', text: block.text || '' }
        })}\n\n`);
    }

    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop', index
    })}\n\n`);
}

function streamAnthropicContentBlocks(res, parsed, startIndex = 0) {
    const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
    let index = startIndex;
    blocks.forEach(block => {
        if (!block || typeof block !== 'object') return;
        streamAnthropicContentBlock(res, block, index++);
    });
    return index - startIndex;
}

function streamAnthropicMessageStart(res, parsed, clientFacingModel) {
    res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: parsed?.id || 'msg_' + Math.random().toString(36).substring(2, 14),
            type: 'message',
            role: 'assistant',
            content: [],
            model: clientFacingModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: parsed?.usage?.input_tokens || 0, output_tokens: 0 }
        }
    })}\n\n`);
}

function streamAnthropicMessageEnd(res, parsed) {
    res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: parsed?.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: parsed?.usage?.output_tokens || 0 }
    })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

function writeAnthropicSSEData(res, payload, eventName = 'message') {
    try {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
        return true;
    } catch (e) {
        return false;
    }
}

function writeAnthropicSSEDataOnly(res, payload) {
    try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        return true;
    } catch (e) {
        return false;
    }
}

async function pipeResponseToText(response, onChunk) {
    if (!response.body) {
        const text = await response.text();
        onChunk(text, Buffer.from(text, 'utf8'));
        return text;
    }

    const decoder = new TextDecoder();
    let rawBody = '';
    for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true });
        rawBody += text;
        onChunk(text, chunk);
    }
    const tail = decoder.decode();
    if (tail) {
        rawBody += tail;
        onChunk(tail, Buffer.from(tail, 'utf8'));
    }
    return rawBody;
}

function rewriteModelFieldsInValue(value, responseModel) {
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'thinking') return value;
    if (Array.isArray(value)) {
        value.forEach(item => rewriteModelFieldsInValue(item, responseModel));
        return value;
    }
    if (typeof value.model === 'string') value.model = responseModel;
    Object.values(value).forEach(child => rewriteModelFieldsInValue(child, responseModel));
    return value;
}

function rewriteAnthropicSSELine(line, responseModel) {
    if (!line.startsWith('data: ')) return line;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') return line;
    try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === 'object') {
            rewriteModelFieldsInValue(parsed, responseModel);
            return `data: ${JSON.stringify(parsed)}`;
        }
    } catch (e) {
        return line;
    }
    return line;
}

async function streamAnthropicSSEToClient(response, res, reqId, responseModel) {
    if (!response.ok) {
        const rawBody = await response.text();
        throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
    }

    writeAnthropicSSEHeaders(res);
    let rawBody = '';
    const parser = new SseStreamParser((event, data) => {
        if (data === '[DONE]') return;
        let payload;
        try {
            payload = JSON.parse(data);
        } catch (e) {
            return;
        }
        rewriteModelFieldsInValue(payload, responseModel);
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    rawBody = await pipeResponseToText(response, (text) => parser.feed(text));
    parser.flush();

    try {
        const parsed = parseAnthropicSSEToJSON(rawBody);
        captureResponse(reqId, parsed);
        captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
    } catch (e) {
        console.warn('[Proxy Stream Capture Warning]: Failed to aggregate Anthropic SSE:', e.message);
    }

    return parsed;
}

function createAnthropicNativeStreamState(clientFacingModel) {
    return {
        id: '',
        model: clientFacingModel,
        role: 'assistant',
        contentByUpstreamIndex: new Map(),
        toolUsesByUpstreamIndex: new Map(),
        clientIndexByUpstreamIndex: new Map(),
        nextClientIndex: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: null,
        stopSequence: null,
        messageStarted: false
    };
}

function getClientAnthropicIndex(state, upstreamIndex) {
    if (state.clientIndexByUpstreamIndex.has(upstreamIndex)) {
        return state.clientIndexByUpstreamIndex.get(upstreamIndex);
    }
    const index = state.nextClientIndex++;
    state.clientIndexByUpstreamIndex.set(upstreamIndex, index);
    return index;
}

function streamAnthropicNativeContentStart(res, state, upstreamIndex, block) {
    const index = getClientAnthropicIndex(state, upstreamIndex);
    state.contentByUpstreamIndex.set(upstreamIndex, {
        ...block,
        text: block.text || '',
        thinking: block.thinking || ''
    });
    writeAnthropicSSEData(res, {
        type: 'content_block_start',
        index,
        content_block: {
            type: block.type,
            ...(block.type === 'text' ? { text: '' } : {}),
            ...(block.type === 'thinking' ? { thinking: '' } : {})
        }
    }, 'content_block_start');
}

function streamAnthropicNativeContentDelta(res, state, upstreamIndex, delta) {
    const index = getClientAnthropicIndex(state, upstreamIndex);
    const block = state.contentByUpstreamIndex.get(upstreamIndex);
    if (block?.type === 'text' && delta?.text) {
        block.text = (block.text || '') + delta.text;
    }
    if (block?.type === 'thinking' && delta?.thinking) {
        block.thinking = (block.thinking || '') + delta.thinking;
    }
    writeAnthropicSSEData(res, {
        type: 'content_block_delta',
        index,
        delta
    }, 'content_block_delta');
}

function streamAnthropicNativeContentStop(res, state, upstreamIndex) {
    const index = getClientAnthropicIndex(state, upstreamIndex);
    writeAnthropicSSEData(res, {
        type: 'content_block_stop',
        index
    }, 'content_block_stop');
}

function buildAnthropicAggregatedFromNativeStream(state) {
    const content = [];
    for (const [upstreamIndex, block] of state.contentByUpstreamIndex.entries()) {
        content[upstreamIndex] = {
            type: block.type,
            ...(block.text !== undefined ? { text: block.text } : {}),
            ...(block.thinking !== undefined ? { thinking: block.thinking } : {})
        };
    }
    for (const [upstreamIndex, toolUse] of state.toolUsesByUpstreamIndex.entries()) {
        content[upstreamIndex] = {
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input || {}
        };
    }

    return {
        id: state.id || 'msg_' + Math.random().toString(36).substring(2, 14),
        type: 'message',
        role: state.role,
        content: content.filter(Boolean),
        model: state.model,
        stop_reason: state.stopReason || 'end_turn',
        stop_sequence: state.stopSequence,
        usage: state.usage
    };
}

function buildOpenAiAggregatedForAnthropicFromStream(state) {
    const toolCalls = Array.from(state.toolCallsByIndex.values())
        .sort((a, b) => a.index - b.index)
        .map(({ index, ...toolCall }) => toolCall);
    const message = {
        role: state.role || 'assistant',
        content: state.content || ''
    };
    if (state.reasoning) message.reasoning = state.reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
        id: state.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
        object: 'chat.completion',
        created: state.created || Math.floor(Date.now() / 1000),
        model: state.model || 'unknown',
        choices: [{
            index: 0,
            message,
            finish_reason: state.finishReason || 'stop'
        }],
        usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
}

function accumulateOpenAiChunkForAnthropic(state, chunk) {
    if (!state || !chunk || typeof chunk !== 'object') return state;
    if (chunk.id) state.id = chunk.id;
    if (chunk.created) state.created = chunk.created;
    if (chunk.model) state.model = chunk.model;
    if (chunk.usage) state.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return state;
    const delta = choice.delta || {};
    if (typeof delta.role === 'string') state.role = delta.role;
    if (typeof delta.content === 'string') state.content += delta.content;
    if (typeof delta.reasoning === 'string') state.reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === 'string') state.reasoning += delta.reasoning_content;

    if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
            if (!toolCall || typeof toolCall !== 'object') continue;
            const index = Number.isInteger(toolCall.index) ? toolCall.index : state.toolCallsByIndex.size;
            const existing = state.toolCallsByIndex.get(index);
            const normalized = existing || {
                index,
                id: '',
                type: toolCall.type || 'function',
                function: { name: '', arguments: '' }
            };
            if (toolCall.id) normalized.id = toolCall.id;
            if (toolCall.type) normalized.type = toolCall.type;
            if (toolCall.function?.name) normalized.function.name += toolCall.function.name;
            if (toolCall.function?.arguments) normalized.function.arguments += toolCall.function.arguments;
            state.toolCallsByIndex.set(index, normalized);
        }
    }

    const finishReason = choice.finish_reason;
    if (finishReason !== null && finishReason !== undefined) state.finishReason = finishReason;
    return state;
}

function createOpenAiToAnthropicStreamState(clientFacingModel) {
    return {
        id: '',
        created: null,
        model: '',
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCallsByIndex: new Map(),
        finishReason: null,
        usage: null,
        blockIndex: 0,
        activeBlockType: null,
        messageStarted: false
    };
}

function ensureOpenAiToAnthropicBlock(res, state, type) {
    if (state.activeBlockType !== type) {
        if (state.activeBlockType) {
            writeAnthropicSSEData(res, {
                type: 'content_block_stop',
                index: state.blockIndex - 1
            }, 'content_block_stop');
        }
        writeAnthropicSSEData(res, {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: {
                type,
                ...(type === 'text' ? { text: '' } : {}),
                ...(type === 'thinking' ? { thinking: '' } : {})
            }
        }, 'content_block_start');
        state.activeBlockType = type;
        state.blockIndex += 1;
    }
}

function closeOpenAiToAnthropicActiveBlock(res, state) {
    if (!state.activeBlockType) return;
    writeAnthropicSSEData(res, {
        type: 'content_block_stop',
        index: state.blockIndex - 1
    }, 'content_block_stop');
    state.activeBlockType = null;
}

function streamOpenAiDeltaAsAnthropic(res, state, delta) {
    if (!delta || typeof delta !== 'object') return;
    if (typeof delta.content === 'string' && delta.content !== '') {
        ensureOpenAiToAnthropicBlock(res, state, 'text');
        writeAnthropicSSEData(res, {
            type: 'content_block_delta',
            index: state.blockIndex - 1,
            delta: { type: 'text_delta', text: delta.content }
        }, 'content_block_delta');
    }
    const reasoning = delta.reasoning || delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning !== '') {
        ensureOpenAiToAnthropicBlock(res, state, 'thinking');
        writeAnthropicSSEData(res, {
            type: 'content_block_delta',
            index: state.blockIndex - 1,
            delta: { type: 'thinking_delta', thinking: reasoning }
        }, 'content_block_delta');
    }
}

function openAiToolCallsToAnthropicToolUses(toolCalls) {
    return (toolCalls || []).map(tc => {
        let input = {};
        try {
            input = JSON.parse(tc.function?.arguments || '{}');
        } catch (e) {
            input = {};
        }
        return {
            type: 'tool_use',
            id: getAnthropicId(tc.id),
            name: tc.function?.name || '',
            input
        };
    });
}

function streamAnthropicToolUseBlock(res, toolUse, index) {
    streamAnthropicContentBlock(res, {
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input || {}
    }, index);
}

function streamAnthropicMessageEndState(res, state) {
    writeAnthropicSSEData(res, {
        type: 'message_delta',
        delta: { stop_reason: state.stopReason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: state.usage?.output_tokens || 0 }
    }, 'message_delta');
    writeAnthropicSSEData(res, { type: 'message_stop' }, 'message_stop');
}

async function streamOpenAiUpstreamToAnthropicClient({
    response,
    res,
    reqId,
    clientFacingModel,
    oReq,
    cfg,
    clientToolNames,
    managedLocalToolNames,
    workspacePath,
    parentSignal,
    messageAlreadyStarted = false
}) {
    if (!response.ok) {
        const rawBody = await response.text();
        throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
    }

    writeAnthropicSSEHeaders(res);
    const state = createOpenAiToAnthropicStreamState(clientFacingModel);
    state.model = clientFacingModel;
    const parser = new SseStreamParser((event, data) => {
        if (data === '[DONE]') return;
        let chunk;
        try {
            chunk = JSON.parse(data);
        } catch (e) {
            return;
        }

        accumulateOpenAiChunkForAnthropic(state, chunk);

        if (!state.messageStarted && !messageAlreadyStarted) {
            writeAnthropicSSEData(res, {
                type: 'message_start',
                message: {
                    id: chunk.id || 'msg_' + Math.random().toString(36).substring(2, 14),
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: clientFacingModel,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: chunk.usage?.prompt_tokens || chunk.usage?.input_tokens || 0, output_tokens: 0 }
                }
            }, 'message_start');
            state.messageStarted = true;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) streamOpenAiDeltaAsAnthropic(res, state, delta);
    });

    await pipeResponseToText(response, (text) => parser.feed(text));
    parser.flush();

    const parsed = buildOpenAiAggregatedForAnthropicFromStream(state);
    captureResponse(reqId, parsed);
    const upUsage = parsed.usage || {};
    captureTokens(reqId, upUsage.prompt_tokens || upUsage.input_tokens || 0, upUsage.completion_tokens || upUsage.output_tokens || 0);

    closeOpenAiToAnthropicActiveBlock(res, state);

    const toolCalls = parsed.choices?.[0]?.message?.tool_calls || [];
    const classification = classifyOpenAiToolCalls(toolCalls, managedLocalToolNames, clientToolNames);

    if (classification.canExecuteManaged) {
        const msg = parsed.choices?.[0]?.message || {};
        oReq.messages.push({
            role: msg.role || 'assistant',
            content: msg.content || null,
            tool_calls: classification.toolCalls,
            ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {})
        });

        const openAiToolCalls = classification.managedToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments || '{}'
            }
        }));
        const toolResults = await executeManagedOpenAiToolCalls(
            openAiToolCalls,
            oReq.tools,
            oReq.messages,
            workspacePath,
            (evt) => writeAnthropicSSEDataOnly(res, evt),
            parentSignal
        );
        toolResults.forEach(toolResult => oReq.messages.push(toolResult));

        return streamOpenAiUpstreamToAnthropicClient({
            response: await fetch(cfg.targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.apiKey}`
                },
                body: JSON.stringify(oReq),
                signal: parentSignal
            }),
            res,
            reqId,
            clientFacingModel,
            oReq,
            cfg,
            clientToolNames,
            managedLocalToolNames,
            workspacePath,
            parentSignal,
            messageAlreadyStarted: true
        });
    }

    if (classification.hasClientOrUnknown) {
        const toolUses = openAiToolCallsToAnthropicToolUses(classification.toolCalls);
        toolUses.forEach((toolUse, idx) => streamAnthropicToolUseBlock(res, toolUse, state.blockIndex + idx));
        state.stopReason = 'tool_use';
    } else {
        state.stopReason = parsed.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    }

    streamAnthropicMessageEndState(res, state);
    res.end();
    return parsed;
}

async function streamUpstreamAndResolveToolsAnthropic({
    response,
    res,
    reqId,
    clientFacingModel,
    upstreamReq,
    cfg,
    clientToolNames,
    managedLocalToolNames,
    workspacePath,
    parentSignal,
    messageAlreadyStarted = false
}) {
    if (!response.ok) {
        const rawBody = await response.text();
        throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
    }

    writeAnthropicSSEHeaders(res);
    const state = createAnthropicNativeStreamState(clientFacingModel);
    const parser = new SseStreamParser((event, data) => {
        if (data === '[DONE]') return;
        let payload;
        try {
            payload = JSON.parse(data);
        } catch (e) {
            return;
        }

        if (payload.type === 'message_start' && payload.message) {
            state.id = payload.message.id || state.id;
            state.model = clientFacingModel;
            state.role = payload.message.role || state.role;
            if (payload.message.usage) {
                state.usage.input_tokens = payload.message.usage.input_tokens || state.usage.input_tokens || 0;
                state.usage.output_tokens = payload.message.usage.output_tokens || state.usage.output_tokens || 0;
            }
            if (!state.messageStarted && !messageAlreadyStarted) {
                writeAnthropicSSEData(res, {
                    type: 'message_start',
                    message: {
                        id: state.id || 'msg_' + Math.random().toString(36).substring(2, 14),
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: clientFacingModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                            input_tokens: state.usage.input_tokens || 0,
                            output_tokens: 0
                        }
                    }
                }, 'message_start');
                state.messageStarted = true;
            }
            return;
        }

        if (payload.type === 'content_block_start' && payload.content_block) {
            const block = payload.content_block;
            if (block.type === 'tool_use') {
                state.toolUsesByUpstreamIndex.set(payload.index, {
                    id: block.id || 'toolu_' + Math.random().toString(36).substring(2, 14),
                    name: block.name || '',
                    inputDelta: ''
                });
                return;
            }
            if (block.type === 'text' || block.type === 'thinking') {
                streamAnthropicNativeContentStart(res, state, payload.index, block);
            }
            return;
        }

        if (payload.type === 'content_block_delta' && payload.delta) {
            if (payload.delta.type === 'input_json_delta') {
                const toolUse = state.toolUsesByUpstreamIndex.get(payload.index);
                if (toolUse) toolUse.inputDelta = (toolUse.inputDelta || '') + (payload.delta.partial_json || '');
                return;
            }
            if (payload.delta.type === 'text_delta' || payload.delta.type === 'thinking_delta') {
                streamAnthropicNativeContentDelta(res, state, payload.index, payload.delta);
            }
            return;
        }

        if (payload.type === 'content_block_stop') {
            if (state.toolUsesByUpstreamIndex.has(payload.index)) {
                const toolUse = state.toolUsesByUpstreamIndex.get(payload.index);
                try {
                    toolUse.input = JSON.parse(toolUse.inputDelta || '{}');
                } catch (e) {
                    toolUse.input = {};
                }
                delete toolUse.inputDelta;
                return;
            }
            streamAnthropicNativeContentStop(res, state, payload.index);
            return;
        }

        if (payload.type === 'message_delta' && payload.delta) {
            if (payload.delta.stop_reason) state.stopReason = payload.delta.stop_reason;
            if (payload.delta.stop_sequence) state.stopSequence = payload.delta.stop_sequence;
            if (payload.usage?.output_tokens) state.usage.output_tokens = payload.usage.output_tokens;
            return;
        }

        if (payload.type === 'message_stop') return;
    });

    const rawBody = await pipeResponseToText(response, (text) => parser.feed(text));
    parser.flush();

    const parsed = buildAnthropicAggregatedFromNativeStream(state);
    captureResponse(reqId, parsed);
    captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);

    const toolUses = parsed.content.filter(block => block?.type === 'tool_use');
    const classification = classifyAnthropicToolUses(toolUses, managedLocalToolNames, clientToolNames);

    if (classification.canExecuteManaged) {
        upstreamReq.messages.push({
            role: 'assistant',
            content: parsed.content
        });
        const toolResults = await executeManagedAnthropicToolUses(
            classification.managedToolUses,
            upstreamReq.tools,
            upstreamReq,
            workspacePath,
            (evt) => writeAnthropicSSEDataOnly(res, evt),
            parentSignal
        );
        upstreamReq.messages.push({
            role: 'user',
            content: toolResults
        });

        return streamUpstreamAndResolveToolsAnthropic({
            response: await fetch(cfg.targetUrl, {
                method: 'POST',
                headers: buildAnthropicHeaders(cfg.apiKey),
                body: JSON.stringify(upstreamReq),
                signal: parentSignal
            }),
            res,
            reqId,
            clientFacingModel,
            upstreamReq,
            cfg,
            clientToolNames,
            managedLocalToolNames,
            workspacePath,
            parentSignal,
            messageAlreadyStarted: true
        });
    }

    if (classification.hasClientOrUnknown) {
        classification.toolUses.forEach((toolUse, idx) => streamAnthropicToolUseBlock(res, toolUse, state.nextClientIndex + idx));
        state.stopReason = 'tool_use';
    }

    streamAnthropicMessageEndState(res, state);
    res.end();
    return parsed;
}

function streamAnthropicErrorAndEnd(res, errorMsg, blockIndex) {
    writeAnthropicSSEHeaders(res);
    streamAnthropicContentBlock(res, {
        type: 'text',
        text: `⚠️ Bridge Error: ${errorMsg}`
    }, blockIndex);
    streamAnthropicMessageEnd(res, { stop_reason: 'end_turn', usage: { output_tokens: 0 } });
    res.end();
}

function normalizeToolUseInput(input) {
    if (input === undefined || input === null) return {};
    if (typeof input === 'string') {
        try { return JSON.parse(input); } catch (e) { return {}; }
    }
    if (typeof input === 'object') return input;
    return {};
}

function emitOpenAiMessageContentForAnthropic(message, onToolEvent, streamFirstTurn, attempt) {
    if (!onToolEvent || !message) return;
    if (attempt > 0 || streamFirstTurn) {
        const reasoning = message.reasoning_content || message.reasoning;
        if (reasoning) onToolEvent({ type: 'thinking', content: reasoning });
        if (message.content) onToolEvent({ type: 'text', content: message.content });
        for (const toolCall of message.tool_calls || []) {
            onToolEvent({
                type: 'tool_use',
                id: getAnthropicId(toolCall.id),
                name: toolCall.function?.name,
                input: normalizeToolUseInput(toolCall.function?.arguments)
            });
        }
    }
}

function emitAnthropicContentBlocks(content, onToolEvent, streamFirstTurn, attempt) {
    if (!onToolEvent || !Array.isArray(content) || !(attempt > 0 || streamFirstTurn)) return;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'thinking') onToolEvent({ type: 'thinking', content: block.thinking || '' });
        if (block.type === 'text') onToolEvent({ type: 'text', content: block.text || '' });
        if (block.type === 'tool_use') {
            onToolEvent({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: normalizeToolUseInput(block.input)
            });
        }
    }
}

function writeAnthropicToolEvent(res, evt) {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (e) {}
}

async function resolveManagedAnthropicToolUses(initialParsed, upstreamReq, cfg, clientToolNames = new Set(), workspacePath = null, onToolEvent = null, parentSignal = null, streamFirstTurn = true) {
    let parsed = initialParsed;
    const requestPayload = {
        ...upstreamReq,
        messages: Array.isArray(upstreamReq.messages) ? [...upstreamReq.messages] : []
    };

    for (let attempt = 0; attempt < 4; attempt++) {
        if (parentSignal && parentSignal.aborted) {
            throw new Error('Request aborted by client');
        }

        const content = Array.isArray(parsed?.content) ? parsed.content : [];
        const toolUses = content.filter(block => block?.type === 'tool_use');
        if (toolUses.length === 0) return parsed;

        const managedToolUses = toolUses.filter(toolUse =>
            isProxyManagedLocalToolName(toolUse?.name) && !clientToolNames.has(toolUse?.name)
        );
        if (managedToolUses.length === 0) return parsed;

        if (managedToolUses.length !== toolUses.length) {
            console.warn('[Proxy Tools]: Mixed managed and unmanaged Anthropic tool_use blocks detected. Returning raw tool_use response to client.');
            return parsed;
        }

        emitAnthropicContentBlocks(content, onToolEvent, streamFirstTurn, attempt);

        requestPayload.messages.push({
            role: 'assistant',
            content
        });
        requestPayload.messages.push({
            role: 'user',
            content: await executeManagedAnthropicToolUses(managedToolUses, requestPayload.tools, requestPayload, workspacePath, onToolEvent, parentSignal)
        });

        const localAbortCtrl = new AbortController();
        const onParentAbort = () => localAbortCtrl.abort();
        if (parentSignal) {
            if (parentSignal.aborted) {
                throw new Error('Request aborted by client');
            }
            parentSignal.addEventListener('abort', onParentAbort);
        }
        const timeoutId = setTimeout(() => {
            localAbortCtrl.abort();
        }, 300000);

        const response = await fetch(cfg.targetUrl, {
            method: 'POST',
            headers: buildAnthropicHeaders(cfg.apiKey),
            body: JSON.stringify(requestPayload),
            signal: localAbortCtrl.signal
        }).finally(() => {
            clearTimeout(timeoutId);
            if (parentSignal) {
                parentSignal.removeEventListener('abort', onParentAbort);
            }
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
        }

        parsed = JSON.parse(rawBody);
    }

    return parsed;
}

function rewriteAnthropicResponseModel(rawBody, contentType, responseModel) {
    if (!rawBody || !responseModel) return rawBody;

    function replaceModelFields(value) {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            value.forEach(replaceModelFields);
            return value;
        }

        // Guard: never touch thinking blocks — they must be preserved exactly as-is
        // for M2.7's interleaved reasoning chain to work across turns.
        if (value.type === 'thinking') return value;

        if (typeof value.model === 'string') {
            value.model = responseModel;
        }

        Object.values(value).forEach(replaceModelFields);
        return value;
    }

    if (contentType.includes('application/json')) {
        try {
            const parsed = JSON.parse(rawBody);
            if (parsed && typeof parsed === 'object') {
                replaceModelFields(parsed);
                return JSON.stringify(parsed);
            }
        } catch (e) {
            return rawBody;
        }
    }

    if (contentType.includes('text/event-stream')) {
        return rawBody
            .split('\n')
            .map(line => {
                if (!line.startsWith('data: ')) return line;
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') return line;
                try {
                    const parsed = JSON.parse(payload);
                    if (parsed && typeof parsed === 'object') {
                        replaceModelFields(parsed);
                        return `data: ${JSON.stringify(parsed)}`;
                    }
                } catch (e) {
                    return line;
                }
                return line;
            })
            .join('\n');
    }

    return rawBody;
}

function isClaudeDesktop3pClient(req) {
    const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
    return ua.includes('claude-desktop-3p');
}

function normalizeAnthropicResponseForClaudeDesktop3p(parsed) {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.content)) {
        return parsed;
    }

    const normalized = {
        ...parsed,
        content: parsed.content.filter(Boolean)
    };

    // Claude Desktop 3p appears to assume text-first content in some paths.
    // Remove thinking blocks and guarantee a leading text block on tool turns.
    normalized.content = normalized.content.filter(block => block?.type !== 'thinking');

    const hasToolUse = normalized.content.some(block => block?.type === 'tool_use');
    if (hasToolUse && normalized.content[0]?.type !== 'text') {
        normalized.content.unshift({
            type: 'text',
            text: 'Continuing with tool execution.'
        });
    }

    return normalized;
}

function summarizeHeaders(headersLike) {
    try {
        const headers = {};
        for (const [key, value] of headersLike.entries()) {
            const lowered = String(key || '').toLowerCase();
            if (lowered.includes('auth') || lowered.includes('key') || lowered.includes('token') || lowered.includes('cookie')) continue;
            headers[key] = value;
        }
        return headers;
    } catch (e) {
        return {};
    }
}

function extractModelHintsFromBody(rawBody, contentType) {
    if (!rawBody || !contentType) return {};
    if (!contentType.includes('application/json')) return {};
    try {
        const parsed = JSON.parse(rawBody);
        return {
            topLevelModel: parsed?.model || null,
            contentTypes: Array.isArray(parsed?.content) ? parsed.content.map(block => block?.type).filter(Boolean) : [],
            stopReason: parsed?.stop_reason || null
        };
    } catch (e) {
        return {};
    }
}

// ── Parse tool calls embedded in message content (auto-repair) ──
function extractEmbeddedToolCalls(content) {
    const toolCalls = [];
    if (!content || !content.includes('"tool_use"')) return { text: content, toolCalls };

    let pos = 0;
    while ((pos = content.indexOf('{"type"', pos)) !== -1) {
        let braceCount = 0;
        let endPos = -1;
        for (let i = pos; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            if (content[i] === '}') braceCount--;
            if (braceCount === 0) { endPos = i + 1; break; }
        }
        if (endPos !== -1) {
            const block = content.substring(pos, endPos);
            if (block.includes('"tool_use"')) {
                try {
                    const parsed = JSON.parse(block);
                    toolCalls.push({
                        id: parsed.id || 'toolu_' + Math.random().toString(36).substr(2, 9),
                        function: {
                            name: parsed.name,
                            arguments: JSON.stringify(parsed.input || {})
                        }
                    });
                    content = content.replace(block, '').trim();
                } catch (e) { /* ignore parse error */ }
            }
            pos = endPos;
        } else {
            pos++;
        }
    }
    return { text: content, toolCalls };
}

function extractThinkTags(text) {
    let thinking = '';
    let content = text || '';
    
    // Match <think>...</think> tags (case-insensitive)
    const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
    const match = thinkRegex.exec(content);
    if (match) {
        thinking = match[1].trim();
        content = content.replace(thinkRegex, '').trim();
    } else {
        // Handle unclosed <think> tag at the end
        const unclosedThinkRegex = /<think>([\s\S]*)$/i;
        const unclosedMatch = unclosedThinkRegex.exec(content);
        if (unclosedMatch) {
            thinking = unclosedMatch[1].trim();
            content = content.replace(unclosedThinkRegex, '').trim();
        }
    }
    return { content, thinking };
}

// ── Translate OpenAI response -> Anthropic response ──
function translateOpenAIResponse(openaiData, requestModel, ctx) {
    const choice = openaiData.choices?.[0];
    if (!choice) throw new Error('No choices returned from upstream');

    let toolCalls = choice.message?.tool_calls || [];
    let messageContent = choice.message?.content || '';
    let reasoningContent = choice.message?.reasoning || choice.message?.reasoning_content || '';
    const reasoningDetails = Array.isArray(choice.message?.reasoning_details)
        ? choice.message.reasoning_details
        : [];

    if (!reasoningContent && reasoningDetails.length === 0 && messageContent.includes('<think>')) {
        const extracted = extractThinkTags(messageContent);
        messageContent = extracted.content;
        reasoningContent = extracted.thinking;
    }

    // Auto-repair: extract tool_use blocks embedded in content string
    const repaired = extractEmbeddedToolCalls(messageContent);
    messageContent = repaired.text;
    toolCalls = toolCalls.concat(repaired.toolCalls);

    const content = [];
    if (reasoningDetails.length > 0) {
        reasoningDetails.forEach((detail, index) => {
            const block = convertReasoningDetailToThinkingBlock(detail, index);
            if (block) content.push(block);
        });
    } else if (reasoningContent) {
        // Preserve as a proper Anthropic thinking block — NOT a plain text block.
        // This is critical: if we degrade it to text, the model loses its reasoning
        // chain on the next turn (can't reference prior thinking as thinking).
        content.push({ type: 'thinking', thinking: reasoningContent });
    }
    if (messageContent) {
        content.push({ type: 'text', text: messageContent });
    }

    if (toolCalls.length > 0) {
        toolCalls.forEach(tc => {
            const anthropicId = getAnthropicId(tc.id);
            let toolInput = {};
            try {
                toolInput = JSON.parse(tc.function.arguments);
            } catch (e) {
                toolInput = {};
            }

            const toolName = tc.function.name.toLowerCase();
            if (toolName.includes('grep') || toolName.includes('glob') || toolName.includes('ls')) {
                logActivity('SEARCH', `${tc.function.name}: ${toolInput.pattern || toolInput.glob || toolInput.path || ''}`);
                if (toolInput.glob && (toolInput.glob === '**/*' || toolInput.glob === '**')) {
                    toolInput.glob = '{src,app,public,lib,electron}/**/*';
                }
                if (toolInput.include_pattern && !toolInput.exclude_pattern) {
                    toolInput.exclude_pattern = 'node_modules/.*|\\.git/.*|dist/.*|build/.*';
                }
            }
            if (toolName.includes('read')) {
                const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
                if (filePath) logActivity('READ', filePath);
            }

            content.push({
                type: 'tool_use',
                id: anthropicId,
                name: tc.function.name,
                input: toolInput
            });
        });
    }

    // Map upstream finish_reason to Anthropic stop_reason
    const finishReason = openaiData.choices?.[0]?.finish_reason;
    let stopReason = 'end_turn';
    if (toolCalls.length > 0) {
        stopReason = 'tool_use';
    } else if (finishReason === 'length') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'stop') {
        stopReason = 'end_turn';
    }

    return {
        id: 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: content,
        model: requestModel || CLAUDE_PUBLIC_MODEL_ALIAS,
        stop_reason: stopReason,
        usage: {
            input_tokens: openaiData.usage?.prompt_tokens || 1,
            output_tokens: openaiData.usage?.completion_tokens || 1
        }
    };
}

// ── Main handler for /v1/messages ──
async function handleMessages(req, res, cleanPath, reqId) {
    const clientId = req.augustClientId || 'unknown';
    let body = '';
    const abortCtrl = new AbortController();
    const handleAbort = () => {
        if (req.aborted || (req.socket?.destroyed && !res.writableEnded)) {
            abortCtrl.abort();
        }
    };
    if (!req.signal) {
        req.on('aborted', handleAbort);
        req.on('close', handleAbort);
    }
    if (req.signal) {
        if (req.signal.aborted) {
            abortCtrl.abort();
        } else {
            req.signal.addEventListener('abort', handleAbort);
        }
    }
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {

        // ── Per-request tracking — endRequest must fire exactly once ──
        let requestModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let clientFacingModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let requestStatus = 'success';
        let requestError = null;
        let _endCalled = false;
        function finishRequest() {
            if (_endCalled) return;
            _endCalled = true;
            req.off('aborted', handleAbort);
            req.off('close', handleAbort);
            if (req.signal) req.signal.removeEventListener('abort', handleAbort);
            endRequest(reqId, {
                status: requestStatus,
                model: clientFacingModel,
                error: requestError
                // tokens are pulled automatically from requestDetails by endRequest
            });
        }

        try {
            const aReq = JSON.parse(body);
            const baseCfg = getProfile('claude');
            requestModel = resolveClaudePublicModelAlias(aReq.model);
            clientFacingModel = resolveClaudeClientFacingModel(aReq.model);
            syncClaudePublicAlias(requestModel);
            const cfg = resolveClaudeUpstreamConfig(baseCfg, requestModel);

            // ── Per-model provider routing ──
            // If the requested model maps to a specific configured provider
            // (e.g. deepseek-chat -> deepseek), route to that provider's
            // baseUrl/apiKey instead of the claude profile's targetUrl.
            // This lets OpenAI-compatible models work through Claude Code
            // (/v1/messages) — the request is translated to OpenAI format
            // and forwarded to the matched provider.
            const incomingModel = typeof aReq.model === 'string' ? aReq.model.trim() : '';
            const aliasDetails = incomingModel ? await resolveModelAliasDetails(incomingModel) : { modelId: incomingModel, provider: '' };
            const requestedRaw = aliasDetails.modelId || incomingModel;
            const routeLookupModel = incomingModel && !isClaudeFamilyModel(incomingModel) ? incomingModel : requestedRaw;
            if (requestedRaw && !isClaudeFamilyModel(requestedRaw)) {
                try {
                    const { resolveProviderForModel } = require('../providers/route-resolver');
                    const routed = resolveProviderForModel(routeLookupModel) || resolveProviderForModel(requestedRaw);
                    if (routed && routed.baseUrl && routed.apiKey && routed.name !== 'anthropic') {
                        cfg.targetUrl = toOpenAiCompatibleTargetUrl(routed.baseUrl);
                        cfg.apiKey = routed.apiKey;
                        // Send the actual requested model upstream — not the claude
                        // profile's _upstreamModel. Without this, a Claude Code
                        // request for deepseek-v4 would reach opencode-zen as the
                        // wrong model (e.g. deepseek-v4-flash) and fail/abort.
                        cfg._upstreamModel = requestedRaw;
                        cfg.currentModel = requestedRaw;
                        console.log(`[Proxy Model Route]: ${requestedRaw} -> provider ${routed.name} (${routed.baseUrl})`);
                    }
                } catch (e) {
                    console.warn('[Proxy Model Route] resolution failed:', e.message);
                }
            }

            const upstreamModel = shouldPreserveClaudeAliasForAnthropicUpstream(requestModel)
                ? requestModel
                : (cfg._upstreamModel || getClaudeBackendModel(cfg, aReq.model));
            if (cfg.publicModelAlias && upstreamModel) {
                console.log(`[Proxy Alias Route]: ${cfg.publicModelAlias} -> ${upstreamModel}`);
            }
            logActivity('AGENT', `Claude request using ${requestModel} -> ${upstreamModel}`);

            if (shouldUseAnthropicUpstream(cfg.targetUrl)) {
                console.log('[Proxy] Using Anthropic-compatible upstream path');
                const ctx = { managedLocalToolNames: new Set() };
                let upstreamReq = buildAnthropicUpstreamRequest(aReq, cfg, upstreamModel, clientId);
                
                // Run fallback recovery for any client tool executions that failed
                await fallbackClientFailedToolsAnthropic(upstreamReq);
                
                // Mark all proxy-managed tools for local resolution -- no provider guard.
                // This covers web, Cowork compatibility, August memory, and running MCP servers.
                const clientToolNames = new Set((aReq.tools || []).map(t => t.name || t.function?.name).filter(Boolean));
                const localTools = upstreamReq.tools?.filter(t => isProxyManagedLocalToolName(t?.name) && !clientToolNames.has(t?.name)) || [];
                if (localTools.length > 0) {
                    console.log('[Proxy] Marking proxy-managed tools for local resolution:', localTools.map(t => t.name));
                    localTools.forEach(t => ctx.managedLocalToolNames.add(t.name));
                }
                
                upstreamReq = normalizeAnthropicToolsForNativeUpstream(upstreamReq, ctx);

                // Keep upstream streaming enabled when the client wants SSE; intercept managed tool deltas locally instead.
                const clientWantsStream = aReq.stream === true;
                if (ctx.managedLocalToolNames.size > 0 && clientWantsStream) {
                    console.log('[Proxy] Streaming upstream for managed Anthropic tool interception');
                    upstreamReq.stream = true;
                }
                console.log(`[Proxy Debug Claude]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);
                console.log('[Proxy Debug Tools]:', JSON.stringify({ 
                    toolCount: upstreamReq.tools?.length || 0,
                    toolNames: upstreamReq.tools?.map(t => t.name) || [],
                    managedLocalToolNames: Array.from(ctx.managedLocalToolNames)
                }));
                captureRequest(reqId, { ...upstreamReq, model: clientFacingModel, endpoint: cleanPath });

                let response;
                let attempts = 0;
                const maxAttempts = 3;
                while (attempts < maxAttempts) {
                    attempts++;
                    const localAbortCtrl = new AbortController();
                    const onParentAbort = () => localAbortCtrl.abort();
                    if (abortCtrl.signal.aborted) {
                        throw new Error('Request aborted by client');
                    }
                    abortCtrl.signal.addEventListener('abort', onParentAbort);
                    const timeoutId = setTimeout(() => {
                        localAbortCtrl.abort();
                    }, 300000);
                    try {
                        response = await fetch(cfg.targetUrl, {
                            method: 'POST',
                            headers: buildAnthropicHeaders(cfg.apiKey),
                            body: JSON.stringify(upstreamReq),
                            signal: localAbortCtrl.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                        abortCtrl.signal.removeEventListener('abort', onParentAbort);
                    }
                    if (!isRetryableStatus(response.status) || attempts >= maxAttempts) {
                        break;
                    }
                    const delayMs = getRetryDelayMs(response, attempts);
                    console.warn(`[Proxy Retry]: Anthropic upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

                const rawBody = await response.text();
                if (clientWantsStream && !isClaudeDesktop3pClient(req) && (response.headers.get('content-type') || '').includes('text/event-stream')) {
                    const parsed = ctx.managedLocalToolNames.size > 0
                        ? await streamUpstreamAndResolveToolsAnthropic({
                            response,
                            res,
                            reqId,
                            clientFacingModel,
                            upstreamReq,
                            cfg,
                            clientToolNames,
                            managedLocalToolNames: ctx.managedLocalToolNames,
                            workspacePath: null,
                            parentSignal: abortCtrl.signal
                        })
                        : await streamAnthropicSSEToClient(response, res, reqId, clientFacingModel);

                    if (parsed?.stop_reason === 'end_turn') {
                        console.log('[Auto-Memory] end_turn detected, launching extraction...');
                        const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                        extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                    }
                    return; // finishRequest() runs in finally
                }

                if (!response.ok) {
                    console.error('[Proxy Error] Minimax rejected request:', {
                        status: response.status,
                        body: rawBody.substring(0, 500),
                        toolCount: upstreamReq.tools?.length || 0,
                        toolNames: upstreamReq.tools?.map(t => t.name).slice(0, 10) || []
                    });
                    throw new Error(
                        response.status === 429
                            ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                            : `Upstream Error (${response.status}): ${rawBody}`
                    );
                }

                const contentType = response.headers.get('content-type') || 'application/json';
                let clientBody = rewriteAnthropicResponseModel(rawBody, contentType, clientFacingModel);
                console.log('[Proxy Debug Claude Upstream Headers]:', JSON.stringify(summarizeHeaders(response.headers)));
                console.log('[Proxy Debug Claude Upstream Body]:', JSON.stringify(extractModelHintsFromBody(rawBody, contentType)));
                console.log('[Proxy Debug Claude Client Body]:', JSON.stringify(extractModelHintsFromBody(clientBody, contentType)));
                
                // Log if response contains tool_use blocks
                if (contentType.includes('application/json')) {
                    try {
                        const parsed = JSON.parse(clientBody);
                        const toolUses = Array.isArray(parsed?.content) 
                            ? parsed.content.filter(b => b?.type === 'tool_use')
                            : [];
                        if (toolUses.length > 0) {
                            console.log('[Proxy Debug Tool Uses]:', JSON.stringify(toolUses.map(t => ({
                                name: t.name,
                                id: t.id,
                                hasInput: !!t.input
                            }))));
                        }
                    } catch (e) { /* ignore */ }
                }

                if (contentType.includes('text/event-stream')) {
                    // SSE stream: reconstruct full response to capture it for debug UI
                    try {
                        let parsed = parseAnthropicSSEToJSON(rawBody);
                        if (isClaudeDesktop3pClient(req)) {
                            // Capture BEFORE normalizing so thinking blocks are preserved in the debug UI
                            captureResponse(reqId, parsed);
                            captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
                            parsed = normalizeAnthropicResponseForClaudeDesktop3p(parsed);
                            sendSimulatedAnthropicStream(res, parsed, clientFacingModel);

                            if (parsed.stop_reason === 'end_turn') {
                                console.log('[Auto-Memory] end_turn detected (3P desktop flow), launching extraction...');
                                const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                                extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                            }
                            return; // finishRequest() runs in finally
                        }

                        captureResponse(reqId, parsed);
                        captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);

                        // --- AUTO-MEMORY BACKGROUND EXTRACTION ---
                        if (parsed.stop_reason === 'end_turn') {
                            const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                            extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                        }
                    } catch (e) {
                        console.warn('[Proxy SSE Parse Warning]: Failed to reconstruct Anthropic response for capture:', e.message);
                    }
                } else if (contentType.includes('application/json')) {
                    try {
                        let parsed = JSON.parse(clientBody);
                        if (ctx.managedLocalToolNames.size > 0) {
                            if (clientWantsStream) {
                                writeAnthropicSSEHeaders(res);
                                streamAnthropicMessageStart(res, parsed, clientFacingModel);
                                let blockIndex = 0;
                                blockIndex += streamAnthropicContentBlocks(res, parsed, blockIndex);

                                const onToolEvent = (evt) => {
                                    if (!evt || typeof evt !== 'object') return;
                                    if (evt.type === 'thinking') {
                                        streamAnthropicContentBlock(res, { type: 'thinking', thinking: evt.content || evt.thinking || '' }, blockIndex++);
                                    } else if (evt.type === 'text') {
                                        streamAnthropicContentBlock(res, { type: 'text', text: evt.content || evt.text || '' }, blockIndex++);
                                    } else if (evt.type === 'tool_use') {
                                        streamAnthropicContentBlock(res, {
                                            type: 'tool_use',
                                            id: evt.id || 'toolu_' + Math.random().toString(36).substring(2, 14),
                                            name: evt.name,
                                            input: normalizeToolUseInput(evt.input ?? evt.arguments)
                                        }, blockIndex++);
                                    } else {
                                        writeAnthropicToolEvent(res, evt);
                                    }
                                };

                                try {
                                    parsed = await resolveManagedAnthropicToolUses(parsed, upstreamReq, cfg, clientToolNames, null, onToolEvent, abortCtrl.signal, false);
                                    parsed.model = clientFacingModel;
                                    captureResponse(reqId, parsed);
                                    captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
                                    blockIndex += streamAnthropicContentBlocks(res, parsed, blockIndex);
                                    streamAnthropicMessageEnd(res, parsed);
                                    res.end();

                                    if (parsed.stop_reason === 'end_turn') {
                                        console.log('[Auto-Memory] end_turn detected, launching extraction...');
                                        const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                                        extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                                    }
                                    return;
                                } catch (e) {
                                    streamAnthropicErrorAndEnd(res, e.message, blockIndex);
                                    return;
                                }
                            } else {
                                parsed = await resolveManagedAnthropicToolUses(parsed, upstreamReq, cfg, clientToolNames, null, null, abortCtrl.signal);
                                parsed.model = clientFacingModel;
                            }
                        }
                        // Capture BEFORE normalizing so thinking blocks are preserved in the debug UI
                        captureResponse(reqId, parsed);
                        captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
                        if (isClaudeDesktop3pClient(req)) {
                            parsed = normalizeAnthropicResponseForClaudeDesktop3p(parsed);
                        }
                        clientBody = JSON.stringify(parsed);

                        // KEY FIX: if the client originally wanted a stream, simulate one now
                        // from the fully-resolved JSON so Claude Desktop gets proper SSE events.
                        if (clientWantsStream && ctx.managedLocalToolNames.size > 0) {
                            sendSimulatedAnthropicStream(res, parsed, clientFacingModel);
                            
                            // --- AUTO-MEMORY BACKGROUND EXTRACTION ---
                            if (parsed.stop_reason === 'end_turn') {
                                console.log('[Auto-Memory] end_turn detected, launching extraction...');
                                const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                                extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                            }
                            return; // finishRequest() runs in finally
                        }

                        // --- AUTO-MEMORY BACKGROUND EXTRACTION (Non-stream tool resolution case) ---
                        if (parsed.stop_reason === 'end_turn') {
                            console.log('[Auto-Memory] end_turn detected (non-stream path), launching extraction...');
                            const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                            extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                        }
                    } catch (e) { /* ignore */ }
                }

                res.writeHead(200, { 'Content-Type': contentType });
                res.end(clientBody);
                return; // finishRequest() runs in finally
            }

            // Per-request context isolates tool state so multiple clients can
            // call the proxy concurrently without ID collisions.
            const ctx = { lastKnownTools: [], managedLocalToolNames: new Set() };
            const oReq = await buildOpenAIRequest(aReq, ctx, cfg, clientId);
            console.log(`[Proxy Debug Claude]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);

            // Capture request for debug UI
            captureRequest(reqId, { ...oReq, model: clientFacingModel, endpoint: cleanPath });

            let response;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                attempts++;
                const localAbortCtrl = new AbortController();
                const onParentAbort = () => localAbortCtrl.abort();
                if (abortCtrl.signal.aborted) {
                    throw new Error('Request aborted by client');
                }
                abortCtrl.signal.addEventListener('abort', onParentAbort);
                const timeoutId = setTimeout(() => {
                    localAbortCtrl.abort();
                }, 300000);
                try {
                    response = await fetch(cfg.targetUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${cfg.apiKey}`
                        },
                        body: JSON.stringify(oReq),
                        signal: localAbortCtrl.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                    abortCtrl.signal.removeEventListener('abort', onParentAbort);
                }
                if (isRetryableStatus(response.status) && attempts < maxAttempts) {
                    const delayMs = getRetryDelayMs(response, attempts);
                    console.warn(`[Proxy Retry]: OpenAI-compatible upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                break;
            }

            const rawBody = await response.text();
            if (!response.ok) {
                throw new Error(
                    response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`
                );
            }

            const upstreamIsStream = response.headers.get('content-type')?.includes('text/event-stream');
            if (aReq.stream === true && upstreamIsStream && !isClaudeDesktop3pClient(req)) {
                if (!response.ok) {
                    const errorBody = await response.text();
                    throw new Error(
                        response.status === 429
                            ? buildFriendlyRateLimitMessage(response.status, errorBody, attempts)
                            : `Upstream Error (${response.status}): ${errorBody}`
                    );
                }
                const parsed = await streamOpenAiUpstreamToAnthropicClient({
                    response,
                    res,
                    reqId,
                    clientFacingModel,
                    oReq,
                    cfg,
                    clientToolNames: new Set((aReq.tools || []).map(t => t.name || t.function?.name).filter(Boolean)),
                    managedLocalToolNames: ctx.managedLocalToolNames,
                    workspacePath: null,
                    parentSignal: abortCtrl.signal
                });
                if (parsed.choices?.[0]?.finish_reason === 'stop') {
                    console.log('[Auto-Memory] stop detected (OpenAI translation path), launching extraction...');
                    const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                    extractAndSaveMemories(aReq.messages, parsed, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
                }
                return;
            }

            let data;
            if (upstreamIsStream) {
                data = parseSSEToJSON(rawBody);
            } else {
                data = JSON.parse(rawBody);
                if (data.data && data.data.choices) data = data.data;
            }

            console.log('[Proxy Debug Claude OpenAI Upstream]:', JSON.stringify({
                upstreamModel: data?.model || null,
                publicModel: requestModel,
                backendModel: upstreamModel,
                finishReason: data?.choices?.[0]?.finish_reason || null
            }));

            captureResponse(reqId, data);

            const upUsage = data.usage || {};
            const upInputTokens = upUsage.prompt_tokens || upUsage.input_tokens || 0;
            const upOutputTokens = upUsage.completion_tokens || upUsage.output_tokens || 0;
            captureTokens(reqId, upInputTokens, upOutputTokens);

            const upChoice = data.choices?.[0];
            const finishReason = upChoice?.finish_reason || 'N/A';
            console.log(`[Proxy Upstream]: finish_reason="${finishReason}", content_len=${upChoice?.message?.content?.length || 0}, max_tokens_sent=${oReq.max_tokens || 'default'}`);
            if (finishReason === 'length') {
                console.warn(`[Proxy WARNING]: Upstream stopped due to max_tokens limit! Response was truncated.`);
            }
            console.log(`[Proxy Upstream]: usage in=${upInputTokens} out=${upOutputTokens}, reasoning=${!!(upChoice?.message?.reasoning || upChoice?.message?.reasoning_content)}`);

            const preludeEvents = [];
            if (ctx.managedLocalToolNames.size > 0) {
                data = await resolveManagedWebToolCalls(data, oReq, cfg, new Set((aReq.tools || []).map(t => t.name || t.function?.name).filter(Boolean)), null, (evt) => {
                    preludeEvents.push(evt);
                }, abortCtrl.signal, true);
            }

            const aRes = translateOpenAIResponse(data, clientFacingModel, ctx);

            // --- AUTO-MEMORY BACKGROUND EXTRACTION (OpenAI translation path) ---
            if (finishReason === 'stop') {
                const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                extractAndSaveMemories(aReq.messages, data, cfg, upstreamModel, clientId).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));
            }

            if (aReq.stream === true) {
                sendSimulatedAnthropicStream(res, aRes, clientFacingModel, preludeEvents);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(aRes));
            }
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            captureError(reqId, e);
            console.error('Anthropic Adapter Error:', e);
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Bridge Error: ' + e.message }],
                model: clientFacingModel,
                usage: { input_tokens: 1, output_tokens: 1 }
            }));
        } finally {
            finishRequest(); // always fires exactly once
        }
    });
}



// ── Handler for /v1/messages/count_tokens ──
async function handleCountTokens(req, res, cleanPath, reqId) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        let requestModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let clientFacingModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let requestStatus = 'success';
        let requestError = null;
        let inputTokens = 0;
        let outputTokens = 0;
        try {
            const aReq = JSON.parse(body);
            requestModel = resolveClaudePublicModelAlias(aReq.model);
            clientFacingModel = resolveClaudeClientFacingModel(aReq.model);
            syncClaudePublicAlias(requestModel);
            const baseCfg = getProfile('claude');
            const cfg = resolveClaudeUpstreamConfig(baseCfg, requestModel);
            const upstreamModel = shouldPreserveClaudeAliasForAnthropicUpstream(requestModel)
                ? requestModel
                : getClaudeBackendModel(cfg, aReq.model);
            console.log(`[Proxy Debug CountTokens]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);

            captureRequest(reqId, { ...aReq, model: clientFacingModel, endpoint: cleanPath });

            const targetUrl = cfg.targetUrl
                ? cfg.targetUrl.replace(/\/v1\/messages$/, '') + '/v1/messages/count_tokens'
                : null;

            if (!targetUrl) throw new Error('No targetUrl configured for Claude profile');

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: buildAnthropicHeaders(cfg.apiKey),
                body: JSON.stringify({
                    ...aReq,
                    model: upstreamModel
                }),
                signal: AbortSignal.timeout(60000)
            });

            const rawBody = await response.text();
            if (!response.ok) {
                throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
            }
            console.log('[Proxy Debug CountTokens Headers]:', JSON.stringify(summarizeHeaders(response.headers)));
            console.log('[Proxy Debug CountTokens Body]:', rawBody);

            try {
                const parsed = JSON.parse(rawBody);
                // count_tokens returns { input_tokens: N }
                inputTokens = parsed.input_tokens || 0;
                outputTokens = parsed.output_tokens || 0;
                captureResponse(reqId, parsed);
            } catch (e) { /* ignore */ }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(rawBody);
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            captureError(reqId, e);
            console.error('[Count Tokens Error]:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        } finally {
            endRequest(reqId, {
                status: requestStatus,
                model: clientFacingModel,
                error: requestError,
                inputTokens,
                outputTokens
            });
        }
    });
}

module.exports = {
    handleMessages,
    handleCountTokens,
    AUGUST_REMINDER,
    RULE_REMINDER_MESSAGE,
    CLAUDE_CODE_NATIVE_GUARD,
    hasClaudeCodeNativeTooling,
    buildClaudeCodeNativeGuidance,
    appendTextToSystemBlocks,
    executeManagedProxyTool,
    shouldInjectReminderMessage,
    shouldInjectAugustReminder
};
