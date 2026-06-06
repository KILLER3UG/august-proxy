const http = require('http');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PROXY_URL = process.env.AUGUST_PROXY_URL || 'http://127.0.0.1:8085';

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgCyan: '\x1b[46m',
    black: '\x1b[30m'
};

const THEMES = {
    midnight: {
        name: 'midnight',
        accent: ANSI.cyan,
        accent2: ANSI.blue,
        ok: ANSI.green,
        warn: ANSI.yellow,
        error: ANSI.red,
        muted: ANSI.gray,
        text: ANSI.white,
        inverse: ANSI.bgCyan + ANSI.black,
        frames: ['[=   ]', '[==  ]', '[ == ]', '[  ==]', '[   =]', '[  ==]', '[ == ]', '[==  ]'],
        verbs: ['thinking', 'mapping', 'checking']
    },
    ember: {
        name: 'ember',
        accent: ANSI.yellow,
        accent2: ANSI.magenta,
        ok: ANSI.green,
        warn: ANSI.yellow,
        error: ANSI.red,
        muted: ANSI.gray,
        text: ANSI.white,
        inverse: ANSI.yellow + ANSI.black,
        frames: ['{*   }', '{**  }', '{ ** }', '{  **}', '{   *}', '{  **}', '{ ** }', '{**  }'],
        verbs: ['forging', 'checking', 'shaping']
    },
    slate: {
        name: 'slate',
        accent: ANSI.blue,
        accent2: ANSI.cyan,
        ok: ANSI.green,
        warn: ANSI.yellow,
        error: ANSI.red,
        muted: ANSI.gray,
        text: ANSI.white,
        inverse: ANSI.blue + ANSI.black,
        frames: ['<.   >', '<..  >', '< .. >', '<  ..>', '<   .>', '<  ..>', '< .. >', '<..  >'],
        verbs: ['planning', 'scanning', 'verifying']
    },
    mono: {
        name: 'mono',
        accent: ANSI.white,
        accent2: ANSI.gray,
        ok: ANSI.white,
        warn: ANSI.white,
        error: ANSI.white,
        muted: ANSI.gray,
        text: ANSI.white,
        inverse: ANSI.bold,
        frames: ['[-   ]', '[--  ]', '[ -- ]', '[  --]', '[   -]', '[  --]', '[ -- ]', '[--  ]'],
        verbs: ['thinking', 'reading', 'checking']
    }
};

const BASE_COMMANDS = [
    {
        name: 'help',
        aliases: ['h', '?'],
        category: 'Info',
        description: 'Show August terminal help.',
        local: true
    },
    {
        name: 'commands',
        aliases: ['cmds', 'palette', '/'],
        category: 'Info',
        description: 'Browse slash commands, skills, and Workbench tools.',
        args: '[query]',
        local: true
    },
    {
        name: 'status',
        aliases: ['s', 'usage', 'cost', 'stats'],
        category: 'Session',
        description: 'Show session, provider, approval, and capability status.',
        local: true
    },
    {
        name: 'new',
        aliases: ['reset'],
        category: 'Session',
        description: 'Start a fresh August Workbench session.',
        local: true
    },
    {
        name: 'retry',
        aliases: ['again'],
        category: 'Session',
        description: 'Retry the last user message.',
        local: true
    },
    {
        name: 'provider',
        aliases: ['model-route', 'model'],
        category: 'Session',
        description: 'Switch between Claude-shaped and Codex-shaped proxy routes.',
        args: '[claude|codex]',
        local: true
    },
    {
        name: 'agent',
        category: 'Session',
        description: 'Switch Workbench agent profile.',
        args: '[build|plan|explore|general]',
        local: true
    },
    {
        name: 'plan',
        aliases: ['p'],
        category: 'Plan',
        description: 'Ask August to create a plan first and wait for approval.',
        args: '<task>',
        insert: 'Create a plan first and wait for my approval before changing anything: '
    },
    {
        name: 'approve',
        aliases: ['yes'],
        category: 'Plan',
        description: 'Approve the submitted Workbench plan.',
        local: true
    },
    {
        name: 'build',
        aliases: ['implement', 'run-plan'],
        category: 'Plan',
        description: 'Plan if needed, or implement the approved plan.',
        args: '[task]',
        local: true
    },
    {
        name: 'tools',
        aliases: ['permissions', 'permission', 'allowed-tools', 'mcp'],
        category: 'Tools',
        description: 'List Workbench tools grouped by capability.',
        local: true
    },
    {
        name: 'skills',
        category: 'Tools',
        description: 'List available proxy skills.',
        local: true
    },
    {
        name: 'agents',
        category: 'Tools',
        description: 'List Workbench agents and inherited permissions.',
        local: true
    },
    {
        name: 'fetch-skill',
        aliases: ['skill'],
        category: 'Tools',
        description: 'Ask August to find and preview a GitHub or web skill.',
        args: '<topic-or-url>',
        insert: 'Find a skill from the internet or GitHub for: '
    },
    {
        name: 'diagnose',
        aliases: ['ask-doctor'],
        category: 'Tools',
        description: 'Ask August to diagnose proxy health, memory, MCP, and tools.',
        insert: 'Diagnose the proxy health, August Brain, MCP, tools, and recent errors.'
    },
    {
        name: 'doctor-local',
        aliases: ['doctor', 'health'],
        category: 'Tools',
        description: 'Run a local endpoint health summary without calling the model.',
        local: true
    },
    {
        name: 'copy',
        category: 'View',
        description: 'Copy the last assistant response to the clipboard.',
        local: true
    },
    {
        name: 'btw',
        category: 'View',
        description: 'Ask a no-tools side question against the current session.',
        args: '<question>',
        local: true
    },
    {
        name: 'goal',
        category: 'Plan',
        description: 'Set, show, or clear the active Workbench goal loop.',
        args: '[status|clear|condition]',
        local: true
    },
    {
        name: 'thinking',
        category: 'View',
        description: 'Show or hide captured thinking text.',
        args: '[on|off|status]',
        local: true
    },
    {
        name: 'theme',
        aliases: ['skin', 'themes'],
        category: 'View',
        description: 'Change terminal theme.',
        args: '[midnight|ember|slate|mono]',
        local: true
    },
    {
        name: 'tui',
        aliases: ['renderer'],
        category: 'View',
        description: 'Show the active terminal renderer.',
        args: '[default]',
        local: true
    },
    {
        name: 'clear',
        aliases: ['cls'],
        category: 'View',
        description: 'Clear the terminal screen.',
        local: true
    },
    {
        name: 'web',
        category: 'View',
        description: 'Open the optional browser console.',
        local: true
    },
    {
        name: 'exit',
        aliases: ['quit', 'q'],
        category: 'Exit',
        description: 'Exit August terminal.',
        local: true
    }
];

