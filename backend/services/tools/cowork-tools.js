const fs = require('fs');
const path = require('path');
const {
    readAugustCoreMemory,
    writeAugustCoreMemory,
    renderAugustCoreMemory
} = require('./august-tools');
const { getSkills, saveSkill } = require('./skills');
const { importCapabilityLink } = require('./link-importer');

const COWORK_SERVER = 'cowork';
const COWORK_TOOL_NAMES = new Set([
    'mcp__cowork__request_cowork_directory',
    'mcp__cowork__present_files',
    'mcp__cowork__save_skill',
    'mcp__cowork__import_capability_link',
    'mcp__cowork__read_widget_context',
    'mcp__cowork__allow_cowork_file_delete'
]);

const ACCESSIBLE_ROOTS = [
    '/app/host_files',
    '/app/src'
];

const HOST_PATH_MAPPINGS = [
    {
        host: 'C:\\Users\\rober\\LocalFolders\\DockerContainer\\august-proxy\\host_files',
        local: '/app/host_files'
    },
    {
        host: 'C:\\Users\\rober\\LocalFolders\\DockerContainer\\august-proxy\\src',
        local: '/app/src'
    }
];

function isCoworkToolName(name) {
    return typeof name === 'string' && COWORK_TOOL_NAMES.has(name);
}

function normalizeSlash(value) {
    return String(value || '').replace(/\\/g, '/');
}

function mapHostPathToContainer(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return '/app/host_files';

    const normalizedRaw = normalizeSlash(raw).toLowerCase();
    for (const mapping of HOST_PATH_MAPPINGS) {
        const normalizedHost = normalizeSlash(mapping.host).toLowerCase();
        if (normalizedRaw === normalizedHost || normalizedRaw.startsWith(`${normalizedHost}/`)) {
            const suffix = normalizeSlash(raw).slice(normalizeSlash(mapping.host).length).replace(/^\/+/, '');
            return suffix ? path.posix.join(mapping.local, suffix) : mapping.local;
        }
    }

    return raw;
}

function resolveCoworkPath(inputPath) {
    const mapped = mapHostPathToContainer(inputPath);
    const normalized = mapped.startsWith('/')
        ? path.posix.normalize(mapped)
        : path.posix.normalize(path.posix.join('/app/host_files', mapped));

    const allowed = ACCESSIBLE_ROOTS.some(root => {
        const relative = path.posix.relative(root, normalized);
        return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
    });

    return {
        requestedPath: inputPath || '',
        localPath: normalized,
        allowed,
        allowedRoots: ACCESSIBLE_ROOTS
    };
}

function safeStat(localPath) {
    try {
        const stat = fs.statSync(localPath);
        return {
            exists: true,
            type: stat.isDirectory() ? 'directory' : (stat.isFile() ? 'file' : 'other'),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
        };
    } catch (e) {
        return {
            exists: false,
            type: 'missing',
            sizeBytes: 0,
            modifiedAt: null
        };
    }
}

function listDirectoryPreview(localPath, limit = 25) {
    try {
        const entries = fs.readdirSync(localPath, { withFileTypes: true })
            .slice(0, limit)
            .map(entry => {
                const childPath = path.posix.join(localPath, entry.name);
                const stat = safeStat(childPath);
                return {
                    name: entry.name,
                    path: childPath,
                    type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
                    sizeBytes: stat.sizeBytes,
                    modifiedAt: stat.modifiedAt
                };
            });
        return entries;
    } catch (e) {
        return [];
    }
}

function extractRequestedPath(args = {}) {
    return args.path || args.directory || args.directory_path || args.dir || args.root || '';
}

function normalizeFilesInput(args = {}) {
    const raw = args.files || args.paths || args.path || [];
    const array = Array.isArray(raw) ? raw : [raw];
    return array
        .map(item => {
            if (typeof item === 'string') return { path: item };
            if (item && typeof item === 'object') return item;
            return null;
        })
        .filter(Boolean);
}

function recordCoworkEvent(summary) {
    if (process.env.NODE_ENV === 'test') return;
    try {
        const memory = readAugustCoreMemory();
        memory.recent_events = Array.isArray(memory.recent_events) ? memory.recent_events : [];
        memory.recent_events.push({
            summary,
            timestamp: new Date().toISOString(),
            source: 'cowork-compat'
        });
        memory.recent_events = memory.recent_events.slice(-50);
        writeAugustCoreMemory(memory);
    } catch (e) {
        // Memory write failures should not break the compatibility tool.
    }
}

