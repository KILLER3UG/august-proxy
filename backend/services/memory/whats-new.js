/**
 * whats-new.js — Feature awareness system.
 *
 * Tells the model what changed in the proxy codebase recently.
 * Two data sources:
 *   1. Git log — scans the last 24h of commits for file paths and messages
 *   2. Feature manifest — `~/.august/features.json` for manually curated entries
 *
 * The result is auto-injected into the volatile tier (tier3) of the system prompt
 * so the model always knows about recent capabilities without needing to call a tool.
 * A companion tool (august__whats_new) provides full detail on demand.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FEATURES_FILE = path.join(os.homedir(), '.august', 'features.json');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ── Git-based change detection ──

function getRecentGitChanges() {
    try {
        const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
        const log = execSync(
            `git log --since="${since}" --oneline --no-decorate --format="%h %s" -- "*.js" "*.ts" "*.tsx" "*.json" "*.yaml" "*.md"`,
            { cwd: __dirname, timeout: 10000, encoding: 'utf-8' }
        ).trim();
        if (!log) return [];

        return log.split('\n')
            .filter(Boolean)
            .map(line => {
                const match = line.match(/^(\w+)\s+(.*)/);
                return match ? { hash: match[1], message: match[2] } : null;
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function getChangedFilesInLast24h() {
    try {
        const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
        const files = execSync(
            `git diff --name-only HEAD --since="${since}"`,
            { cwd: __dirname, timeout: 10000, encoding: 'utf-8' }
        ).trim();
        return files ? files.split('\n').filter(Boolean) : [];
    } catch {
        return [];
    }
}

// ── Feature manifest (manually curated) ──

function readFeatureManifest() {
    if (!fs.existsSync(FEATURES_FILE)) return [];
    try {
        const raw = fs.readFileSync(FEATURES_FILE, 'utf-8');
        const entries = JSON.parse(raw);
        return Array.isArray(entries) ? entries : [];
    } catch {
        return [];
    }
}

function writeFeatureManifest(entries) {
    const dir = path.dirname(FEATURES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FEATURES_FILE, JSON.stringify(entries, null, 2));
}

/**
 * Register a new feature in the manifest.
 * Called from index.js after each phase implementation completes,
 * or manually via the august__whats_new tool.
 */
function registerFeature({ name, description, category, commit }) {
    const entries = readFeatureManifest();
    // Deduplicate by name
    const existing = entries.findIndex(e => e.name === name);
    const entry = {
        name,
        description,
        category: category || 'uncategorized',
        commit: commit || '',
        timestamp: new Date().toISOString()
    };
    if (existing >= 0) {
        entries[existing] = entry;
    } else {
        entries.push(entry);
    }
    writeFeatureManifest(entries);
    return entry;
}

// ── Summary builder ──

/**
 * Build a compact "what's new" summary for injection into the system prompt.
 * Called every turn when building tier3 (volatile).
 */
function buildWhatsNewSummary() {
    const parts = [];

    // Git changes
    const commits = getRecentGitChanges();
    if (commits.length > 0) {
        parts.push(`<commits count="${commits.length}">`);
        for (const c of commits.slice(0, 8)) {
            parts.push(`  - ${c.hash} ${c.message}`);
        }
        if (commits.length > 8) {
            parts.push(`  - ... and ${commits.length - 8} more`);
        }
        parts.push('</commits>');
    }

    // Feature manifest entries from the last 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentFeatures = readFeatureManifest()
        .filter(e => new Date(e.timestamp).getTime() > weekAgo)
        .slice(0, 10);

    if (recentFeatures.length > 0) {
        parts.push(`<features count="${recentFeatures.length}">`);
        for (const f of recentFeatures) {
            const age = Math.round((Date.now() - new Date(f.timestamp).getTime()) / 3600000);
            parts.push(`  - ${f.name}: ${f.description} (${age}h ago)`);
        }
        parts.push('</features>');
    }

    if (parts.length === 0) return '';

    return `<whats_new>\n${parts.join('\n')}\n</whats_new>`;
}

/**
 * Full detail report for the tool.
 */
function buildWhatsNewReport() {
    const lines = [];

    // Feature manifest
    const features = readFeatureManifest();
    const recent = features.filter(e =>
        new Date(e.timestamp).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000
    );
    if (recent.length > 0) {
        lines.push('## Recently Registered Features');
        for (const f of recent) {
            lines.push(`- **${f.name}** (${f.category})`);
            lines.push(`  ${f.description}`);
            lines.push(`  Registered: ${new Date(f.timestamp).toLocaleString()}`);
            if (f.commit) lines.push(`  Commit: ${f.commit}`);
        }
    } else {
        lines.push('## Recently Registered Features\n- None');
    }

    // Git changes
    const commits = getRecentGitChanges();
    const files = getChangedFilesInLast24h();
    if (commits.length > 0) {
        lines.push('\n## Last 24h Commits');
        for (const c of commits) {
            lines.push(`- ${c.hash} ${c.message}`);
        }
    } else {
        lines.push('\n## Last 24h Commits\n- None');
    }

    if (files.length > 0) {
        lines.push('\n## Files Changed (last 24h)');
        for (const f of files.slice(0, 30)) {
            lines.push(`- ${f}`);
        }
        if (files.length > 30) {
            lines.push(`- ... and ${files.length - 30} more`);
        }
    }

    return lines.join('\n');
}

module.exports = {
    buildWhatsNewSummary,
    buildWhatsNewReport,
    getRecentGitChanges,
    getChangedFilesInLast24h,
    readFeatureManifest,
    registerFeature
};
