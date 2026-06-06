const { saveCustomMcpServer } = require('./mcp-registry');
const { normalizeName, savePlugin } = require('./plugins');
const { saveSkill } = require('./skills');

const USER_AGENT = 'AugustProxy-LinkImporter/1.0';

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function normalizeUrl(value) {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Import link must be an http(s) URL.');
    return url;
}

function githubRawUrl(url) {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 5 && parts[2] === 'blob') {
        const [owner, repo, , branch, ...fileParts] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileParts.join('/')}`;
    }
    return null;
}

function githubRepoCandidates(url) {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return [];
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return [];
    const [owner, repo] = parts;
    const branches = [];
    if (parts[2] === 'tree' && parts[3]) branches.push(parts[3]);
    branches.push('main', 'master');
    const manifestPaths = [
        '.mcp.json',
        'mcp.json',
        'claude-plugin.json',
        'plugin.json',
        'manifest.json',
        'ai-plugin.json',
        '.well-known/ai-plugin.json',
        '.codex-plugin/plugin.json',
        'SKILL.md',
        'skill.md',
        'package.json',
        'pyproject.toml'
    ];
    return Array.from(new Set(branches.flatMap(branch => {
        const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
        return manifestPaths.map(manifestPath => `${base}/${manifestPath}`);
    })));
}

function objectFromNamedEntry(name, details) {
    if (typeof details === 'string') return { name, command: details };
    if (Array.isArray(details)) return { name, args: details };
    if (details && typeof details === 'object') return { name, ...details };
    return { name };
}

function buildCandidateUrls(inputUrl) {
    const url = normalizeUrl(inputUrl);
    const directRaw = githubRawUrl(url);
    return Array.from(new Set([
        directRaw,
        url,
        ...githubRepoCandidates(url)
    ].filter(Boolean)));
}

function getBrowserUseRecipe(url, { enableMcp = false } = {}) {
    const parsed = new URL(normalizeUrl(url));
    if (parsed.hostname !== 'github.com') return null;
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (owner !== 'browser-use' || String(repo || '').replace(/\.git$/i, '') !== 'browser-use') return null;

    const sourceUrl = 'https://github.com/browser-use/browser-use';
    const mcpServer = normalizeMcpImport({
        name: 'browser-use',
        command: 'uvx',
        args: ['--from', 'browser-use[cli]', 'browser-use', '--mcp'],
        enabled: enableMcp,
        timeoutMs: 60000
    }, { enableMcp });

    const skill = {
        name: 'browser-use-repair',
        description: 'Diagnose and repair Browser Use MCP imports and Chromium setup.',
        trigger: 'Use when a Browser Use import resolves with MCP servers: none, the browser-use MCP server is not running, Chromium is missing, or the CLI addon is missing.',
        instructions: [
            'When Browser Use was imported but no MCP server is visible, treat it as an import/installation problem, not as unavailable browser automation.',
            'First import https://github.com/browser-use/browser-use through mcp__cowork__import_capability_link with enable_mcp=true, or ask the user to enable the saved browser-use MCP server in the MCP & Skills dashboard.',
            'The expected MCP command is: uvx --from browser-use[cli] browser-use --mcp.',
            'If startup reports that Chromium or Chrome is missing, install it with: uvx --from browser-use[cli] browser-use install.',
            'If startup reports "CLI addon is not installed", keep the --from browser-use[cli] form; plain uvx browser-use --mcp can miss the CLI extra.',
            'After changing the MCP config or installing Chromium, restart MCP servers from the dashboard and retry the Browser Use task.',
            'If running inside Claude Code or Codex with shell access, diagnose with PowerShell commands such as Get-Command uvx and uvx --from browser-use[cli] browser-use --help before declaring failure.'
        ].join('\n'),
        enabled: true
    };

    return {
        sourceUrl,
        resolvedUrl: `${sourceUrl}#known-browser-use-mcp-recipe`,
        attemptedUrls: [sourceUrl],
        skills: [skill],
        mcpServers: [mcpServer],
        plugins: [{
            name: 'browser-use',
            description: 'Browser Use MCP server and repair guidance for local browser automation.',
            sourceUrl,
            skills: [skill],
            mcpServers: [mcpServer],
            enabled: true
        }]
    };
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json,text/markdown,text/plain,*/*' },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text || text.length < 2) throw new Error('empty response');
    return text;
}

function arrayFromMaybeObject(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
        return Object.entries(value).map(([name, details]) => objectFromNamedEntry(name, details));
    }
    return [];
}

function normalizeMcpImport(raw, { enableMcp = false } = {}) {
    const name = normalizeName(raw.name || raw.id || raw.package || 'imported-mcp', 'imported-mcp');
    const command = String(raw.command || '').trim();
    if (!command) return null;
    return {
        name,
        command,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
        cwd: raw.cwd || undefined,
        enabled: raw.enabled === true || enableMcp === true,
        timeoutMs: raw.timeoutMs || 15000,
        source: 'custom'
    };
}

function packageJsonToMcp(pkg, { enableMcp = false } = {}) {
    if (!pkg || typeof pkg !== 'object' || !pkg.name) return null;
    const packageName = String(pkg.name);
    const looksMcp = /mcp|modelcontextprotocol|context-protocol/i.test(packageName) ||
        /mcp|model context protocol/i.test(pkg.description || '');
    if (!looksMcp) return null;
    return normalizeMcpImport({
        name: normalizeName(packageName.replace(/^@/, '').replace(/\//g, '-')),
        command: 'npx',
        args: ['-y', packageName],
        enabled: enableMcp
    }, { enableMcp });
}

function parseSkillMarkdown(text, sourceUrl) {
    const trimmed = text.trim();
    // Reject content that isn't valid markdown (must start with frontmatter or a heading)
    if (!trimmed.startsWith('---') && !trimmed.startsWith('# ')) {
        return null;
    }
    const frontmatter = text.match(/^---\s*([\s\S]*?)\s*---/);
    const nameMatch = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\n]+)["']?/m) ||
        text.match(/^#\s+(.+)$/m);
    const descriptionMatch = frontmatter?.[1]?.match(/^description:\s*["']?([^"'\n]+)["']?/m);
    const name = normalizeName(nameMatch?.[1] || new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || 'imported-skill', 'imported-skill');
    return {
        name,
        description: descriptionMatch?.[1] || `Imported from ${sourceUrl}`,
        trigger: `When the user requests ${name} behavior or this imported capability applies.`,
        instructions: trimmed,
        enabled: true
    };
}

function parsePyprojectMcp(text, { enableMcp = false } = {}) {
    const nameMatch = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    const descMatch = text.match(/^\s*description\s*=\s*["']([^"']+)["']/m);
    const name = nameMatch?.[1];
    if (!name) return null;
    const looksMcp = /mcp|model context protocol/i.test(`${name} ${descMatch?.[1] || ''}`);
    if (!looksMcp) return null;
    return normalizeMcpImport({
        name: normalizeName(name),
        command: 'uvx',
        args: [name],
        enabled: enableMcp
    }, { enableMcp });
}

function analyzeCapabilityText(text, sourceUrl, { enableMcp = false } = {}) {
    const imported = { skills: [], mcpServers: [], plugins: [], sourceUrl };
    const json = parseJson(text);

    if (json) {
        const rawMcpServers = [
            ...arrayFromMaybeObject(json.mcpServers),
            ...arrayFromMaybeObject(json.servers)
        ];
        if (json.command) rawMcpServers.push(json);
        rawMcpServers
            .map(server => normalizeMcpImport(server, { enableMcp }))
            .filter(Boolean)
            .forEach(server => imported.mcpServers.push(server));

        const rawSkills = Array.isArray(json.skills) ? json.skills : [];
        if (json.skill && typeof json.skill === 'object') rawSkills.push(json.skill);
        if (json.instructions || json.content || json.prompt) rawSkills.push(json);
        rawSkills.forEach(raw => {
            const instructions = raw.instructions || raw.content || raw.prompt || raw.body;
            if (!instructions) return;
            imported.skills.push({
                name: normalizeName(raw.name || json.name || 'imported-skill', 'imported-skill'),
                description: raw.description || json.description || `Imported from ${sourceUrl}`,
                trigger: raw.trigger || '',
                instructions,
                enabled: raw.enabled !== false
            });
        });

        const npmServer = packageJsonToMcp(json, { enableMcp });
        if (npmServer) imported.mcpServers.push(npmServer);

        if (json.name || imported.skills.length > 0 || imported.mcpServers.length > 0) {
            imported.plugins.push({
                name: normalizeName(json.name || new URL(sourceUrl).pathname.split('/').filter(Boolean).slice(-2).join('-') || 'imported-plugin', 'imported-plugin'),
                description: json.description || `Imported from ${sourceUrl}`,
                sourceUrl,
                skills: imported.skills,
                mcpServers: imported.mcpServers,
                enabled: true
            });
        }

        return imported;
    }

    if (/^\s*#|^---[\s\S]*?name:/m.test(text) && /skill|instructions|trigger|workflow|when/i.test(text)) {
        const skill = parseSkillMarkdown(text, sourceUrl);
        if (!skill) return imported;
        imported.skills.push(skill);
        imported.plugins.push({
            name: imported.skills[0].name,
            description: imported.skills[0].description,
            sourceUrl,
            skills: imported.skills,
            mcpServers: [],
            enabled: true
        });
        return imported;
    }

    const pyprojectServer = parsePyprojectMcp(text, { enableMcp });
    if (pyprojectServer) {
        imported.mcpServers.push(pyprojectServer);
        imported.plugins.push({
            name: pyprojectServer.name,
            description: `Python MCP server imported from ${sourceUrl}`,
            sourceUrl,
            skills: [],
            mcpServers: imported.mcpServers,
            enabled: true
        });
    }

    return imported;
}

function dedupeByName(items) {
    const map = new Map();
    items.forEach(item => {
        if (!item?.name) return;
        map.set(item.name, item);
    });
    return Array.from(map.values());
}

async function resolveCapabilityFromLink(url, options = {}) {
    const knownRecipe = getBrowserUseRecipe(url, options);
    if (knownRecipe) return knownRecipe;

    const candidates = buildCandidateUrls(url);
    const errors = [];
    for (const candidate of candidates) {
        try {
            const text = await fetchText(candidate);
            const analyzed = analyzeCapabilityText(text, candidate, options);
            analyzed.skills = dedupeByName(analyzed.skills);
            analyzed.mcpServers = dedupeByName(analyzed.mcpServers);
            analyzed.plugins = dedupeByName(analyzed.plugins);
            if (analyzed.skills.length || analyzed.mcpServers.length || analyzed.plugins.length) {
                return { ...analyzed, resolvedUrl: candidate, attemptedUrls: candidates };
            }
            errors.push(`${candidate}: no supported skill/MCP/plugin metadata found`);
        } catch (e) {
            errors.push(`${candidate}: ${e.message}`);
        }
    }
    throw new Error(`Could not import capability link. Tried ${candidates.length} URL(s): ${errors.slice(0, 5).join('; ')}`);
}

async function importCapabilityLink({ url, enableMcp = false } = {}) {
    const resolved = await resolveCapabilityFromLink(url, { enableMcp });
    const savedSkills = resolved.skills.map(skill => saveSkill(skill));
    const savedMcpServers = resolved.mcpServers.map(server => saveCustomMcpServer(server));
    const savedPlugins = resolved.plugins.map(plugin => savePlugin({
        ...plugin,
        skills: savedSkills,
        mcpServers: savedMcpServers
    }));
    return {
        sourceUrl: url,
        resolvedUrl: resolved.resolvedUrl,
        attemptedUrls: resolved.attemptedUrls,
        skills: savedSkills,
        mcpServers: savedMcpServers,
        plugins: savedPlugins,
        enabledMcpServers: savedMcpServers.filter(server => server.enabled !== false).map(server => server.name)
    };
}

module.exports = {
    analyzeCapabilityText,
    buildCandidateUrls,
    getBrowserUseRecipe,
    importCapabilityLink,
    resolveCapabilityFromLink
};
