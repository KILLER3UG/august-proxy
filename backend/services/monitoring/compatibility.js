const fs = require('fs');
const path = require('path');
const { getAugustToolDefinitions } = require('../tools/august-tools');
const { getCoworkToolDefinitions } = require('../tools/cowork-tools');
const { getMcpServerStatus } = require('../tools/mcp-client');
const { getPlugins } = require('../tools/plugins');

const HOST_FILES_HOST_PATH = 'C:\\Users\\rober\\LocalFolders\\DockerContainer\\august-proxy\\host_files';
const HOST_FILES_CONTAINER_PATH = '/app/host_files';
const HOST_FILES_LOCAL_PATH = path.join(__dirname, '..', '..', '..', 'host_files');

function ensureHostFilesRoot() {
    if (!fs.existsSync(HOST_FILES_LOCAL_PATH)) {
        fs.mkdirSync(HOST_FILES_LOCAL_PATH, { recursive: true });
    }
    return HOST_FILES_LOCAL_PATH;
}

function sanitizeFolderName(value) {
    const name = String(value || 'dropzone')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return name || 'dropzone';
}

function createHostFilesFolder(name) {
    const root = ensureHostFilesRoot();
    const folderName = sanitizeFolderName(name);
    const folderPath = path.join(root, folderName);
    const resolved = path.resolve(folderPath);
    const rootResolved = path.resolve(root);
    const relative = path.relative(rootResolved, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Folder name escapes host_files root.');
    }
    fs.mkdirSync(resolved, { recursive: true });
    return {
        name: folderName,
        hostPath: path.win32.join(HOST_FILES_HOST_PATH, folderName),
        containerPath: `${HOST_FILES_CONTAINER_PATH}/${folderName}`
    };
}

function fileInfo(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return {
            exists: true,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
        };
    } catch (e) {
        return { exists: false, sizeBytes: 0, modifiedAt: null };
    }
}

function getHostFilesInfo() {
    const root = ensureHostFilesRoot();
    let folders = [];
    try {
        folders = fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => ({
                name: entry.name,
                hostPath: path.win32.join(HOST_FILES_HOST_PATH, entry.name),
                containerPath: `${HOST_FILES_CONTAINER_PATH}/${entry.name}`
            }));
    } catch (e) {
        folders = [];
    }

    return {
        hostPath: HOST_FILES_HOST_PATH,
        containerPath: HOST_FILES_CONTAINER_PATH,
        localPath: root,
        ...fileInfo(root),
        folders
    };
}

function summarizeMcpTools(status) {
    return (status || []).flatMap(server => {
        const tools = Array.isArray(server.tools) ? server.tools : [];
        return tools.map(tool => ({
            name: `mcp__${server.name}__${tool}`,
            mode: 'mcp-backed',
            status: server.status,
            server: server.name
        }));
    });
}

function getCompatibilityStatus() {
    const mcpStatus = getMcpServerStatus();
    const mcpTools = summarizeMcpTools(mcpStatus);
    const plugins = getPlugins();

    return {
        generatedAt: new Date().toISOString(),
        claudeDesktopPluginRestriction: {
            status: 'client-restricted',
            message: 'Claude Desktop third-party/organization plugin marketplace restrictions cannot be unlocked by the proxy. Local proxy plugins are the compatibility path: imported skills and MCP servers are injected through August Proxy instead.'
        },
        hostFiles: getHostFilesInfo(),
        families: [
            {
                name: 'Web compatibility',
                mode: 'proxy-owned',
                status: 'available',
                tools: ['WebSearch', 'WebFetch', 'web_search', 'web_fetch', 'mcp__workspace__web_search', 'mcp__workspace__web_fetch']
                    .map(name => ({ name, mode: 'local-shim', status: 'available' }))
            },
            {
                name: 'Cowork compatibility',
                mode: 'proxy-owned',
                status: 'available',
                tools: getCoworkToolDefinitions().map(tool => ({
                    name: tool.function.name,
                    mode: 'local-shim',
                    status: 'available'
                }))
            },
            {
                name: 'August Brain',
                mode: 'proxy-owned',
                status: 'available',
                tools: getAugustToolDefinitions().map(tool => ({
                    name: tool.function.name,
                    mode: 'local-memory',
                    status: 'available'
                }))
            },
            {
                name: 'Configured MCP servers',
                mode: 'mcp-backed',
                status: mcpStatus.some(server => server.status === 'error') ? 'degraded' : 'available',
                tools: mcpTools,
                servers: mcpStatus
            },
            {
                name: 'Proxy plugins',
                mode: 'local-plugin-layer',
                status: plugins.length > 0 ? 'available' : 'empty',
                tools: plugins.map(plugin => ({
                    name: plugin.name,
                    mode: plugin.enabled ? 'enabled-plugin' : 'disabled-plugin',
                    status: plugin.enabled ? 'enabled' : 'disabled',
                    description: plugin.description
                }))
            }
        ]
    };
}

module.exports = {
    createHostFilesFolder,
    ensureHostFilesRoot,
    getCompatibilityStatus,
    getHostFilesInfo
};
