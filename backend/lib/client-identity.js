const CLIENT_PATTERNS = [
    { id: 'claude-code', ua: ['claude-code'], header: null },
    { id: 'claude-desktop', ua: ['claude-desktop-3p'], header: null },
    { id: 'hermes', ua: [], header: { key: 'x-source', value: 'hermes' } },
    { id: 'opencode', ua: ['opencode'], header: null },
    { id: 'openwhispr', ua: ['openwhispr'], header: null },
    { id: 'codex', ua: ['codex'], header: null },
];

const CLIENT_DISPLAY_NAMES = {
    'claude-code': 'Claude Code',
    'claude-desktop': 'Claude Desktop',
    'hermes': 'Hermes Agent',
    'opencode': 'OpenCode',
    'openwhispr': 'OpenWhispr',
    'codex': 'Codex',
    'dashboard': 'Proxy Dashboard',
    'unknown': 'Unknown Client',
};

function identifyClient(req) {
    if (!req || typeof req !== 'object') return 'unknown';
    const ua = (req.headers && typeof req.headers === 'object'
        ? String(req.headers['user-agent'] || '')
        : ''
    ).toLowerCase();
    const source = (req.headers && typeof req.headers === 'object'
        ? String(req.headers['x-source'] || '')
        : ''
    ).toLowerCase();

    for (const pattern of CLIENT_PATTERNS) {
        const matchesUA = pattern.ua.some(p => ua.includes(p));
        const matchesHeader = pattern.header
            ? source.includes(pattern.header.value)
            : false;
        if (matchesUA || matchesHeader) return pattern.id;
    }

    return 'unknown';
}

function getDisplayName(clientId) {
    return CLIENT_DISPLAY_NAMES[clientId] || 'Unknown';
}

module.exports = { identifyClient, getDisplayName, CLIENT_DISPLAY_NAMES };