function getCoworkToolDefinitions() {
    return [
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__request_cowork_directory',
                description: '[Cowork compatibility] Request local directory access through the proxy. The proxy grants access to mounted safe roots and explains mount requirements for unavailable host paths.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Directory path requested by the model or user.' },
                        directory: { type: 'string', description: 'Alias for path.' },
                        directory_path: { type: 'string', description: 'Alias for path.' },
                        reason: { type: 'string', description: 'Why the directory is needed.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__import_capability_link',
                description: '[Cowork compatibility] Import a custom proxy plugin, MCP server, or skill from a GitHub/raw/http link. Saved skills are shared through the proxy-global skill catalog. MCP servers are saved disabled unless enable_mcp is true.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'GitHub, raw, or http(s) link to a plugin manifest, mcp config, package.json, pyproject.toml, or SKILL.md.' },
                        enable_mcp: { type: 'boolean', description: 'Set true to enable imported MCP servers immediately. Defaults to false for safety.' }
                    },
                    required: ['url']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__present_files',
                description: '[Cowork compatibility] Present file metadata as text cards for the current chat.',
                parameters: {
                    type: 'object',
                    properties: {
                        files: {
                            type: 'array',
                            description: 'Files or directories to present.',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' },
                                    title: { type: 'string' },
                                    description: { type: 'string' }
                                }
                            }
                        },
                        paths: {
                            type: 'array',
                            description: 'Alias list of file paths.',
                            items: { type: 'string' }
                        },
                        title: { type: 'string', description: 'Optional presentation title.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__save_skill',
                description: '[Cowork compatibility] Save or update a local custom skill in config.customSkills so it is injected into August context.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Skill name.' },
                        description: { type: 'string', description: 'Short skill description.' },
                        trigger: { type: 'string', description: 'When to use the skill.' },
                        instructions: { type: 'string', description: 'Skill instructions.' },
                        content: { type: 'string', description: 'Alias for instructions.' },
                        enabled: { type: 'boolean', description: 'Whether the skill should be active.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__read_widget_context',
                description: '[Cowork compatibility] Read the current dashboard/August context when no embedded widget is available.',
                parameters: {
                    type: 'object',
                    properties: {
                        widget_id: { type: 'string', description: 'Optional widget id.' },
                        include_memory: { type: 'boolean', description: 'Include August memory summary.' },
                        include_skills: { type: 'boolean', description: 'Include custom skills summary.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__cowork__allow_cowork_file_delete',
                description: '[Cowork compatibility] Check whether a deletion target is inside a mounted safe root. This tool never deletes files by itself.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File or directory path proposed for deletion.' },
                        directory: { type: 'string', description: 'Alias for path.' },
                        directory_path: { type: 'string', description: 'Alias for path.' },
                        reason: { type: 'string', description: 'Why deletion is needed.' }
                    }
                }
            }
        }
    ];
}