function parseArgs(argv = []) {
    const options = {
        proxyUrl: DEFAULT_PROXY_URL,
        provider: 'claude',
        agentId: 'build',
        theme: process.env.AUGUST_THEME || 'midnight',
        color: !process.env.NO_COLOR,
        once: null,
        selfTest: false,
        web: false,
        urlOnly: false,
        noOpen: false,
        showThinking: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--proxy' || arg === '--proxy-url') options.proxyUrl = argv[++i] || options.proxyUrl;
        else if (arg.startsWith('--proxy=')) options.proxyUrl = arg.slice('--proxy='.length);
        else if (arg === '--provider') options.provider = normalizeProvider(argv[++i]);
        else if (arg.startsWith('--provider=')) options.provider = normalizeProvider(arg.slice('--provider='.length));
        else if (arg === '--agent') options.agentId = normalizeAgentId(argv[++i]);
        else if (arg.startsWith('--agent=')) options.agentId = normalizeAgentId(arg.slice('--agent='.length));
        else if (arg === '--theme') options.theme = argv[++i] || options.theme;
        else if (arg.startsWith('--theme=')) options.theme = arg.slice('--theme='.length);
        else if (arg === '--no-color') options.color = false;
        else if (arg === '--thinking') options.showThinking = true;
        else if (arg === '--once') options.once = argv[++i] || '';
        else if (arg.startsWith('--once=')) options.once = arg.slice('--once='.length);
        else if (arg === '--self-test') options.selfTest = true;
        else if (arg === '--web' || arg === '--browser') options.web = true;
        else if (arg === '--url-only') options.urlOnly = true;
        else if (arg === '--no-open') options.noOpen = true;
        else if (!arg.startsWith('--') && options.once === null) options.once = argv.slice(i).join(' ');
    }
    options.proxyUrl = String(options.proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
    options.provider = normalizeProvider(options.provider);
    options.agentId = normalizeAgentId(options.agentId);
    if (!THEMES[options.theme]) options.theme = 'midnight';
    return options;
}

function normalizeProvider(value) {
    return String(value || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
}

function normalizeAgentId(value) {
    const normalized = String(value || '').toLowerCase();
    return ['build', 'plan', 'explore', 'general'].includes(normalized) ? normalized : 'build';
}

function terminalWidth() {
    return Math.max(60, Math.min(process.stdout.columns || 96, 140));
}

function visibleLength(text) {
    return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').length;
}

function truncate(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 3)) + '...';
}

function stripMarkdown(text) {
    return String(text || '')
        .replace(/```([\s\S]*?)```/g, (_, code) => '\n' + code.trim() + '\n')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .trim();
}

function wrapLine(line, width) {
    const words = String(line || '').split(/(\s+)/);
    const rows = [];
    let current = '';
    for (const word of words) {
        if (!word) continue;
        if (/^\s+$/.test(word)) {
            if (current && !current.endsWith(' ')) current += ' ';
            continue;
        }
        if (visibleLength(current + word) > width && current) {
            rows.push(current.trimEnd());
            current = '';
        }
        if (visibleLength(word) > width) {
            if (current) rows.push(current.trimEnd());
            for (let i = 0; i < word.length; i += width) rows.push(word.slice(i, i + width));
            current = '';
        } else {
            current += word;
        }
    }
    if (current) rows.push(current.trimEnd());
    return rows.length ? rows : [''];
}

function wrapText(text, width, prefix = '') {
    const rows = [];
    const available = Math.max(24, width - visibleLength(prefix));
    String(text || '').split(/\r?\n/).forEach(line => {
        wrapLine(line, available).forEach((wrapped, index) => {
            rows.push((index === 0 ? prefix : ' '.repeat(visibleLength(prefix))) + wrapped);
        });
    });
    return rows.join('\n');
}

function groupBy(items, keyFn) {
    const groups = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}

function requestRaw(method, urlString, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
            method,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                ...headers
            }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => req.destroy(new Error('Request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

async function requestJson(method, url, body) {
    const res = await requestRaw(method, url, body);
    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch (e) {}
    if (res.statusCode < 200 || res.statusCode >= 300) {
        const message = data?.error || data?.message || res.body || `HTTP ${res.statusCode}`;
        const error = new Error(message);
        error.statusCode = res.statusCode;
        error.data = data;
        throw error;
    }
    return data;
}

function createSseParser(onEvent) {
    let buffer = '';
    let eventName = '';
    let dataLines = [];
    function dispatch() {
        if (!eventName && !dataLines.length) return;
        const raw = dataLines.join('\n');
        const event = eventName || 'message';
        eventName = '';
        dataLines = [];
        if (!raw || raw === '[DONE]') return;
        try { onEvent(event, JSON.parse(raw)); } catch (e) {}
    }
    return chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line === '') dispatch();
            else if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
    };
}

