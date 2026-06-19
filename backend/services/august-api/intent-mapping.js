/**
 * Deterministic natural-language → August API intent mapping.
 *
 * Helps the LLM self-route when it isn't sure which `august__*` tool to call.
 * Returns `{ tool, action, target?, rationale }` or `null` if no match.
 *
 * Matched intents:
 *   delete / archive session         → august__sessions_manage
 *   add / create provider            → august__providers_manage
 *   change / switch / select model   → august__models_select
 *   open / show settings             → august__ui_control navigate /settings[/<sub>]
 *   create / write / save file       → august__filesystem_write
 *   remember / save fact             → august__memory_manage
 *   launch / open app                → august__system_process start OR computer_launch
 */

const SETTINGS_SUBROUTES = {
    'memory': '/settings/memory-knowledge',
    'memory knowledge': '/settings/memory-knowledge',
    'memory-knowledge': '/settings/memory-knowledge',
    'models': '/settings/model-providers',
    'providers': '/settings/model-providers',
    'tools': '/settings/tools-connections',
    'connections': '/settings/tools-connections',
    'agents': '/settings/agents-automation',
    'automation': '/settings/agents-automation',
    'history': '/settings/conversations-history',
    'conversations': '/settings/conversations-history',
    'profile': '/settings/profile-preferences',
    'preferences': '/settings/profile-preferences'
};

function mapAugustIntent(text) {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase();

    // ---- Sessions ----
    if (/\b(delete|remove|trash)\b.*\b(session|conversation|chat)\b/.test(lower)) {
        return {
            tool: 'august__sessions_manage',
            action: 'delete',
            rationale: 'Mentions deleting a session.'
        };
    }
    if (/\b(archive|close|end)\b.*\b(session|conversation|chat)\b/.test(lower)) {
        return {
            tool: 'august__sessions_manage',
            action: 'archive',
            rationale: 'Mentions archiving a session.'
        };
    }
    if (/\b(start|new|begin)\b.*\b(session|conversation|chat)\b/.test(lower)) {
        return {
            tool: 'august__sessions_manage',
            action: 'create',
            rationale: 'Mentions starting a new session.'
        };
    }

    // ---- Providers ----
    if (/\b(add|create|register|configure|set up)\b.*\b(provider|backend|api key)\b/.test(lower)) {
        return {
            tool: 'august__providers_manage',
            action: 'upsert',
            rationale: 'Mentions adding or creating a provider.'
        };
    }
    if (/\b(remove|delete)\b.*\b(provider|backend)\b/.test(lower)) {
        return {
            tool: 'august__providers_manage',
            action: 'delete',
            rationale: 'Mentions removing a provider.'
        };
    }

    // ---- Models ----
    if (/\b(change|switch|select|set|use)\b.*\b(model|llm)\b/.test(lower)) {
        const m = lower.match(/\b(?:to|use|with)\s+([a-z0-9._-]+)/);
        return {
            tool: 'august__models_select',
            action: 'select',
            model: m ? m[1] : null,
            rationale: 'Mentions changing the selected model.'
        };
    }

    // ---- Settings navigation ----
    if (/\b(open|show|navigate|go to)\b.*\b(settings?)\b/.test(lower)) {
        // Try to match a sub-section. Look for these phrases anywhere in the input.
        let target = '/settings';
        for (const [key, route] of Object.entries(SETTINGS_SUBROUTES)) {
            if (lower.includes(key)) {
                target = route;
                break;
            }
        }
        return {
            tool: 'august__ui_control',
            action: 'navigate',
            target,
            rationale: 'Mentions opening settings.'
        };
    }

    // ---- Filesystem ----
    if (/\b(create|write|save|new)\b.*\b(file|document|markdown|note|script)\b/.test(lower)) {
        return {
            tool: 'august__filesystem_write',
            action: 'write',
            rationale: 'Mentions creating or writing a file.'
        };
    }
    if (/\b(delete|remove)\b.*\b(file|document)\b/.test(lower)) {
        return {
            tool: 'august__filesystem_delete',
            action: 'delete',
            rationale: 'Mentions deleting a file.'
        };
    }

    // ---- Memory ----
    if (/\b(remember|save|note|store)\b.*\b(fact|info|detail|preference|prefer|favorite|setting)\b/.test(lower)) {
        return {
            tool: 'august__memory_manage',
            action: 'set',
            rationale: 'Mentions saving a memory fact.'
        };
    }
    if (/\b(forget|remove|delete)\b.*\b(fact|memory|info)\b/.test(lower)) {
        return {
            tool: 'august__memory_manage',
            action: 'delete',
            rationale: 'Mentions removing a memory fact.'
        };
    }

    // ---- Process / app launch ----
    if (/\b(launch|open|start|run)\b.*\b(app|application|process|program)\b/.test(lower)) {
        return {
            tool: 'august__system_process',
            action: 'start',
            rationale: 'Mentions launching an app or process.'
        };
    }

    return null;
}

module.exports = {
    mapAugustIntent,
    SETTINGS_SUBROUTES
};
