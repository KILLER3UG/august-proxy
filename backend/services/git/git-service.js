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

const fs = require('fs');
const path = require('path');
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

function unquoteGitPath(rawPath) {
    const raw = String(rawPath || '').trim();
    if (!raw) return raw;
    if (raw.startsWith('"')) {
        try { return JSON.parse(raw); } catch (_) {}
    }
    if (raw.includes(' -> ')) {
        const parts = raw.split(' -> ');
        return unquoteGitPath(parts[parts.length - 1]);
    }
    return raw;
}

function parsePorcelainPath(line) {
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    return {
        status,
        path: unquoteGitPath(rawPath)
    };
}

function parseNumstatLine(line) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) return null;
    return {
        path: unquoteGitPath(match[3]),
        added: match[1] === '-' ? 0 : Number(match[1]),
        removed: match[2] === '-' ? 0 : Number(match[2])
    };
}

function parseDiffByPath(diff) {
    const byPath = new Map();
    const lines = String(diff || '').split('\n');
    let currentPath = null;
    let current = [];

    const flush = () => {
        if (currentPath && current.length > 0) {
            byPath.set(currentPath, current.join('\n').trimEnd());
        }
        currentPath = null;
        current = [];
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flush();
            const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
            if (match) {
                currentPath = unquoteGitPath(match[2]);
                current = [line];
            }
            continue;
        }
        if (currentPath) current.push(line);
    }
    flush();

    return byPath;
}

function buildUntrackedDiff(filePath, cwd) {
    const absolutePath = path.join(cwd, filePath);
    if (!fs.existsSync(absolutePath)) return '';
    const content = fs.readFileSync(absolutePath, 'utf8');
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);
    if (content.endsWith('\n') && lines[lines.length - 1] === '') lines.pop();
    const hunk = lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@` : '@@ -0,0 +0,0 @@';
    return [
        `diff --git a/${normalizedPath} b/${normalizedPath}`,
        'new file mode 100644',
        'index 0000000..0000000',
        '--- /dev/null',
        `+++ b/${normalizedPath}`,
        hunk,
        ...lines.map(line => `+${line}`)
    ].join('\n');
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

    const paths = porcelain.split('\n')
        .filter(Boolean)
        .map(parsePorcelainPath);

    let numstat = '';
    try {
        numstat = await run('git', ['diff', '--numstat', '--no-renames', 'HEAD'], cwd);
    } catch (_) {
        numstat = '';
    }
    const numByPath = new Map();
    numstat.split('\n').map(parseNumstatLine).filter(Boolean).forEach(item => {
        numByPath.set(item.path, { added: item.added, removed: item.removed });
    });

    let added = 0, removed = 0;
    const files = paths.map(({ status, path }) => {
        const ns = { ...(numByPath.get(path) || { added: 0, removed: 0 }) };
        // Untracked files have no HEAD diff, but they were added; set added=1
        if (status === '??' && ns.added === 0 && ns.removed === 0) ns.added = 1;
        added += ns.added;
        removed += ns.removed;
        return { path, status: status.trim(), added: ns.added, removed: ns.removed };
    });

    return { workspace: cwd, added, removed, files };
}

async function getDiff({ sessionId, workspace } = {}) {
    const cwd = workspace || resolveWorkspace(sessionId);
    const status = await getStatus({ sessionId, workspace: cwd });
    if (status.error && status.files.length === 0) {
        return { ...status, files: [] };
    }

    const paths = status.files.map(file => file.path);
    const diffByPath = new Map();
    if (paths.length > 0) {
        try {
            const trackedDiff = await run('git', ['diff', '--no-ext-diff', '--unified=80', '--no-renames', 'HEAD', '--', ...paths], cwd);
            parseDiffByPath(trackedDiff).forEach((diff, filePath) => diffByPath.set(filePath, diff));
        } catch (_) {
            // Diff is optional; the status counts are still useful.
        }
    }

    const files = status.files.map(file => ({
        ...file,
        diff: diffByPath.get(file.path) || (file.status === '??' ? buildUntrackedDiff(file.path, cwd) : '')
    }));

    return {
        workspace: cwd,
        added: status.added,
        removed: status.removed,
        files
    };
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
    getDiff,
    getCurrentBranch,
    listBranches,
    commit,
    checkout,
    resolveWorkspace,
};
