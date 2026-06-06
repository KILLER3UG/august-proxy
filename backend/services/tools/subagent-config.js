const fs = require('fs');
const path = require('path');

const SUBAGENT_CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_subagent_config.json');

function getDefaultSubagentConfig() {
    return {
        current: {
            name: 'default',
            system_prompt: 'You are a focused sub-agent spawned by August. You have access to MCP servers, web search/fetch, and file operations. Complete the assigned task efficiently using these tools. Report your findings clearly.',
            max_loops: 5,
            score: { completion_rate: 0, avg_loops: 0, total_runs: 0, error_rate: 0 },
            source: 'built-in',
            created: new Date().toISOString()
        },
        history: [],
        observed_patterns: [],
        metadata: {
            last_learning_at: null,
            total_learnings: 0,
            total_spawns: 0,
            total_successes: 0
        }
    };
}

function loadSubagentConfig() {
    if (!fs.existsSync(SUBAGENT_CONFIG_FILE)) {
        const def = getDefaultSubagentConfig();
        fs.writeFileSync(SUBAGENT_CONFIG_FILE, JSON.stringify(def, null, 2));
        return def;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(SUBAGENT_CONFIG_FILE, 'utf8'));
        const def = getDefaultSubagentConfig();
        return { ...def, ...raw, current: { ...def.current, ...(raw.current || {}) }, metadata: { ...def.metadata, ...(raw.metadata || {}) } };
    } catch (e) {
        return getDefaultSubagentConfig();
    }
}

function saveSubagentConfig(config) {
    fs.writeFileSync(SUBAGENT_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function subagentConfigToContextBlock() {
    const cfg = loadSubagentConfig();
    const cur = cfg.current;
    const hist = cfg.history;
    const patterns = cfg.observed_patterns;
    return `[August Sub-agent System]
Current strategy: "${cur.name}" (source: ${cur.source}, created: ${cur.created})
Score: completion_rate=${(cur.score.completion_rate * 100).toFixed(0)}%, avg_loops=${cur.score.avg_loops.toFixed(1)}, error_rate=${(cur.score.error_rate * 100).toFixed(0)}%
Total spawns: ${cfg.metadata.total_spawns} | Successes: ${cfg.metadata.total_successes} | Learnings: ${cfg.metadata.total_learnings}
Archived strategies: ${hist.length} | Observed client patterns: ${patterns.length}

You can improve your sub-agent by calling august__learn_subagent to scan all clients passing through the proxy, discover better patterns, and upgrade your strategy.`;
}

module.exports = {
    SUBAGENT_CONFIG_FILE,
    getDefaultSubagentConfig,
    loadSubagentConfig,
    saveSubagentConfig,
    subagentConfigToContextBlock
};