function requestSse(method, urlString, body, onEvent) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const client = url.protocol === 'https:' ? https : http;
        const parser = createSseParser(onEvent);
        const req = client.request(url, {
            method,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                Accept: 'text/event-stream'
            }
        }, res => {
            if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let message = text || `HTTP ${res.statusCode}`;
                    try { message = JSON.parse(text).error || message; } catch (e) {}
                    reject(new Error(message));
                });
                return;
            }
            res.setEncoding('utf8');
            res.on('data', parser);
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.setTimeout(300000, () => req.destroy(new Error('Request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

function openUrl(url) {
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = isWindows ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
}

function copyTextToClipboard(text) {
    const value = String(text || '');
    if (process.platform === 'win32') {
        const result = spawnSync('clip', { input: value, shell: true, windowsHide: true });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('clip exited with code ' + result.status);
        return;
    }
    if (process.platform === 'darwin') {
        const result = spawnSync('pbcopy', { input: value });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('pbcopy exited with code ' + result.status);
        return;
    }
    const result = spawnSync('xclip', ['-selection', 'clipboard'], { input: value });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('xclip exited with code ' + result.status);
}

class Spinner {
    constructor(client) {
        this.client = client;
        this.frames = ['-', '\\', '|', '/'];
        this.index = 0;
        this.timer = null;
        this.label = '';
        this.lastLength = 0;
        this.startedAt = 0;
        this.thinkingChars = 0;
    }

    start(label) {
        this.stop();
        if (!this.client.isTty) return;
        this.label = label || 'working';
        this.startedAt = Date.now();
        this.thinkingChars = 0;
        this.timer = setInterval(() => this.paint(), 90);
        this.paint();
    }

    set(label) {
        this.label = label || this.label;
        this.paint();
    }

    addThinking(text) {
        this.thinkingChars += String(text || '').length;
        if (!this.startedAt) return;
        const verbs = this.client.theme.verbs || ['thinking'];
        const verb = verbs[Math.floor(this.index / Math.max(1, (this.client.theme.frames || this.frames).length)) % verbs.length] || 'thinking';
        this.set(`${verb} ${this.elapsed()}s`);
    }

    elapsed() {
        return ((Date.now() - this.startedAt) / 1000).toFixed(1);
    }

    paint() {
        if (!this.timer && !this.startedAt) return;
        const frames = this.client.theme.frames || this.frames;
        const frame = frames[this.index++ % frames.length];
        const text = `${this.client.color(frame, 'accent')} ${this.label}`;
        const padded = text + ' '.repeat(Math.max(0, this.lastLength - visibleLength(text)));
        process.stdout.write('\r' + padded);
        this.lastLength = visibleLength(text);
    }

    clearLine() {
        if (!this.lastLength) return;
        process.stdout.write('\r' + ' '.repeat(this.lastLength) + '\r');
        this.lastLength = 0;
    }

    stop(finalText) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.client.isTty) this.clearLine();
        if (finalText) this.client.line(finalText);
        this.startedAt = 0;
    }
}

class AugustTerminalClient {
    constructor(options = {}) {
        this.options = { ...parseArgs([]), ...options };
        this.proxyUrl = String(this.options.proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
        this.provider = normalizeProvider(this.options.provider);
        this.agentId = normalizeAgentId(this.options.agentId);
        this.session = null;
        this.commands = null;
        this.capabilities = null;
        this.skills = null;
        this.theme = THEMES[this.options.theme] || THEMES.midnight;
        this.colorEnabled = this.options.color !== false && process.stdout.isTTY;
        this.isTty = Boolean(process.stdout.isTTY);
        this.showThinking = Boolean(this.options.showThinking);
        this.spinner = new Spinner(this);
        this.lastPlanId = null;
        this.lastApprovalState = false;
        this.lastAssistantText = '';
        this.lastUserMessage = '';
    }

    color(text, role = 'text') {
        if (!this.colorEnabled) return String(text || '');
        return (this.theme[role] || '') + String(text || '') + ANSI.reset;
    }

    line(text = '') {
        this.spinner.clearLine();
        process.stdout.write(String(text) + '\n');
    }

    write(text = '') {
        this.spinner.clearLine();
        process.stdout.write(String(text));
    }

    header() {
        const width = terminalWidth();
        const title = ` AUGUST terminal | ${this.provider} route | ${this.agentId} agent | ${this.proxyUrl} `;
        const bar = '-'.repeat(Math.max(0, width - visibleLength(title)));
        this.line(this.color(title, 'inverse') + this.color(bar, 'muted'));
        this.line(this.color('Type /help for commands. Mutations stay locked until /plan then /approve.', 'muted'));
        this.line('');
    }

    promptLabel() {
        const state = this.session?.approved
            ? 'approved'
            : (this.session?.plan ? 'plan' : 'locked');
        const role = this.session?.approved ? 'ok' : 'warn';
        return this.color(`august:${state}> `, role);
    }

    async ensureSession() {
        if (this.session?.id) return this.session;
        this.session = await requestJson('POST', `${this.proxyUrl}/ui/workbench/session`, {
            provider: this.provider,
            agentId: this.agentId,
            surface: 'august-terminal'
        });
        return this.session;
    }

    async resetSession() {
        const previousId = this.session?.id;
        this.session = await requestJson('POST', `${this.proxyUrl}/ui/workbench/reset`, {
            sessionId: previousId,
            provider: this.provider,
            agentId: this.agentId
        });
        this.lastPlanId = null;
        this.lastApprovalState = false;
        this.line(this.color('New session started.', 'ok'));
        this.renderSessionState();
    }

    async approvePlan() {
        await this.ensureSession();
        const updated = await requestJson('POST', `${this.proxyUrl}/ui/workbench/approve`, {
            sessionId: this.session.id
        });
        this.session = updated;
        this.renderPlan(true);
        this.line(this.color('Plan approved. Send /build to implement the approved plan.', 'ok'));
    }

    async loadCapabilities() {
        if (this.capabilities) return this.capabilities;
        this.capabilities = await requestJson('GET', `${this.proxyUrl}/ui/workbench/capabilities`);
        return this.capabilities;
    }

    async loadSkills() {
        if (this.skills) return this.skills;
        try {
            this.skills = await requestJson('GET', `${this.proxyUrl}/ui/skills`);
        } catch (e) {
            this.skills = { skills: [] };
        }
        return this.skills;
    }

    async loadCommands() {
        if (this.commands) return this.commands;
        const commands = BASE_COMMANDS.map(command => ({
            ...command,
            label: '/' + command.name,
            kind: command.local ? 'local' : 'prompt'
        }));
        const [skillsData, capabilitiesData] = await Promise.all([
            this.loadSkills(),
            this.loadCapabilities()
        ]);
        const skills = Array.isArray(skillsData?.skills) ? skillsData.skills : [];
        for (const skill of skills) {
            if (!skill?.name || skill.enabled === false) continue;
            commands.push({
                name: skill.name,
                label: '/' + skill.name,
                title: skill.name,
                category: 'Skills',
                kind: 'skill',
                description: skill.description || skill.trigger || 'Available skill',
                insert: `Use the "${skill.name}" skill for: `
            });
        }
        const groups = capabilitiesData?.groups && typeof capabilitiesData.groups === 'object'
            ? capabilitiesData.groups
            : {};
        for (const [group, tools] of Object.entries(groups)) {
            for (const tool of Array.isArray(tools) ? tools : []) {
                if (!tool?.name) continue;
                commands.push({
                    name: tool.name,
                    label: '/' + tool.name,
                    title: tool.name,
                    category: group,
                    kind: tool.mutating ? 'tool + approval' : 'tool',
                    description: trimToolDescription(tool.description, tool.mutating),
                    insert: `Use the ${tool.name} tool${tool.mutating ? ' after an approved plan' : ''} with: `
                });
            }
        }
        const seen = new Set();
        this.commands = commands.filter(command => {
            const key = command.label.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return this.commands;
    }

    completer(line) {
        const commands = this.commands || BASE_COMMANDS.map(command => ({ ...command, label: '/' + command.name }));
        const hits = commands
            .map(command => command.label)
            .filter(label => label.toLowerCase().startsWith(String(line || '').toLowerCase()))
            .slice(0, 80);
        return [hits.length ? hits : commands.map(command => command.label).slice(0, 80), line];
    }

    renderSessionState() {
        const session = this.session;
        if (!session) return;
        const gate = session.approved
            ? this.color('approved', 'ok')
            : (session.plan ? this.color('plan pending', 'warn') : this.color('locked', 'warn'));
        this.agentId = normalizeAgentId(session.agentId || this.agentId);
        this.line(`Session ${this.color(session.id, 'accent')} | provider ${this.color(session.provider || this.provider, 'accent')} | agent ${this.color(this.agentId, 'accent')} | gate ${gate}`);
    }

    renderPlan(force = false) {
        const plan = this.session?.plan;
        if (!plan) {
            if (force) this.line(this.color('No plan submitted yet.', 'muted'));
            return;
        }
        const approved = this.session?.approved === true;
        if (!force && this.lastPlanId === plan.id && this.lastApprovalState === approved) return;
        this.lastPlanId = plan.id;
        this.lastApprovalState = approved;
        this.line('');
        this.line(this.color(`Plan ${approved ? 'approved' : 'waiting for approval'}`, approved ? 'ok' : 'warn'));
        if (plan.summary) this.line(wrapText(stripMarkdown(plan.summary), terminalWidth(), '  '));
        this.renderList('Steps', plan.steps);
        this.renderList('Files', plan.files);
        this.renderList('Risks', plan.risks);
        this.renderList('Verification', plan.verification);
        this.line(approved
            ? this.color('  Mutating tools are unlocked for the approved plan.', 'ok')
            : this.color('  Mutating tools remain blocked. Run /approve to unlock this plan.', 'warn'));
        this.line('');
    }

    renderList(title, items) {
        if (!Array.isArray(items) || !items.length) return;
        this.line(this.color(`  ${title}:`, 'accent'));
        items.forEach((item, index) => {
            this.line(wrapText(stripMarkdown(item), terminalWidth(), `    ${index + 1}. `));
        });
    }

    printHelp() {
        this.line(this.color('August terminal commands', 'accent'));
        const groups = groupBy(BASE_COMMANDS, command => command.category || 'Other');
        for (const [category, commands] of groups.entries()) {
            this.line(this.color(`\n${category}`, 'accent2'));
            for (const command of commands) {
                const usage = '/' + command.name + (command.args ? ' ' + command.args : '');
                const aliases = command.aliases?.length ? ` (${command.aliases.map(a => '/' + a).join(', ')})` : '';
                this.line(`  ${this.color(usage.padEnd(24), 'text')} ${command.description}${aliases}`);
            }
        }
        this.line(this.color('\nTab completes slash commands. /commands filters every skill and tool.', 'muted'));
    }

    async printCommands(query = '') {
        const commands = await this.loadCommands();
        const q = String(query || '').trim().toLowerCase();
        const filtered = commands
            .filter(command => !q || [
                command.label,
                command.title,
                command.kind,
                command.category,
                command.description
            ].filter(Boolean).join(' ').toLowerCase().includes(q))
            .slice(0, 80);
        if (!filtered.length) {
            this.line(this.color('No matching commands.', 'warn'));
            return;
        }
        this.line(this.color(`Commands${q ? ` matching "${q}"` : ''}`, 'accent'));
        for (const command of filtered) {
            const badge = `[${command.kind || 'command'}]`;
            const left = `${command.label}`.padEnd(34);
            this.line(`${this.color(left, 'text')} ${this.color(badge.padEnd(17), command.kind?.includes('approval') ? 'warn' : 'muted')} ${truncate(command.description || '', 78)}`);
        }
        if (commands.length > filtered.length) this.line(this.color(`Showing ${filtered.length} of ${commands.length}. Add a query to narrow.`, 'muted'));
    }

    async printTools() {
        const capabilities = await this.loadCapabilities();
        const groups = capabilities.groups || {};
        this.line(this.color(`Workbench tools: ${capabilities.totalTools || 0}`, 'accent'));
        for (const [group, tools] of Object.entries(groups)) {
            const list = Array.isArray(tools) ? tools : [];
            if (!list.length) continue;
            const mutating = list.filter(tool => tool.mutating).length;
            this.line(this.color(`\n${group} (${list.length}${mutating ? `, ${mutating} approval-required` : ''})`, 'accent2'));
            list.slice(0, 16).forEach(tool => {
                const mark = tool.mutating ? this.color('requires plan', 'warn') : this.color('read', 'ok');
                this.line(`  /${tool.name} ${this.color('-', 'muted')} ${mark}`);
            });
            if (list.length > 16) this.line(this.color(`  ... ${list.length - 16} more`, 'muted'));
        }
    }

    async printSkills() {
        const skillsData = await this.loadSkills();
        const skills = Array.isArray(skillsData?.skills) ? skillsData.skills : [];
        if (!skills.length) {
            this.line(this.color('No skills reported by /ui/skills.', 'warn'));
            return;
        }
        this.line(this.color(`Skills: ${skills.length}`, 'accent'));
        for (const skill of skills.slice(0, 80)) {
            const state = skill.enabled === false ? this.color('disabled', 'warn') : this.color('enabled', 'ok');
            this.line(`  /${String(skill.name || '').padEnd(26)} ${state} ${truncate(skill.description || skill.trigger || '', 80)}`);
        }
    }

    async printAgents() {
        const data = await requestJson('GET', `${this.proxyUrl}/ui/workbench/agents?active=${encodeURIComponent(this.agentId)}`);
        const agents = Array.isArray(data?.agents) ? data.agents : [];
        if (!agents.length) {
            this.line(this.color('No Workbench agents reported.', 'warn'));
            return;
        }
        this.line(this.color(`Workbench agents (${data.activeAgentId || this.agentId} active)`, 'accent'));
        for (const agent of agents) {
            const active = agent.id === (data.activeAgentId || this.agentId) ? this.color('active', 'ok') : this.color(agent.mode || 'agent', 'muted');
            const perms = agent.effectivePermissions || agent.permissions || {};
            const edit = perms.edit || 'unknown';
            const shell = perms.shell || 'unknown';
            this.line(`  ${String(agent.id || '').padEnd(9)} ${active.padEnd(18)} edit:${edit} shell:${shell} - ${truncate(agent.role || agent.goal || '', 70)}`);
        }
        if (data.inheritance?.rule) this.line(this.color(`  ${data.inheritance.rule}`, 'muted'));
    }

    async handleAgentCommand(arg) {
        const value = String(arg || '').trim().toLowerCase();
        if (!value) {
            this.line(`Current agent: ${this.color(this.agentId, 'accent')}`);
            return;
        }
        const next = normalizeAgentId(value);
        if (next !== value) {
            this.line(this.color(`Unknown agent: ${arg}. Available: build, plan, explore, general`, 'warn'));
            return;
        }
        this.agentId = next;
        this.line(`Agent set to ${this.color(this.agentId, 'accent')}. Starting a fresh session.`);
        await this.resetSession();
    }

    async askBtw(arg) {
        const question = String(arg || '').trim();
        if (!question) {
            this.line(this.color('Usage: /btw <side question>', 'warn'));
            return;
        }
        await this.ensureSession();
        this.line('');
        this.line(`${this.color('btw', 'accent')}: ${question}`);
        this.spinner.start('answering side question');
        try {
            const result = await requestJson('POST', `${this.proxyUrl}/ui/workbench/btw`, {
                sessionId: this.session.id,
                question,
                provider: this.provider,
                agentId: this.agentId
            });
            this.spinner.stop();
            this.printBtwAnswer(result);
        } catch (e) {
            this.spinner.stop();
            this.line(this.color(`BTW failed: ${e.message}`, 'error'));
        }
    }

    async handleGoalCommand(arg) {
        await this.ensureSession();
        const value = String(arg || '').trim();
        const lower = value.toLowerCase();
        const clear = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(lower);
        if (!value || lower === 'status') {
            const status = await requestJson('GET', `${this.proxyUrl}/ui/workbench/goal?sessionId=${encodeURIComponent(this.session.id)}`);
            this.renderGoal({ ...status, event: status.goal ? 'status' : 'idle' });
            return;
        }
        if (clear) {
            const status = await requestJson('POST', `${this.proxyUrl}/ui/workbench/goal`, {
                sessionId: this.session.id,
                action: 'clear'
            });
            this.session = status.session || this.session;
            this.renderGoal({ ...status, event: 'cleared' });
            return;
        }
        await this.sendMessage('/goal ' + value);
    }

    async printStatus() {
        await this.ensureSession();
        this.renderSessionState();
        this.renderPlan(true);
        try {
            const [capabilities, brain] = await Promise.all([
                this.loadCapabilities(),
                requestJson('GET', `${this.proxyUrl}/ui/brain/diagnostics`)
            ]);
            this.line(`Tools ${this.color(capabilities.totalTools || 0, 'accent')} | Brain ${this.color(brain.summary?.overall || 'unknown', brain.summary?.overall === 'ok' ? 'ok' : 'warn')}`);
        } catch (e) {
            this.line(this.color(`Status detail unavailable: ${e.message}`, 'warn'));
        }
    }

    async doctorLocal() {
        const checks = [];
        try {
            const capabilities = await this.loadCapabilities();
            checks.push(['workbench capabilities', 'ok', `${capabilities.totalTools || 0} tools`]);
        } catch (e) {
            checks.push(['workbench capabilities', 'error', e.message]);
        }
        try {
            const brain = await requestJson('GET', `${this.proxyUrl}/ui/brain/diagnostics`);
            checks.push(['august brain', brain.summary?.overall || 'unknown', `${brain.counts?.semanticFacts || 0} facts, ${brain.counts?.vectorEntries || 0} vectors`]);
        } catch (e) {
            checks.push(['august brain', 'error', e.message]);
        }
        try {
            const skills = await this.loadSkills();
            checks.push(['skills endpoint', 'ok', `${Array.isArray(skills.skills) ? skills.skills.length : 0} skills`]);
        } catch (e) {
            checks.push(['skills endpoint', 'warn', e.message]);
        }
        this.line(this.color('Local doctor', 'accent'));
        checks.forEach(([name, state, detail]) => {
            const role = state === 'ok' ? 'ok' : (state === 'error' ? 'error' : 'warn');
            this.line(`  ${name.padEnd(24)} ${this.color(String(state).padEnd(8), role)} ${detail}`);
        });
    }

    async sendMessage(message) {
        const text = String(message || '').trim();
        if (!text) return;
        await this.ensureSession();
        const startedAt = Date.now();
        this.lastUserMessage = text;
        this.line('');
        this.line(`${this.color('you', 'accent')}: ${text}`);
        this.spinner.start('working');
        let thinking = '';
        let assistantText = '';
        try {
            await requestSse('POST', `${this.proxyUrl}/ui/workbench/chat`, {
                sessionId: this.session.id,
                provider: this.provider,
                agentId: this.agentId,
                message: text
            }, (event, data) => this.handleStreamEvent(event, data, {
                appendThinking: value => { thinking += value; },
                appendAssistant: value => { assistantText += value; }
            }));
            if (thinking && !this.showThinking) {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                this.line(this.color(`Thought for ${elapsed}s (${thinking.length} chars captured, /thinking on to show future thinking).`, 'muted'));
            }
            this.lastAssistantText = assistantText || this.lastAssistantText;
        } catch (e) {
            this.spinner.stop();
            this.line(this.color(`Request failed: ${e.message}`, 'error'));
        } finally {
            this.spinner.stop();
            this.renderPlan();
        }
    }

    handleStreamEvent(event, data, sinks) {
        if (event === 'thinking') {
            const content = data?.content || '';
            sinks.appendThinking(content);
            this.spinner.addThinking(content);
            if (this.showThinking && content) {
                this.spinner.clearLine();
                this.write(this.color(content, 'muted'));
            }
            return;
        }
        if (event === 'tool_use') {
            this.spinner.stop();
            this.printToolUse(data);
            this.spinner.start(`running ${data?.name || 'tool'}`);
            return;
        }
        if (event === 'tool_result') {
            this.spinner.stop();
            this.printToolResult(data);
            this.spinner.start('working');
            return;
        }
        if (event === 'text') {
            this.spinner.stop();
            const content = data?.content || '';
            sinks.appendAssistant(content);
            this.printAssistant(content);
            this.spinner.start('finishing');
            return;
        }
        if (event === 'session') {
            this.session = data;
            this.agentId = normalizeAgentId(data?.agentId || this.agentId);
            return;
        }
        if (event === 'goal') {
            this.renderGoal(data);
            return;
        }
        if (event === 'btw') {
            this.printBtwAnswer(data);
            return;
        }
        if (event === 'error') {
            this.spinner.stop();
            this.line(this.color(`Error: ${data?.message || 'Unknown error'}`, 'error'));
        }
    }

    printAssistant(text) {
        const clean = stripMarkdown(text);
        if (!clean) return;
        this.line('');
        this.line(this.color('august', 'accent') + ':');
        this.line(wrapText(clean, terminalWidth(), '  '));
    }

    printBtwAnswer(data) {
        const answer = stripMarkdown(data?.answer || data?.content || '');
        if (!answer) return;
        this.line('');
        this.line(this.color('btw answer', 'accent') + ':');
        this.line(wrapText(answer, terminalWidth(), '  '));
    }

    renderGoal(data = {}) {
        const goal = data.goal || null;
        const lastGoal = data.lastGoal || null;
        if (goal) {
            this.line(this.color('Goal active', 'accent'));
            this.line(wrapText(goal.condition || '', terminalWidth(), '  '));
            if (goal.lastReason) this.line(wrapText(goal.lastReason, terminalWidth(), '  status: '));
            return;
        }
        if (data.event === 'cleared') {
            this.line(this.color('Goal cleared.', 'ok'));
            return;
        }
        if (lastGoal) {
            this.line(this.color(`No active goal. Last goal: ${lastGoal.status || 'done'}`, 'muted'));
            this.line(wrapText(lastGoal.condition || '', terminalWidth(), '  '));
            return;
        }
        this.line(this.color('No active goal.', 'muted'));
    }

    copyLastAssistant() {
        if (!this.lastAssistantText) {
            this.line(this.color('No assistant response to copy yet.', 'warn'));
            return;
        }
        try {
            copyTextToClipboard(this.lastAssistantText);
            this.line(this.color('Copied last assistant response.', 'ok'));
        } catch (e) {
            this.line(this.color(`Copy failed: ${e.message}`, 'error'));
        }
    }

    printToolUse(data) {
        const name = data?.name || 'unknown_tool';
        const input = summarizeValue(data?.input, 180);
        const mutating = /write|replace|run|bash|delete|move|import|remember|forget|computer|spawn|install|launch|clipboard|click|type/i.test(name);
        const status = mutating ? this.color('approval-aware', 'warn') : this.color('read/inspect', 'ok');
        this.line(`${this.color('tool', 'accent')}: ${name} ${this.color('-', 'muted')} ${status}`);
        if (input) this.line(wrapText(input, terminalWidth(), '  input: '));
    }

    printToolResult(data) {
        const isError = data?.is_error;
        const summary = summarizeToolResultText(data?.content, isError);
        const label = isError ? this.color('tool error', 'error') : this.color('tool done', 'ok');
        this.line(`${label}: ${summary || '(no output)'}`);
    }

    async handleSlash(input) {
        const raw = String(input || '').trim();
        const withoutSlash = raw.replace(/^\/+/, '');
        const firstSpace = withoutSlash.search(/\s/);
        const name = (firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)).toLowerCase();
        const arg = firstSpace === -1 ? '' : withoutSlash.slice(firstSpace + 1).trim();
        const command = this.resolveCommand(name);
        if (!command) {
            const dynamic = await this.resolveDynamicCommand(name);
            if (dynamic) {
                await this.sendMessage((dynamic.insert || dynamic.description || dynamic.label) + (arg ? arg : ''));
                return false;
            }
            this.line(this.color(`Unknown command: /${name}. Try /commands ${name}`, 'warn'));
            return false;
        }
        switch (command.name) {
            case 'help':
                this.printHelp();
                return false;
            case 'commands':
                await this.printCommands(arg);
                return false;
            case 'status':
                await this.printStatus();
                return false;
            case 'new':
                await this.resetSession();
                return false;
            case 'retry':
                if (!this.lastUserMessage) {
                    this.line(this.color('No user message to retry yet.', 'warn'));
                    return false;
                }
                await this.sendMessage(this.lastUserMessage);
                return false;
            case 'provider':
                if (!arg) {
                    this.line(`Current provider: ${this.color(this.provider, 'accent')}`);
                    return false;
                }
                this.provider = normalizeProvider(arg);
                this.line(`Provider route set to ${this.color(this.provider, 'accent')}. Starting a fresh session.`);
                await this.resetSession();
                return false;
            case 'agent':
                await this.handleAgentCommand(arg);
                return false;
            case 'plan':
                await this.sendMessage('Create a plan first and wait for my approval before changing anything: ' + (arg || 'Ask me what to plan.'));
                return false;
            case 'approve':
                try { await this.approvePlan(); } catch (e) { this.line(this.color(e.message, 'error')); }
                return false;
            case 'build':
                await this.handleBuild(arg);
                return false;
            case 'tools':
                await this.printTools();
                return false;
            case 'skills':
                await this.printSkills();
                return false;
            case 'agents':
                await this.printAgents();
                return false;
            case 'fetch-skill':
                await this.sendMessage('Find a skill from the internet or GitHub for: ' + (arg || 'Ask me what skill topic or URL to use.'));
                return false;
            case 'diagnose':
                await this.sendMessage('Diagnose the proxy health, August Brain, MCP, tools, and recent errors. Start with workbench_diagnose_proxy.');
                return false;
            case 'doctor-local':
                await this.doctorLocal();
                return false;
            case 'copy':
                this.copyLastAssistant();
                return false;
            case 'btw':
                await this.askBtw(arg);
                return false;
            case 'goal':
                await this.handleGoalCommand(arg);
                return false;
            case 'thinking':
                this.handleThinkingCommand(arg);
                return false;
            case 'theme':
                this.handleThemeCommand(arg);
                return false;
            case 'tui':
                this.handleTuiCommand(arg);
                return false;
            case 'clear':
                process.stdout.write('\x1bc');
                this.header();
                return false;
            case 'web':
                openUrl(`${this.proxyUrl}/#august-console`);
                this.line(this.color('Opened optional browser console.', 'ok'));
                return false;
            case 'exit':
                return true;
            default:
                if (command.insert) await this.sendMessage(command.insert + arg);
                return false;
        }
    }

    resolveCommand(name) {
        const normalized = String(name || '').replace(/^\/+/, '').toLowerCase();
        return BASE_COMMANDS.find(command => command.name === normalized || (command.aliases || []).includes(normalized));
    }

    async resolveDynamicCommand(name) {
        const commands = await this.loadCommands();
        const normalized = '/' + String(name || '').replace(/^\/+/, '').toLowerCase();
        return commands.find(command => String(command.label || '').toLowerCase() === normalized);
    }

    async handleBuild(arg) {
        await this.ensureSession();
        if (!this.session.plan) {
            await this.sendMessage('Create a plan first and wait for my approval before changing anything: ' + (arg || 'Implement the requested change.'));
            return;
        }
        if (!this.session.approved) {
            this.renderPlan(true);
            this.line(this.color('Run /approve before /build can mutate anything.', 'warn'));
            return;
        }
        await this.sendMessage('Implement the approved plan now. Stay within the approved scope and run the verification steps. ' + (arg || ''));
    }

    handleThinkingCommand(arg) {
        const value = String(arg || '').toLowerCase();
        if (value === 'on' || value === 'show') this.showThinking = true;
        else if (value === 'off' || value === 'hide') this.showThinking = false;
        this.line(`Thinking display: ${this.color(this.showThinking ? 'on' : 'off', this.showThinking ? 'ok' : 'muted')}`);
    }

    handleThemeCommand(arg) {
        const value = String(arg || '').trim().toLowerCase();
        if (!value || value === 'list') {
            this.line(`Current theme: ${this.color(this.theme.name, 'accent')} | available: ${Object.keys(THEMES).join(', ')}`);
            return;
        }
        const next = value;
        if (!THEMES[next]) {
            this.line(this.color(`Unknown theme: ${arg}. Available: ${Object.keys(THEMES).join(', ')}`, 'warn'));
            return;
        }
        this.theme = THEMES[next];
        this.line(`Theme set to ${this.color(next, 'accent')}`);
    }

    handleTuiCommand(arg) {
        const value = String(arg || '').trim().toLowerCase();
        if (value && value !== 'default') {
            this.line(this.color('August currently uses the Windows-safe PowerShell line renderer.', 'warn'));
            return;
        }
        this.line(`Renderer: ${this.color('PowerShell line terminal', 'accent')} | prompt ${this.color('gate-aware', 'ok')} | commands ${this.color('/commands', 'accent')}`);
    }

    async processInput(input) {
        const text = String(input || '').trim();
        if (!text) return false;
        if (text === '/') {
            await this.printCommands('');
            return false;
        }
        if (text.startsWith('/')) return this.handleSlash(text);
        await this.sendMessage(text);
        return false;
    }

    async runOnce(input) {
        this.header();
        await this.ensureSession();
        await this.loadCommands().catch(() => {});
        const shouldExit = await this.processInput(input);
        return shouldExit;
    }

    async runInteractive() {
        this.header();
        await this.ensureSession();
        await this.loadCommands().catch(e => this.line(this.color(`Command inventory limited: ${e.message}`, 'warn')));
        this.renderSessionState();
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: this.promptLabel(),
            completer: line => this.completer(line)
        });
        let busy = false;
        rl.prompt();
        rl.on('line', async line => {
            if (busy) {
                this.line(this.color('Still working. Wait for the current turn to finish.', 'warn'));
                rl.prompt();
                return;
            }
            busy = true;
            try {
                const done = await this.processInput(line);
                if (done) {
                    rl.close();
                    return;
                }
            } catch (e) {
                this.spinner.stop();
                this.line(this.color(e.message, 'error'));
            } finally {
                busy = false;
                rl.setPrompt(this.promptLabel());
                rl.prompt();
            }
        });
        await new Promise(resolve => rl.on('close', resolve));
        this.spinner.stop();
        this.line(this.color('August terminal closed.', 'muted'));
    }

    async selfTest() {
        const results = [];
        const ok = (name, detail = '') => results.push({ name, ok: true, detail });
        const fail = (name, error) => results.push({ name, ok: false, detail: error?.message || String(error) });
        try {
            const parsed = parseArgs(['--provider', 'codex', '--agent', 'plan', '--theme', 'slate', '--once', '/status']);
            if (parsed.provider === 'codex' && parsed.agentId === 'plan' && parsed.theme === 'slate' && parsed.once === '/status') ok('arg parser');
            else throw new Error('parsed values did not match expected output');
        } catch (e) { fail('arg parser', e); }
        try {
            await this.ensureSession();
            if (!this.session?.id) throw new Error('session id missing');
            ok('workbench session', this.session.id);
        } catch (e) { fail('workbench session', e); }
        try {
            const commands = await this.loadCommands();
            for (const expected of ['/help', '/plan', '/goal', '/btw', '/build', '/approve', '/tools', '/agents']) {
                if (!commands.some(command => command.label === expected)) throw new Error(`${expected} missing`);
            }
            ok('slash registry', `${commands.length} commands`);
        } catch (e) { fail('slash registry', e); }
        try {
            await this.processInput('/copy');
            await this.processInput('/retry');
            await this.processInput('/theme slate');
            await this.processInput('/tui');
            await this.processInput('/agent build');
            await this.processInput('/agents');
            await this.processInput('/goal status');
            await this.processInput('/goal clear');
            await this.processInput('/btw');
            ok('local command handlers', 'copy, retry, theme, tui, agents, goal, btw');
        } catch (e) { fail('local command handlers', e); }
        try {
            const caps = await this.loadCapabilities();
            if (!caps.totalTools) throw new Error('totalTools missing');
            ok('capability inventory', `${caps.totalTools} tools`);
        } catch (e) { fail('capability inventory', e); }
        try {
            let seenText = false;
            const parser = createSseParser((event, data) => {
                if (event === 'text' && data.content === 'ok') seenText = true;
            });
            parser('event: text\ndata: {"content":"ok"}\n\n');
            if (!seenText) throw new Error('text event not parsed');
            ok('sse parser');
        } catch (e) { fail('sse parser', e); }
        try {
            await this.approvePlan();
            fail('approval guard', 'approval unexpectedly succeeded without a plan');
        } catch (e) {
            if (/No submitted plan/i.test(e.message)) ok('approval guard', 'blocked without plan');
            else fail('approval guard', e);
        }
        try {
            await this.resetSession();
            ok('session reset', this.session.id);
        } catch (e) { fail('session reset', e); }

        const failed = results.filter(result => !result.ok);
        this.line(this.color('August terminal self-test', failed.length ? 'warn' : 'ok'));
        for (const result of results) {
            const state = result.ok ? this.color('PASS', 'ok') : this.color('FAIL', 'error');
            this.line(`  ${state} ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
        }
        if (failed.length) {
            const error = new Error(`${failed.length} self-test checks failed`);
            error.results = results;
            throw error;
        }
        return results;
    }
}

function trimToolDescription(text, mutating) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const prefix = mutating ? 'Requires approved plan. ' : '';
    return prefix + truncate(clean, 120);
}

function summarizeValue(value, max = 200) {
    if (value == null) return '';
    if (typeof value === 'string') return truncate(value, max);
    if (typeof value === 'object') {
        const direct = value.command || value.path || value.url || value.query || value.name || value.summary;
        if (direct) return truncate(String(direct), max);
        try { return truncate(JSON.stringify(value), max); } catch (e) { return truncate(String(value), max); }
    }
    return truncate(String(value), max);
}

function summarizeToolResultText(content, isError) {
    const text = typeof content === 'string' ? content : JSON.stringify(content || '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    if (parsed && typeof parsed === 'object') {
        if (parsed.blocked || /approval/i.test(parsed.message || '')) {
            return truncate(parsed.message || parsed.detail || text, 220);
        }
        if (parsed.status) {
            const parts = [parsed.status, parsed.path, parsed.cwd, parsed.exitCode !== undefined ? `exit ${parsed.exitCode}` : ''].filter(Boolean);
            if (parts.length) return truncate(parts.join(' | '), 220);
        }
        if (parsed.stdout || parsed.stderr) return truncate([parsed.stdout, parsed.stderr].filter(Boolean).join('\n'), 220);
        if (parsed.plan?.summary) return truncate(parsed.plan.summary, 220);
    }
    if (isError) return truncate(text, 220);
    return truncate(text, 180);
}

async function runAugustTerminal(argv = process.argv.slice(2), injected = {}) {
    const options = { ...parseArgs(argv), ...injected };
    const client = new AugustTerminalClient(options);
    if (options.urlOnly) {
        console.log(`${client.proxyUrl}/#august-console`);
        return;
    }
    if (options.web) {
        console.log(`${client.proxyUrl}/#august-console`);
        if (!options.noOpen) openUrl(`${client.proxyUrl}/#august-console`);
        return;
    }
    if (options.selfTest) {
        await client.selfTest();
        return;
    }
    if (options.once !== null && options.once !== undefined) {
        await client.runOnce(options.once);
        return;
    }
    await client.runInteractive();
}

if (require.main === module) {
    runAugustTerminal(process.argv.slice(2)).catch(error => {
        process.stderr.write(`August terminal failed: ${error.message}\n`);
        process.exit(1);
    });
}

module.exports = {
    AugustTerminalClient,
    BASE_COMMANDS,
    createSseParser,
    parseArgs,
    requestJson,
    runAugustTerminal,
    stripMarkdown,
    summarizeToolResultText,
    summarizeValue,
    wrapText
};
