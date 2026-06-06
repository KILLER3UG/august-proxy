module.exports = {
    mcpServers: [
        {
            name: 'minimax',
            enabled: true,
            source: 'builtin',
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
        }
    ]
};
