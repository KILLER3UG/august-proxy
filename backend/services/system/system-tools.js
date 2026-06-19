/**
 * Host system tools for August.
 *
 * Tool families:
 *   august__filesystem_{list,read,write,copy,move,delete}
 *   august__system_{exec,process,env,info,network}
 *
 * Confirmation flow (Review #5):
 *   Tools accept Workbench context { approvedMutation: true } as confirmation
 *   bypass. args.confirmed === true is a direct-tool fallback only.
 *   Mutating tools also flow through Workbench's MUTATING_WORKBENCH_TOOLS gate
 *   and the critical-action classifier (Task 1).
 *
 * Result shape:
 *   { ok, requiresApproval?, preview?, result?, auditId?, rollbackId?, error? }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { checkAugustPathPermission, checkCommandPermission } = require('../permissions/permission-profiles');
const { classifyCriticalAction } = require('../permissions/critical-actions');
const { appendAuditEntry } = require('../audit/audit-log');
const { recordRollback } = require('../rollback/rollback-store');
const { redactedFetch } = require('./network-tools');
const { registerOwned, unregisterOwned, isOwned } = require('./process-tools');

function toolDef(name, description, parameters, required) {
    return {
        type: 'function',
        function: { name, description, parameters }
    };
}

function getSystemToolDefinitions() {
    return [
        toolDef('august__filesystem_list', 'List files and folders in a directory under an allowed root.', {
            type: 'object',
            properties: { path: { type: 'string', description: 'Directory path.' } },
            required: ['path']
        }),
        toolDef('august__filesystem_read', 'Read a UTF-8 file from disk. Subject to path scope.', {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path.' } },
            required: ['path']
        }),
        toolDef('august__filesystem_write', 'Create or overwrite a file. Requires confirmation.', {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                content: { type: 'string', description: 'File content.' },
                confirmed: { type: 'boolean', description: 'Direct-tool fallback for confirmation.' }
            },
            required: ['path', 'content']
        }),
        toolDef('august__filesystem_copy', 'Copy a file. Requires confirmation.', {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Source file path.' },
                destination: { type: 'string', description: 'Destination file path.' },
                confirmed: { type: 'boolean' }
            },
            required: ['path', 'destination']
        }),
        toolDef('august__filesystem_move', 'Move a file. Requires confirmation.', {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Source file path.' },
                destination: { type: 'string', description: 'Destination file path.' },
                confirmed: { type: 'boolean' }
            },
            required: ['path', 'destination']
        }),
        toolDef('august__filesystem_delete', 'Delete a file. recursive=true on a folder is critical.', {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File or folder path.' },
                recursive: { type: 'boolean', description: 'Recursively delete folders.' },
                confirmed: { type: 'boolean' }
            },
            required: ['path']
        }),
        toolDef('august__system_exec', 'Execute a shell command. Requires confirmation. Path-bearing commands are subject to scope check.', {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command.' },
                cwd: { type: 'string', description: 'Working directory.' },
                shell: { type: 'string', enum: ['powershell', 'pwsh', 'bash', 'cmd'], description: 'Shell to use (default: powershell on Windows).' },
                timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
                confirmed: { type: 'boolean' }
            },
            required: ['command']
        }),
        toolDef('august__system_process', 'List, start, or stop processes. start/stop are mutating; stop on non-August PIDs is critical.', {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'start', 'stop'] },
                command: { type: 'string', description: 'Command for start.' },
                pid: { type: 'number', description: 'PID for stop.' },
                cwd: { type: 'string', description: 'Working directory.' },
                confirmed: { type: 'boolean' }
            },
            required: ['action']
        }),
        toolDef('august__system_env', 'Get, set, or delete environment variables. set/delete is critical.', {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['get', 'set', 'delete'] },
                name: { type: 'string', description: 'Variable name.' },
                value: { type: 'string', description: 'Variable value (set only).' },
                confirmed: { type: 'boolean' }
            },
            required: ['action', 'name']
        }),
        toolDef('august__system_info', 'Return OS, CPU, memory, disk, and uptime summary.', {
            type: 'object',
            properties: {},
            required: []
        }),
        toolDef('august__system_network', 'Make an HTTP request. Non-GET methods are mutating.', {
            type: 'object',
            properties: {
                url: { type: 'string' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                headers: { type: 'object' },
                body: { type: 'string' },
                timeoutMs: { type: 'number' },
                confirmed: { type: 'boolean' }
            },
            required: ['url']
        })
    ];
}

function isApproved(ctx, args) {
    if (ctx && ctx.approvedMutation === true) return true;
    if (args && args.confirmed === true) return true;
    return false;
}

function previewResult(args) {
    const preview = {};
    for (const [k, v] of Object.entries(args || {})) {
        if (k === 'confirmed' || k === 'approvedMutation') continue;
        if (typeof v === 'string' && v.length > 200) {
            preview[k] = v.slice(0, 200) + `... [${v.length - 200} more chars]`;
        } else {
            preview[k] = v;
        }
    }
    return preview;
}

function checkPathOrError(filePath) {
    const r = checkAugustPathPermission(filePath);
    if (!r.allowed) {
        return { ok: false, error: r.reason || 'Path not permitted.', scope: r.scope };
    }
    return null;
}

async function executeSystemTool(name, args = {}, ctx = {}) {
    const safeArgs = args || {};

    // Path scope check for any tool carrying a path
    if (safeArgs.path && typeof safeArgs.path === 'string') {
        const err = checkPathOrError(safeArgs.path);
        if (err) return err;
    }
    if (safeArgs.destination && typeof safeArgs.destination === 'string') {
        const err = checkPathOrError(safeArgs.destination);
        if (err) return err;
    }

    // ============ Filesystem ============
    if (name === 'august__filesystem_list') {
        const dir = path.resolve(String(safeArgs.path || process.cwd()));
        const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
            name: e.name,
            path: path.join(dir, e.name),
            type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other'
        }));
        return { ok: true, result: { path: dir, entries } };
    }

    if (name === 'august__filesystem_read') {
        const filePath = path.resolve(String(safeArgs.path));
        const content = fs.readFileSync(filePath, 'utf8');
        return { ok: true, result: { path: filePath, content } };
    }

    if (name === 'august__filesystem_write') {
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        const filePath = path.resolve(String(safeArgs.path));
        const content = String(safeArgs.content || '');
        const existed = fs.existsSync(filePath);
        const beforeContent = existed ? fs.readFileSync(filePath, 'utf8') : null;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');

        const rb = recordRollback({
            type: existed ? 'restore_file' : 'delete_created_file',
            target: filePath,
            before: existed ? { content: beforeContent } : null,
            after: { content }
        });
        const audit = appendAuditEntry({
            action: 'filesystem.write',
            target: filePath,
            category: 'system',
            mode: ctx.guardMode,
            approved: ctx.approvedMutation === true,
            approvalToken: ctx.approvalToken || null,
            critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
            inputSummary: { path: filePath, bytes: Buffer.byteLength(content, 'utf8') },
            rollbackId: rb.id,
            result: 'ok'
        });
        return { ok: true, result: { path: filePath }, auditId: audit.id, rollbackId: rb.id };
    }

    if (name === 'august__filesystem_copy') {
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        const src = path.resolve(String(safeArgs.path));
        const dest = path.resolve(String(safeArgs.destination));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);

        const rb = recordRollback({
            type: 'delete_created_file',
            target: dest,
            before: null,
            after: { copiedFrom: src }
        });
        const audit = appendAuditEntry({
            action: 'filesystem.copy',
            target: dest,
            category: 'system',
            critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
            inputSummary: { source: src, destination: dest },
            rollbackId: rb.id,
            result: 'ok'
        });
        return { ok: true, result: { source: src, destination: dest }, auditId: audit.id, rollbackId: rb.id };
    }

    if (name === 'august__filesystem_move') {
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        const src = path.resolve(String(safeArgs.path));
        const dest = path.resolve(String(safeArgs.destination));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const existed = fs.existsSync(src);
        const beforeContent = existed && fs.statSync(src).isFile() ? fs.readFileSync(src, 'utf8') : null;
        fs.renameSync(src, dest);

        const rb = recordRollback({
            type: 'restore_file',
            target: src,
            before: existed ? { content: beforeContent } : null,
            after: { movedTo: dest }
        });
        const audit = appendAuditEntry({
            action: 'filesystem.move',
            target: dest,
            category: 'system',
            critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
            inputSummary: { source: src, destination: dest },
            rollbackId: rb.id,
            result: 'ok'
        });
        return { ok: true, result: { source: src, destination: dest }, auditId: audit.id, rollbackId: rb.id };
    }

    if (name === 'august__filesystem_delete') {
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        const target = path.resolve(String(safeArgs.path));
        const existed = fs.existsSync(target);
        const beforeContent = existed && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
        if (existed) {
            if (fs.statSync(target).isDirectory()) {
                fs.rmSync(target, { recursive: !!safeArgs.recursive, force: true });
            } else {
                fs.rmSync(target, { force: true });
            }
        }
        const rb = recordRollback({
            type: existed ? 'restore_file' : 'delete_created_file',
            target,
            before: existed ? { content: beforeContent } : null,
            after: null
        });
        const audit = appendAuditEntry({
            action: 'filesystem.delete',
            target,
            category: 'system',
            critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
            inputSummary: { path: target, recursive: !!safeArgs.recursive },
            rollbackId: rb.id,
            result: 'ok'
        });
        return { ok: true, result: { path: target }, auditId: audit.id, rollbackId: rb.id };
    }

    // ============ System ============
    if (name === 'august__system_exec') {
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        const cmd = String(safeArgs.command || '');
        const cmdCheck = checkCommandPermission(cmd);
        if (!cmdCheck.allowed) {
            appendAuditEntry({
                action: 'system.exec.blocked',
                target: cmd.slice(0, 200),
                category: 'system',
                critical: true,
                inputSummary: { command: cmd, blockedPaths: cmdCheck.blockedPaths, reason: cmdCheck.reason },
                result: 'blocked'
            });
            return { ok: false, error: cmdCheck.reason, blockedPaths: cmdCheck.blockedPaths };
        }
        const isWin = process.platform === 'win32';
        const shell = safeArgs.shell || (isWin ? 'powershell' : 'bash');
        const timeoutMs = Number(safeArgs.timeoutMs) || 30000;
        const execResult = await new Promise((resolve) => {
            cp.exec(cmd, {
                cwd: safeArgs.cwd || process.cwd(),
                shell,
                timeout: timeoutMs,
                maxBuffer: 4 * 1024 * 1024
            }, (err, stdout, stderr) => {
                resolve({
                    exitCode: err ? (err.code || 1) : 0,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                    error: err && err.killed ? 'timeout' : (err ? String(err.message || err) : null)
                });
            });
        });
        const audit = appendAuditEntry({
            action: 'system.exec',
            target: cmd.slice(0, 200),
            category: 'system',
            critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
            approved: ctx.approvedMutation === true,
            approvalToken: ctx.approvalToken || null,
            inputSummary: { command: cmd, shell, timeoutMs, cwd: safeArgs.cwd },
            afterSummary: { exitCode: execResult.exitCode, stdoutBytes: execResult.stdout.length, stderrBytes: execResult.stderr.length },
            result: execResult.error ? 'error' : 'ok',
            error: execResult.error
        });
        return { ok: !execResult.error, result: execResult, auditId: audit.id };
    }

    if (name === 'august__system_process') {
        const action = safeArgs.action;
        if (action === 'list') {
            return { ok: true, result: { processes: await listProcesses() } };
        }
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        if (action === 'start') {
            const cmd = String(safeArgs.command || '');
            if (!cmd) return { ok: false, error: 'command is required for action=start' };
            const child = cp.spawn(cmd, {
                cwd: safeArgs.cwd || process.cwd(),
                shell: true,
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            registerOwned(child.pid);
            const audit = appendAuditEntry({
                action: 'system.process.start',
                target: String(child.pid),
                category: 'system',
                critical: classifyCriticalAction({ toolName: name, args: safeArgs }).critical,
                inputSummary: { command: cmd, pid: child.pid },
                result: 'ok'
            });
            return { ok: true, result: { pid: child.pid }, auditId: audit.id };
        }
        if (action === 'stop') {
            const pid = Number(safeArgs.pid);
            if (!Number.isInteger(pid) || pid <= 0) {
                return { ok: false, error: 'pid is required for action=stop' };
            }
            // If not August-owned AND not explicitly marked ownedByAugust, refuse.
            const ownedByAugust = safeArgs.ownedByAugust === true || isOwned(pid);
            if (!ownedByAugust) {
                // Critical: refuse without explicit approval context.
                if (!isApproved(ctx, safeArgs)) {
                    return { ok: false, requiresApproval: true, preview: { pid, ownedByAugust: false }, critical: true };
                }
            }
            const isWin = process.platform === 'win32';
            try {
                if (isWin) {
                    cp.execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', shell: 'cmd' });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
                unregisterOwned(pid);
                const audit = appendAuditEntry({
                    action: 'system.process.stop',
                    target: String(pid),
                    category: 'system',
                    critical: true,
                    inputSummary: { pid, ownedByAugust },
                    result: 'ok'
                });
                return { ok: true, result: { pid, stopped: true }, auditId: audit.id };
            } catch (err) {
                const audit = appendAuditEntry({
                    action: 'system.process.stop',
                    target: String(pid),
                    category: 'system',
                    critical: true,
                    inputSummary: { pid },
                    result: 'error',
                    error: String(err && err.message || err)
                });
                return { ok: false, error: String(err && err.message || err), auditId: audit.id };
            }
        }
        return { ok: false, error: `Unsupported action: ${action}` };
    }

    if (name === 'august__system_env') {
        const action = safeArgs.action;
        if (action === 'get') {
            const name = String(safeArgs.name || '');
            return { ok: true, result: { name, value: process.env[name] ?? null } };
        }
        // set/delete are critical — locked decision 2.
        if (!isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs), critical: true };
        }
        if (action === 'set') {
            const name = String(safeArgs.name || '');
            const value = String(safeArgs.value || '');
            const before = process.env[name];
            process.env[name] = value;
            const audit = appendAuditEntry({
                action: 'system.env.set',
                target: name,
                category: 'system',
                critical: true,
                inputSummary: { name, valueLength: value.length },
                beforeSummary: before === undefined ? null : { value: before },
                afterSummary: { value },
                result: 'ok'
            });
            return { ok: true, result: { name, value }, auditId: audit.id };
        }
        if (action === 'delete') {
            const name = String(safeArgs.name || '');
            const before = process.env[name];
            delete process.env[name];
            const audit = appendAuditEntry({
                action: 'system.env.delete',
                target: name,
                category: 'system',
                critical: true,
                inputSummary: { name },
                beforeSummary: before === undefined ? null : { value: before },
                result: 'ok'
            });
            return { ok: true, result: { name, deleted: true }, auditId: audit.id };
        }
        return { ok: false, error: `Unsupported action: ${action}` };
    }

    if (name === 'august__system_info') {
        const info = {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            cpus: os.cpus().length,
            totalmem: os.totalmem(),
            freemem: os.freemem(),
            uptime: os.uptime(),
            loadavg: os.loadavg(),
            tmpdir: os.tmpdir(),
            cwd: process.cwd(),
            nodeVersion: process.version
        };
        return { ok: true, result: info };
    }

    if (name === 'august__system_network') {
        const method = (safeArgs.method || 'GET').toUpperCase();
        const isMutating = method !== 'GET';
        if (isMutating && !isApproved(ctx, safeArgs)) {
            return { ok: false, requiresApproval: true, preview: previewResult(safeArgs) };
        }
        try {
            const r = await redactedFetch(safeArgs.url, {
                method,
                headers: safeArgs.headers,
                body: safeArgs.body,
                timeoutMs: safeArgs.timeoutMs
            });
            const audit = appendAuditEntry({
                action: 'system.network',
                target: safeArgs.url,
                category: 'system',
                critical: isMutating,
                inputSummary: { url: safeArgs.url, method, headerKeys: Object.keys(safeArgs.headers || {}) },
                afterSummary: { status: r.status, ok: r.ok, truncated: r.truncated, bodyBytes: r.body.length },
                result: r.ok ? 'ok' : 'error',
                error: r.ok ? null : `${r.status} ${r.statusText}`
            });
            return { ok: r.ok, result: r, auditId: audit.id };
        } catch (err) {
            const audit = appendAuditEntry({
                action: 'system.network',
                target: safeArgs.url,
                category: 'system',
                critical: isMutating,
                inputSummary: { url: safeArgs.url, method },
                result: 'error',
                error: String(err && err.message || err)
            });
            return { ok: false, error: String(err && err.message || err), auditId: audit.id };
        }
    }

    throw new Error(`Unsupported system tool: ${name}`);
}

async function listProcesses() {
    const isWin = process.platform === 'win32';
    return new Promise((resolve) => {
        try {
            if (isWin) {
                const out = cp.execSync('tasklist /FO CSV /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
                const rows = out.split(/\r?\n/).filter(Boolean).map(line => {
                    const m = line.match(/^"([^"]+)","(\d+)"/);
                    return m ? { name: m[1], pid: Number(m[2]) } : null;
                }).filter(Boolean);
                resolve(rows);
            } else {
                const out = cp.execSync('ps -eo pid,comm', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
                const rows = out.split(/\r?\n/).slice(1).filter(Boolean).map(line => {
                    const [pid, ...rest] = line.trim().split(/\s+/);
                    return { pid: Number(pid), name: rest.join(' ') };
                }).filter(r => Number.isInteger(r.pid));
                resolve(rows);
            }
        } catch (_) {
            resolve([]);
        }
    });
}

module.exports = {
    getSystemToolDefinitions,
    executeSystemTool,
    // exported for tests
    _internals: { isApproved, previewResult }
};
