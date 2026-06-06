const { importCapabilityLink, resolveCapabilityFromLink } = require('./link-importer');

const USER_AGENT = 'AugustProxy-SkillImporter/1.0';
const GITHUB_SEARCH_LIMIT = 8;

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function clampLimit(value, fallback = 5) {
    const n = Number(value || fallback);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(GITHUB_SEARCH_LIMIT, Math.floor(n)));
}

function buildGithubSearchQueries(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim();
    if (!q) return [];
    return [
        `${q} SKILL.md in:name,description,readme`,
        `${q} codex skill in:name,description,readme`,
        `${q} claude skill in:name,description,readme`,
        `${q} mcp skill in:name,description,readme`
    ];
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/vnd.github+json, application/json'
        },
        signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) {
        let detail = text.slice(0, 240);
        try {
            const parsed = JSON.parse(text);
            detail = parsed.message || detail;
        } catch {}
        throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return JSON.parse(text);
}

function repoToCandidate(repo, index) {
    return {
        rank: index + 1,
        source: 'github',
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || '',
        url: repo.html_url,
        importUrl: repo.html_url,
        defaultBranch: repo.default_branch || 'main',
        stars: repo.stargazers_count || 0,
        updatedAt: repo.updated_at || null,
        language: repo.language || null,
        reason: 'Repository match. Preview it before importing; the importer checks SKILL.md, plugin manifests, MCP manifests, package metadata, and pyproject metadata.'
    };
}

async function searchGithubSkillSources(query, { limit = 5 } = {}) {
    const queries = buildGithubSearchQueries(query);
    const max = clampLimit(limit);
    const seen = new Set();
    const candidates = [];
    const errors = [];

    for (const searchQuery of queries) {
        if (candidates.length >= max) break;
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=updated&order=desc&per_page=${max}`;
        try {
            const data = await fetchJson(url);
            const items = Array.isArray(data.items) ? data.items : [];
            for (const repo of items) {
                if (!repo?.full_name || seen.has(repo.full_name)) continue;
                seen.add(repo.full_name);
                candidates.push(repoToCandidate(repo, candidates.length));
                if (candidates.length >= max) break;
            }
        } catch (e) {
            errors.push(`${searchQuery}: ${e.message}`);
        }
    }

    return {
        query,
        source: 'github',
        candidates,
        errors,
        note: candidates.length
            ? 'Use august__preview_skill_import or august__preview_skill_import on a candidate importUrl before saving it.'
            : 'No GitHub candidates found. Try a direct GitHub/raw/http URL or search with WebSearch first.'
    };
}

function summarizeResolvedCapability(resolved, sourceUrl) {
    const skills = (resolved.skills || []).map(skill => ({
        name: skill.name,
        description: skill.description || '',
        trigger: skill.trigger || '',
        enabled: skill.enabled !== false
    }));
    const mcpServers = (resolved.mcpServers || []).map(server => ({
        name: server.name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        enabled: server.enabled !== false,
        timeoutMs: server.timeoutMs
    }));
    const plugins = (resolved.plugins || []).map(plugin => ({
        name: plugin.name,
        description: plugin.description || '',
        sourceUrl: plugin.sourceUrl || sourceUrl,
        enabled: plugin.enabled !== false,
        skillCount: Array.isArray(plugin.skills) ? plugin.skills.length : 0,
        mcpServerCount: Array.isArray(plugin.mcpServers) ? plugin.mcpServers.length : 0
    }));

    return {
        sourceUrl,
        resolvedUrl: resolved.resolvedUrl || sourceUrl,
        attemptedUrls: resolved.attemptedUrls || [],
        installable: skills.length > 0 || mcpServers.length > 0 || plugins.length > 0,
        skills,
        mcpServers,
        plugins,
        note: 'Preview only. Nothing was saved. Importing this capability is a mutation and requires explicit approval.'
    };
}

async function previewSkillImport({ url, enableMcp = false } = {}) {
    if (!isHttpUrl(url)) throw new Error('A public GitHub/raw/http URL is required.');
    const resolved = await resolveCapabilityFromLink(url, { enableMcp });
    return summarizeResolvedCapability(resolved, url);
}

async function findSkillSources({ query, url, limit = 5, verify = false, enableMcp = false } = {}) {
    const directUrl = String(url || query || '').trim();
    if (isHttpUrl(directUrl)) {
        const preview = await previewSkillImport({ url: directUrl, enableMcp });
        return {
            query: query || directUrl,
            source: 'direct_url',
            candidates: [{
                rank: 1,
                source: 'direct_url',
                name: preview.skills[0]?.name || preview.plugins[0]?.name || 'imported-capability',
                description: preview.skills[0]?.description || preview.plugins[0]?.description || '',
                url: directUrl,
                importUrl: directUrl,
                preview
            }],
            errors: [],
            note: 'Direct URL resolved. Submit a plan and get approval before importing.'
        };
    }

    if (!String(query || '').trim()) throw new Error('A search query or direct URL is required.');
    const result = await searchGithubSkillSources(query, { limit });

    if (verify && result.candidates.length > 0) {
        for (const candidate of result.candidates.slice(0, Math.min(2, result.candidates.length))) {
            try {
                candidate.preview = await previewSkillImport({ url: candidate.importUrl, enableMcp });
            } catch (e) {
                candidate.previewError = e.message;
            }
        }
    }

    return result;
}

async function importSkillFromLink({ url, enableMcp = false, restartMcp = true } = {}) {
    if (!isHttpUrl(url)) throw new Error('A public GitHub/raw/http URL is required.');
    const imported = await importCapabilityLink({ url, enableMcp });
    let mcpStatus = null;
    if (restartMcp && imported.enabledMcpServers.length > 0) {
        try {
            const { restartMcpServers } = require('./mcp-client');
            const { getProfile } = require('../../lib/config');
            mcpStatus = await restartMcpServers(getProfile('claude')?.apiKey || '');
        } catch (e) {
            mcpStatus = { error: e.message };
        }
    }
    return {
        status: 'imported',
        ...imported,
        mcpStatus,
        availability: {
            skillCatalog: 'Imported skills are saved globally and appear in the proxy skill catalog on the next request.',
            loadTool: 'Use august__load_skill with the saved skill name to load full instructions.',
            clients: 'Available to Workbench, Claude Code, Hermes, Codex, and other clients connected through this proxy.'
        }
    };
}

module.exports = {
    buildGithubSearchQueries,
    findSkillSources,
    importSkillFromLink,
    isHttpUrl,
    previewSkillImport,
    searchGithubSkillSources,
    summarizeResolvedCapability
};