async function executeCoworkToolCall(toolName, args = {}) {
    if (!isCoworkToolName(toolName)) {
        throw new Error(`Unsupported Cowork compatibility tool: ${toolName}`);
    }

    switch (toolName) {
        case 'mcp__cowork__request_cowork_directory': {
            const resolved = resolveCoworkPath(extractRequestedPath(args));
            const stat = resolved.allowed ? safeStat(resolved.localPath) : { exists: false, type: 'blocked' };
            const preview = resolved.allowed && stat.type === 'directory'
                ? listDirectoryPreview(resolved.localPath)
                : [];
            const status = resolved.allowed ? 'granted' : 'needs_mount';
            recordCoworkEvent(`Cowork directory request ${status} for ${resolved.requestedPath || resolved.localPath}.`);
            return {
                compatibilityLayer: COWORK_SERVER,
                status,
                requestedPath: resolved.requestedPath,
                localPath: resolved.localPath,
                accessible: resolved.allowed,
                exists: stat.exists,
                type: stat.type,
                allowedRoots: resolved.allowedRoots,
                note: resolved.allowed
                    ? 'The proxy can use this mounted path directly. Continue with filesystem/MCP tools using localPath.'
                    : 'That host path is not mounted inside the proxy container. Add it as a custom MCP server/root or copy needed files under /app/host_files.',
                preview
            };
        }

        case 'mcp__cowork__present_files': {
            const files = normalizeFilesInput(args).map(file => {
                const resolved = resolveCoworkPath(file.path || file.name || '');
                const stat = resolved.allowed ? safeStat(resolved.localPath) : { exists: false, type: 'blocked' };
                return {
                    title: file.title || path.posix.basename(resolved.localPath),
                    description: file.description || '',
                    requestedPath: resolved.requestedPath,
                    localPath: resolved.localPath,
                    accessible: resolved.allowed,
                    ...stat
                };
            });
            return {
                compatibilityLayer: COWORK_SERVER,
                title: args.title || 'Presented files',
                fileCount: files.length,
                files
            };
        }

        case 'mcp__cowork__save_skill': {
            const payload = {
                name: args.name,
                description: args.description || '',
                trigger: args.trigger || '',
                instructions: args.instructions || args.content || args.body || '',
                enabled: args.enabled !== false
            };
            if (!payload.name || !payload.instructions) {
                return {
                    compatibilityLayer: COWORK_SERVER,
                    status: 'needs_retry',
                    error: 'Skill name and instructions are required.',
                    selfHeal: 'Retry mcp__cowork__save_skill with { name, instructions, trigger?, description?, enabled? }.'
                };
            }
            const saved = saveSkill(payload);
            recordCoworkEvent(`Saved custom skill '${saved.name}' through Cowork compatibility.`);
            return {
                compatibilityLayer: COWORK_SERVER,
                status: 'saved',
                skill: saved,
                note: 'Skill is stored in config.customSkills and injected into August context under <custom_skills>.'
            };
        }

        case 'mcp__cowork__import_capability_link': {
            if (!args.url) {
                return {
                    compatibilityLayer: COWORK_SERVER,
                    status: 'needs_retry',
                    error: 'A url is required.',
                    selfHeal: 'Retry with { "url": "https://...", "enable_mcp": false }.'
                };
            }
            const imported = await importCapabilityLink({
                url: args.url,
                enableMcp: args.enable_mcp === true
            });
            recordCoworkEvent(`Imported proxy capability link ${args.url}.`);
            return {
                compatibilityLayer: COWORK_SERVER,
                status: 'imported',
                ...imported,
                note: imported.enabledMcpServers.length > 0
                    ? 'Imported MCP servers were enabled; restart MCP servers if the dashboard did not already do it.'
                    : 'Imported skills are available to all proxy clients on the next request. Imported MCP servers were saved disabled by default; enable them from the MCP & Skills dashboard after reviewing the command.'
            };
        }

        case 'mcp__cowork__read_widget_context': {
            const memory = readAugustCoreMemory();
            const renderedMemory = renderAugustCoreMemory(memory);
            const skills = getSkills().map(skill => ({
                name: skill.name,
                enabled: skill.enabled,
                trigger: skill.trigger,
                description: skill.description
            }));
            return {
                compatibilityLayer: COWORK_SERVER,
                status: 'available',
                widgetId: args.widget_id || null,
                note: 'No embedded Cowork widget runtime is active, so this returns the proxy dashboard context instead.',
                memory: args.include_memory === false ? undefined : renderedMemory,
                skills: args.include_skills === false ? undefined : skills
            };
        }

        case 'mcp__cowork__allow_cowork_file_delete': {
            const resolved = resolveCoworkPath(extractRequestedPath(args));
            const stat = resolved.allowed ? safeStat(resolved.localPath) : { exists: false, type: 'blocked' };
            return {
                compatibilityLayer: COWORK_SERVER,
                status: resolved.allowed ? 'allowed_for_explicit_delete_tool' : 'blocked',
                requestedPath: resolved.requestedPath,
                localPath: resolved.localPath,
                accessible: resolved.allowed,
                exists: stat.exists,
                type: stat.type,
                note: resolved.allowed
                    ? 'This only records that the target is inside a mounted safe root. It did not delete anything.'
                    : 'Deletion target is outside mounted safe roots and is blocked.',
                allowedRoots: resolved.allowedRoots
            };
        }

        default:
            throw new Error(`Unsupported Cowork compatibility tool: ${toolName}`);
    }
}

module.exports = {
    ACCESSIBLE_ROOTS,
    COWORK_TOOL_NAMES,
    executeCoworkToolCall,
    getCoworkToolDefinitions,
    isCoworkToolName,
    resolveCoworkPath
};
