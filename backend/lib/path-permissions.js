const path = require('path');

const ALLOWED_BASE_PATHS = [
    'C:\\Users\\rober\\LocalFolders',
    'C:/Users/rober/LocalFolders'
];
const NORMALIZED_ALLOWED_BASE_PATHS = ALLOWED_BASE_PATHS.map(base => path.resolve(base));

function extractPathsFromCommand(command) {
    if (!command || typeof command !== 'string') return [];
    const found = [];
    const winPaths = command.match(/[A-Za-z]:[\\\/][^\s"'`,;|&>]+/g) || [];
    found.push(...winPaths);
    const unixPaths = command.match(/\/(?:home|usr|etc|tmp|var|root|opt|mnt|srv|data)[^\s"'`,;|&>]*/g) || [];
    found.push(...unixPaths);
    return found;
}

function hasParentTraversal(command) {
    return /(^|[\s"'`(])\.\.(?:[\\/]|$)/.test(command);
}

function checkPathPermission(filePath) {
    const resolvedPath = path.resolve(filePath);
    const isAllowed = NORMALIZED_ALLOWED_BASE_PATHS.some(base => {
        const relative = path.relative(base, resolvedPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (isAllowed) return null;
    return `[August Permission Denied]\n` +
           `The path '${resolvedPath}' is outside the permitted workspace.\n` +
           `Permitted workspace roots:\n${ALLOWED_BASE_PATHS.map(p => `  - ${p}`).join('\n')}\n\n` +
           `You do NOT have permission to access this path. ` +
           `Stop and ask the user to explicitly grant access to this location before proceeding.`;
}

function checkCommandPaths(command) {
    if (hasParentTraversal(command)) {
        return `[August Permission Denied]\n` +
               `The command contains parent-directory traversal ('..'), which is blocked because it can escape the permitted workspace roots.\n` +
               `Permitted workspace roots:\n${ALLOWED_BASE_PATHS.map(p => `  - ${p}`).join('\n')}\n\n` +
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
    ALLOWED_BASE_PATHS,
    NORMALIZED_ALLOWED_BASE_PATHS,
    extractPathsFromCommand,
    hasParentTraversal,
    checkPathPermission,
    checkCommandPaths
};
