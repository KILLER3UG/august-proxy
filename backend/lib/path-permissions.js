const path = require('path');
const os = require('os');

const DEFAULT_ALLOWED_BASE_PATHS = [
    'C:\\Users\\rober\\LocalFolders',
    'C:/Users/rober/LocalFolders'
];

function splitPathList(value) {
    return String(value || '')
        .split(/[;|,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeForPermission(filePath) {
    const text = String(filePath || '').trim();
    if (/^[A-Za-z]:[\\/]/.test(text)) return path.win32.resolve(text);
    if (text.startsWith('/')) return path.posix.resolve(text);
    return path.resolve(text);
}

function isPosixPath(filePath) {
    return String(filePath || '').startsWith('/');
}

function isWindowsPath(filePath) {
    return /^[A-Za-z]:[\\/]/.test(String(filePath || ''));
}

function isPathWithinAllowedBase(base, filePath) {
    const relative = isPosixPath(base) && isPosixPath(filePath)
        ? path.posix.relative(base, filePath)
        : isWindowsPath(base) && isWindowsPath(filePath)
            ? path.win32.relative(base, filePath)
            : path.relative(base, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Read extra allowed roots from config + data-paths lazily. Wrapped in try/catch
 * to avoid hard-loading config at module init (avoids circular dependency risk
 * if config.js ever needs path-permissions).
 */
function readConfigRoots() {
    const out = [];
    try {
        const { getConfig } = require('./config');
        const cfg = getConfig();
        const sec = cfg && cfg.security;
        if (sec && Array.isArray(sec.allowedRoots)) out.push(...sec.allowedRoots);
    } catch (_) { /* config not ready yet; ignore */ }
    try {
        const { getDataDir } = require('./data-paths');
        const dataDir = getDataDir();
        if (dataDir) out.push(dataDir);
    } catch (_) { /* data-paths not ready yet; ignore */ }
    try {
        const tmp = os.tmpdir();
        if (tmp) out.push(tmp);
    } catch (_) { /* os.tmpdir() shouldn't throw; ignore anyway */ }
    return out;
}

/**
 * Returns the merged list of allowed base paths.
 * @param {string[]} [extraRoots] - additional roots to merge (e.g. session CWD).
 */
function getAllowedBasePaths(extraRoots) {
    const workspaceRoot = process.env.AUGUST_PROXY_WORKDIR || process.env.AUGUST_WORKDIR;
    const proxyRoot = process.env.AUGUST_PROXY_ROOT || process.cwd();
    return [
        ...DEFAULT_ALLOWED_BASE_PATHS,
        ...splitPathList(process.env.AUGUST_PROXY_ALLOWED_PATHS),
        ...splitPathList(process.env.AUGUST_PROXY_ALLOWED_ROOTS),
        ...splitPathList(process.env.AUGUST_PROXY_DESKTOP_ROOTS),
        ...splitPathList(process.env.AUGUST_PROXY_CONTAINER_ROOTS),
        process.env.AUGUST_PROXY_CONTAINER_ROOT,
        workspaceRoot,
        proxyRoot,
        ...readConfigRoots(),
        ...(Array.isArray(extraRoots) ? extraRoots : [])
    ].filter(Boolean);
}

function hasParentTraversal(command) {
    return /(^|[\s"'`(])\.\.(?:[\\/]|$)/.test(command);
}

function extractPathsFromCommand(command) {
    if (!command || typeof command !== 'string') return [];
    const found = [];
    const winPaths = command.match(/[A-Za-z]:[\\/][^\s"'`,;|&>]+/g) || [];
    found.push(...winPaths);
    const unixPaths = command.match(/\/(?:home|usr|etc|tmp|var|root|opt|mnt|srv|data)[^\s"'`,;|&>]*/g) || [];
    found.push(...unixPaths);
    return found;
}

/**
 * Check whether `filePath` is inside any allowed base path.
 * @param {string} filePath
 * @param {string[]} [extraRoots] - additional roots to merge with config + env.
 * @returns {string|null} null if allowed, error message if denied.
 */
function checkPathPermission(filePath, extraRoots) {
    const resolvedPath = normalizeForPermission(filePath);
    const allPaths = getAllowedBasePaths(extraRoots);
    const isAllowed = allPaths.some(base => {
        const normalizedBase = normalizeForPermission(base);
        return isPathWithinAllowedBase(normalizedBase, resolvedPath);
    });
    if (isAllowed) return null;
    return `[August Permission Denied]\n` +
           `The path '${resolvedPath}' is outside the permitted workspace.\n` +
           `Permitted workspace roots:\n${allPaths.map(p => `  - ${p}`).join('\n')}\n\n` +
           `You do NOT have permission to access this path. ` +
           `Stop and ask the user to explicitly grant access to this location before proceeding.`;
}

function checkCommandPaths(command) {
    if (hasParentTraversal(command)) {
        const allowedBasePaths = getAllowedBasePaths();
        return `[August Permission Denied]\n` +
               `The command contains parent-directory traversal ('..'), which is blocked because it can escape the permitted workspace roots.\n` +
               `Permitted workspace roots:\n${allowedBasePaths.map(p => `  - ${p}`).join('\n')}\n\n` +
               `Use an explicit path inside the workspace, or ask the user to approve a different location first.`;
    }
    const paths = extractPathsFromCommand(command);
    for (const p of paths) {
        const blockMsg = checkPathPermission(p);
        if (blockMsg) return blockMsg;
    }
    return null;
}

module.exports = {
    extractPathsFromCommand,
    hasParentTraversal,
    getAllowedBasePaths,
    checkPathPermission,
    checkCommandPaths
};
