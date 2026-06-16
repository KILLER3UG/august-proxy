/* ── git-service ─ workspace-scoped git operations ────────────────── */
/* All operations use `child_process.execFile('git', …)` with a 5-second */
/* timeout. Workspace resolution: from a session id, we look up the     */
/* session's `cwd` (set when the session was created); for ad-hoc        */
/* callers the workspace can be passed in the request body / query.       */
/*                                                                       */
/* Endpoints (see git-routes.js):                                        */
/*   • GET  /api/git/status?sessionId=…                                  */
/*   • GET  /api/git/branch?sessionId=…                                  */
/*   • GET  /api/git/branches?sessionId=…                                */
/*   • POST /api/git/commit       { sessionId, message }                 */
/*   • POST /api/git/checkout    { sessionId, branch }                   */

const { execFile } = require('child_process');
const { getSession } = require('../storage/session-store');

const TIMEOUT_MS = 5000;

function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const code = (err && err.code) || 1;
                return reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr || err.message}`));
            }
            resolve(String(stdout || '').trimEnd());
        });
        child.on('error', (e) => reject(e));
    });
}

/** Resolve a session id to a workspace path; returns process.cwd() as fallback. */
function resolveWorkspace(sessionId) {
    if (sessionId) {
        try {
            const s = getSession(sessionId);
            if (s && s.cwd) return s.cwd;
        } catch (_) { /* ignore */ }
    }
    return process.cwd();
}

/** `git status --porcelain --short` parsed into per-file stats via `git diff --numstat`. */
async function getStatus({ sessionId, workspace } = {}) {
    const cwd = workspace || resolveWorkspace(sessionId);
    let porcelain = '';
    try {
        porcelain = await run('git', ['status', '--porcelain', '--short', '--untracked-files=all'], cwd);
    } catch (err) {
        // Not a git repo, or no git available — return an empty status
        return { workspace: cwd, added: 0, removed: 0, files: [], error: err.message };
    }
    if (!porcelain) {
        return { workspace: cwd, added: 0, removed: 0, files: [] };
    }
    // Parse "XY path" lines (XY = status code, e.g. " M", "A ", "??", "UU")
    const paths = porcelain.split('\n').map(line => {
        if (!line) return null;
        // First two chars are the status; the rest is the path. For renames the
        // format is "R  old -> new" — keep just the new path.
        const status = line.slice(0, 2);
        let path = line.slice(3);
        if (path.includes(' -> ')) path = path.split(' -> ')[1];
        return { status, path };
    }).filter(Boolean);

    let numstat = '';
    try {
        numstat = await run('git', ['diff', '--numstat', '--no-renames', 'HEAD'], cwd);
    } catch (_) {
        numstat = '';
    }
    const numByPath = new Map();
    numstat.split('\n').forEach(line => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (m) numByPath.set(m[3], { added: +m[1] || 0, removed: +m[2] || 0 });
    });

    let added = 0, removed = 0;
    const files = paths.map(({ status, path }) => {
        const ns = numByPath.get(path) || { added: 0, removed: 0 };
        // Untracked files have no HEAD diff, but they were added; set added=1
        if (status === '??' && ns.added === 0 && ns.removed === 0) ns.added = 1;
        added += ns.added;
        removed += ns.removed;
        return { path, status: status.trim(), added: ns.added, removed: ns.removed };
    });

    return { workspace: cwd, added, removed, files };
}

async function getCurrentBranch({ sessionId, workspace } = {}) {
    const cwd = workspace || resolveWorkspace(sessionId);
    try {
        const out = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        return { workspace: cwd, current: out || 'HEAD' };
    } catch (err) {
        return { workspace: cwd, current: null, error: err.message };
    }
}

async function listBranches({ sessionId, workspace } = {}) {
    const cwd = workspace || resolveWorkspace(sessionId);
    try {
        // `--format=%(HEAD)|%(refname:short)` puts an asterisk on the current branch
        const out = await run('git', ['for-each-ref', '--format=%(HEAD)|%(refname:short)', 'refs/heads'], cwd);
        const branches = out.split('\n').filter(Boolean).map(line => {
            const [head, name] = line.split('|');
            return { name, current: head.trim() === '*' };
        });
        return { workspace: cwd, branches };
    } catch (err) {
        return { workspace: cwd, branches: [], error: err.message };
    }
}

async function commit({ sessionId, workspace, message }) {
    const cwd = workspace || resolveWorkspace(sessionId);
    if (!message || !String(message).trim()) throw new Error('commit message is required');
    try {
        // Stage everything (new + modified + deleted) and commit
        await run('git', ['add', '-A'], cwd);
        // Use --no-verify to skip pre-commit hooks that may block.
        const out = await run('git', ['commit', '--no-verify', '-m', message], cwd);
        const sha = await run('git', ['rev-parse', 'HEAD'], cwd);
        return { workspace: cwd, sha, output: out };
    } catch (err) {
        throw new Error(`commit failed: ${err.message}`);
    }
}

async function checkout({ sessionId, workspace, branch }) {
    const cwd = workspace || resolveWorkspace(sessionId);
    if (!branch) throw new Error('branch is required');
    try {
        const out = await run('git', ['checkout', branch], cwd);
        return { workspace: cwd, branch, output: out };
    } catch (err) {
        throw new Error(`checkout failed: ${err.message}`);
    }
}

module.exports = {
    getStatus,
    getCurrentBranch,
    listBranches,
    commit,
    checkout,
    resolveWorkspace,
};
