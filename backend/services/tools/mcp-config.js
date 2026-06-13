module.exports = {
    mcpServers: [
        {
            name: 'minimax',
            enabled: process.env.MINIMAX_MCP_ENABLED === '1',
            source: 'builtin',
            // Disabled until a valid MiniMax API key is available. Set MINIMAX_MCP_ENABLED=1 after rotating the key.
            // Uses uvx to run the python-based minimax MCP server
            command: 'uvx',
            args: ['minimax-coding-plan-mcp'],
            env: { 
                // Ensure this matches the endpoint you are using
                MINIMAX_API_HOST: 'https://api.minimax.io', 
                // Resolved at process start so the UI never exposes the real key
                MINIMAX_API_KEY: '${env:MINIMAX_API_KEY}'
            },
            timeoutMs: 60000
        },
        {
            name: 'filesystem',
            enabled: true,
            source: 'builtin',
            // Node-based filesystem server
            command: 'npx',
            // Note: In Docker, you must mount the host folder to /app/host_files in docker-compose.yml
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/app/host_files']
        },
        {
            name: 'fetch',
            enabled: true,
            source: 'builtin',
            // Clean markdown web fetching
            command: 'uvx',
            args: ['mcp-server-fetch'],
            timeoutMs: 60000
        },
        {
            name: 'blender',
            enabled: false,
            source: 'builtin',
            // Control Blender via MCP (requires Blender addon to be running)
            command: 'node',
            args: ['/app/claudekit-blender-mcp/dist/index.js'],
            env: {
                // Must use host.docker.internal because the proxy is inside Docker but Blender is on the Windows Host
                BLENDER_HOST: 'host.docker.internal',
                BLENDER_PORT: '9876'
            }
        },
        // ── Builtin MCP Servers (disabled by default) ──
        {
            name: 'linear',
            enabled: false,
            source: 'builtin',
            description: 'Linear project management — issues, sprints, teams',
            command: 'npx',
            args: ['@opencontext-inc/mcp-linear'],
            auth: { type: 'oauth', provider: 'linear' },
            timeoutMs: 30000
        },
        {
            name: 'n8n',
            enabled: false,
            source: 'builtin',
            description: 'n8n workflow automation',
            command: 'npx',
            args: ['@n8n/n8n-mcp-server'],
            timeoutMs: 30000
        },
        {
            name: 'github',
            enabled: false,
            source: 'builtin',
            description: 'GitHub API integration — repos, PRs, issues, search',
            command: 'npx',
            args: ['@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
            timeoutMs: 30000
        },
        {
            name: 'brave-search',
            enabled: false,
            source: 'builtin',
            description: 'Web search using Brave Search API',
            command: 'npx',
            args: ['@modelcontextprotocol/server-brave-search'],
            env: { BRAVE_API_KEY: '${env:BRAVE_API_KEY}' },
            timeoutMs: 30000
        },
        {
            name: 'playwright',
            enabled: false,
            source: 'builtin',
            description: 'Browser automation via Playwright',
            command: 'npx',
            args: ['@playwright/mcp'],
            timeoutMs: 60000
        }
    ]
};
