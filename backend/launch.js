const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');
const { saveProfile, getProfile } = require('./lib/config');
const { runAugustTerminal } = require('./services/workbench/august-terminal');

const PROXY_URL = process.env.AUGUST_PROXY_URL || 'http://127.0.0.1:8085';
const IS_TTY = process.stdin.isTTY;

// Model prefix filter by tool type
const PROXY_MODEL_PREFIX = {
    claude: 'claude-',   // Anthropic-shaped proxy models
    codex: 'gpt-'      // OpenAI-shaped proxy models
};
// Default public aliases used by each CLI
const CLI_DEFAULT_ALIAS = {
    claude: process.env.AUGUST_CLAUDE_ALIAS || 'claude-opus-4-6',
    codex: 'gpt-4o'
};

function hasExplicitModelArg(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model' || arg === '-m') return true;
        if (typeof arg === 'string' && (arg.startsWith('--model=') || arg.startsWith('-m='))) return true;
    }
    return false;
}

function question(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function fetchLocalModels() {
    return new Promise((resolve, reject) => {
        const req = http.get(`${PROXY_URL}/v1/models`, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.data || []);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function fetchUpstreamModels() {
    return new Promise((resolve) => {
        const req = http.get(`${PROXY_URL}/ui/models`, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const models = JSON.parse(data);
                    resolve(Array.isArray(models) ? models : []);
                } catch (e) {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
    });
}

async function launchAugust(args) {
    await runAugustTerminal(args, { proxyUrl: PROXY_URL });
}

function updateConfig(tool, model) {
    try {
        if (tool === 'claude') {
            // Claude CLI: preserve the public anthropic alias, store upstream model + provider
            const existingProfile = getProfile('claude') || {};
            const prefix = PROXY_MODEL_PREFIX.claude;
            // If selected model starts with 'claude-' it's a proxy model → use as public alias
            // Otherwise use the default alias (upstream providers don't have claude-* names)
            const isProxyModel = model.id.toLowerCase().startsWith(prefix);
            const preservedAlias = isProxyModel
                ? model.id
                : (typeof existingProfile.currentModel === 'string' && existingProfile.currentModel.toLowerCase().startsWith(prefix)
                    ? existingProfile.currentModel
                    : CLI_DEFAULT_ALIAS.claude);

            saveProfile('claude', {
                ...existingProfile,
                currentModel: preservedAlias,
                _upstreamModel: model.id,
                targetUrl: model.url || existingProfile.targetUrl || null,
                apiKey: model.key || existingProfile.apiKey || ''
            });
            console.log(`  Set upstream model: ${model.id}`);
            console.log(`  Public alias: ${preservedAlias}`);
            if (model.provider) console.log(`  Provider: ${model.provider} ${model.url ? '(' + model.url + ')' : ''}`);
            return;
        }

        // Codex CLI: preserve the last gpt-* proxy alias when an upstream model is chosen
        const existingProfile = getProfile('codex') || {};
        const prefix = PROXY_MODEL_PREFIX.codex;
        const isProxyModel = model.id.toLowerCase().startsWith(prefix);
        const preservedAlias = isProxyModel
            ? model.id
            : (typeof existingProfile.currentModel === 'string' && existingProfile.currentModel.toLowerCase().startsWith(prefix)
                ? existingProfile.currentModel
                : CLI_DEFAULT_ALIAS.codex);

        saveProfile('codex', {
            ...existingProfile,
            currentModel: preservedAlias,
            _upstreamModel: model.id,
            targetUrl: model.url || existingProfile.targetUrl || null,
            apiKey: model.key || existingProfile.apiKey || ''
        });
        console.log(`  Set upstream model: ${model.id}`);
        console.log(`  Public alias: ${preservedAlias}`);
        if (model.provider) console.log(`  Provider: ${model.provider} ${model.url ? '(' + model.url + ')' : ''}`);
    } catch (e) {
        console.error('  Warning: Could not update config.json:', e.message);
    }
}

async function main() {
    let tool = process.argv[2];
    if (!tool || (tool !== 'claude' && tool !== 'codex' && tool !== 'august')) {
        console.log('\n  August Proxy Launcher\n');
        console.log('  Usage:');
        console.log('    claude-local  [--model <model>] [args...]   Anthropic/Claude CLI');
        console.log('    codex-local   [--model <model>] [args...]   OpenAI/Codex CLI');
        console.log('    august-local  [--provider claude|codex]     August terminal');
        console.log('                  [--web] [--url-only]          Optional browser console');
        console.log('');
        process.exit(1);
    }

    if (tool === 'august') {
        await launchAugust(process.argv.slice(3));
        return;
    }

    console.log(`\n  August Proxy — ${tool.toUpperCase()}`);
    console.log('  ' + '─'.repeat(46));
    console.log(`  Proxy: ${PROXY_URL}`);

    // Fetch both model sources in parallel
    let allProxy = [];
    let upstream = [];
    try {
        [allProxy, upstream] = await Promise.all([
            fetchLocalModels(),
            fetchUpstreamModels()
        ]);
    } catch (e) {
        console.log(`  Proxy unreachable (${e.message}). Using fallback.`);
    }

    // Filter proxy models by tool type
    const prefix = PROXY_MODEL_PREFIX[tool] || '';
    const proxyModels = allProxy.filter(m => m.id.toLowerCase().startsWith(prefix.toLowerCase()));

    const displayModels = [
        ...proxyModels.map(m => ({ id: m.id, name: m.id, provider: 'proxy', url: null, key: null, section: 'proxy' })),
        ...upstream.map(m => ({ id: m.id, name: m.name || m.id, provider: m.provider || 'upstream', url: m.url, key: m.key, section: 'upstream' }))
    ];

    let selectedModel = null;

    if (displayModels.length > 0) {
        console.log(`\n  Available Models (${displayModels.length})`);
        console.log('  ' + '─'.repeat(56));

        // Section 1: Proxy models for this tool
        if (proxyModels.length > 0) {
            console.log(`  Proxy models (${prefix}*):`);
            const numW = displayModels.length.toString().length;
            proxyModels.forEach((m, i) => {
                const idx = (i + 1).toString().padStart(numW);
                console.log(`  [${idx}]  ${m.id}`);
            });
        }

        // Section 2: Upstream providers (all work with both CLIs via bridge)
        if (upstream.length > 0) {
            console.log('  Upstream providers:');
            const numW = displayModels.length.toString().length;
            upstream.forEach((m, i) => {
                const label = m.name || m.id;
                const idx = (proxyModels.length + i + 1).toString().padStart(numW);
                console.log(`  [${idx}] ${label}`);
            });
        }

        const zeroPad = '0'.padStart(displayModels.length.toString().length);
        console.log(`  [${zeroPad}] Keep current model from config.json`);
        console.log('  ' + '─'.repeat(56));

        let choice;
        if (IS_TTY) {
            choice = await question('\n  Select model (number): ');
        } else {
            choice = '0';
            console.log('  Non-interactive: keeping current model (0)');
        }

        const idx = parseInt(choice.trim()) - 1;
        if (idx >= 0 && idx < displayModels.length) {
            selectedModel = displayModels[idx];
            updateConfig(tool, selectedModel);
        }
    } else {
        console.log('  No models fetched. Using current config.json model.');
    }

    console.log(`\n  Starting ${tool.toUpperCase()}...\n`);

    const env = { ...process.env };
    const extraArgs = process.argv.slice(3);
    let args = [];

    if (tool === 'claude') {
        env.ANTHROPIC_BASE_URL = `${PROXY_URL}/v1`;
        env.ANTHROPIC_API_KEY = 'lm-studio';
        env.ANTHROPIC_AUTH_TOKEN = 'lm-studio';
        args = hasExplicitModelArg(extraArgs)
            ? [...extraArgs]
            : ['--model', CLI_DEFAULT_ALIAS.claude, ...extraArgs];
    } else {
        // Codex: set env vars pointing at the proxy. The proxy's bridge handles
        // the conversion. config.toml already has [providers.openai] pointing at
        // the proxy, but env vars take precedence and ensure a clean setup.
        const codexProfile = getProfile('codex') || {};
        const defaultModel = codexProfile.currentModel || CLI_DEFAULT_ALIAS.codex;
        env.OPENAI_API_KEY = 'local-proxy';
        env.OPENAI_BASE_URL = `${PROXY_URL}/v1`;
        args = [
            '-c', `providers.openai.api_base=${PROXY_URL}/v1`,
            '-c', 'providers.openai.api_key=local-proxy'
        ];
        if (!hasExplicitModelArg(extraArgs)) {
            args.push('-m', defaultModel);
        }
        args.push(...extraArgs);
    }

    const child = spawn(tool, args, {
        stdio: 'inherit',
        env,
        shell: true,
        windowsHide: false
    });

    child.on('error', (err) => {
        console.error(`\n  Failed to start ${tool}: ${err.message}`);
        if (err.code === 'ENOENT') {
            console.error(`  Is "${tool}" installed and on your PATH?`);
            console.error(`  npm install -g @anthropic-ai/claude-code   # for claude`);
            console.error(`  npm install -g @openai/codex              # for codex`);
        }
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}

main().catch(e => {
    console.error('  Error:', e);
    process.exit(1);
});
