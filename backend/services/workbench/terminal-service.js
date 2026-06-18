const path = require('path');
const { spawn } = require('child_process');

let pty;
try {
    pty = require('node-pty');
} catch (e) {
    console.warn('[Terminal] node-pty unavailable, falling back to stdio shells:', e.message);
    pty = null;
}

const sessions = new Map();
const pendingApprovals = new Map();
const BUFFER_LIMIT = 256 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultShell() {
    if (process.platform === 'win32') {
        return {
            command: 'powershell.exe',
            args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'],
            runArgs: command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        };
    }
    const command = process.env.SHELL || '/bin/sh';
    return {
        command,
        args: [],
        runArgs: text => command.endsWith('bash') || command.endsWith('zsh') ? ['-lc', text] : ['-c', text]
    };
}

function dangerousReason(command) {
    const text = String(command || '').trim();
    if (!text) return 'empty command';
    const lower = text.toLowerCase();
    const rules = [
        { re: /\brm\s+-[^&|;]*r[^&|;]*f\b/i, reason: 'recursive force delete' },
        { re: /\bremove-item\b[\s\S]*\b-recurse\b/i, reason: 'recursive PowerShell delete' },
        { re: /\b(del|erase|rd|rmdir)\b[\s\S]*(\/s|\/q)/i, reason: 'recursive Windows delete' },
        { re: /\b(git\s+reset\s+--hard|git\s+clean\s+-fd)/i, reason: 'destructive git reset/clean' },
        { re: /\b(curl|wget|invoke-webrequest|iwr)\b[\s\S]*\|\s*(bash|sh|powershell|pwsh)/i, reason: 'downloaded script execution' },
        { re: /\b(sudo|su|runas)\b/i, reason: 'privilege escalation' },
        { re: /\b(docker\s+(rm|rmi|volume\s+rm|system\s+prune|compose\s+down)|kubectl\s+delete)\b/i, reason: 'destructive infrastructure command' },
        { re: /\b(format|shutdown|reboot|restart-computer)\b/i, reason: 'host control command' },
        { re: /\b(npm|pnpm|yarn|pip|uv|apt-get|apt|choco|scoop)\s+(install|add|remove|uninstall|upgrade|update)\b/i, reason: 'dependency or package mutation' }
    ];
    const hit = rules.find(rule => rule.re.test(lower));
    return hit ? hit.reason : '';
}

function isDangerousCommand(command) {
    return Boolean(dangerousReason(command));
}

function appendBuffer(session, text) {
    session.buffer += text;
    if (session.buffer.length > BUFFER_LIMIT) {
        session.buffer = session.buffer.slice(session.buffer.length - BUFFER_LIMIT);
    }
    for (const ws of session.sockets) {
        try { ws.send(text); } catch (e) { /* socket closed */ }
    }
}

function summarizeSession(session) {
    return {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        command: session.command,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        bufferLength: session.buffer.length,
        approvedInteractive: session.approvedInteractive,
        cols: session.cols,
        rows: session.rows,
        pty: Boolean(session.pty)
    };
}

function createTerminalSession({ title = 'Terminal', cwd, command, args, approvedInteractive = true, cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
    const shell = defaultShell();
    const terminalId = id('term');
    const resolvedCwd = path.resolve(cwd || process.cwd());
    const env = { ...process.env, AUGUST_TERMINAL: '1', TERM: 'xterm-256color' };
    const resolvedCols = Math.max(20, Math.min(240, Number(cols) || DEFAULT_COLS));
    const resolvedRows = Math.max(5, Math.min(120, Number(rows) || DEFAULT_ROWS));
    const proc = pty
        ? pty.spawn(command || shell.command, args || shell.args, {
            name: 'xterm-256color',
            cwd: resolvedCwd,
            env,
            cols: resolvedCols,
            rows: resolvedRows,
            windowsHide: true
        })
        : spawn(command || shell.command, args || shell.args, {
            cwd: resolvedCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
    const session = {
        id: terminalId,
        title,
        cwd: resolvedCwd,
        command: command || shell.command,
        args: args || shell.args,
        status: 'running',
        process: proc,
        pty: Boolean(pty),
        buffer: '',
        sockets: new Set(),
        cols: resolvedCols,
        rows: resolvedRows,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvedInteractive: approvedInteractive === true
    };
    sessions.set(terminalId, session);

    if (pty) {
        proc.onData(chunk => appendBuffer(session, chunk));
        proc.onExit(({ exitCode }) => {
            session.status = 'exited';
            session.updatedAt = new Date().toISOString();
            appendBuffer(session, `\n[terminal exited with code ${exitCode}]\n`);
            closeSockets(session);
        });
    } else {
        proc.stdout.on('data', chunk => appendBuffer(session, chunk.toString()));
        proc.stderr.on('data', chunk => appendBuffer(session, chunk.toString()));
        proc.on('exit', code => {
            session.status = 'exited';
            session.updatedAt = new Date().toISOString();
            appendBuffer(session, `\n[terminal exited with code ${code}]\n`);
            closeSockets(session);
        });
    }

    return summarizeSession(session);
}

function closeSockets(session) {
    for (const ws of session.sockets) {
        try { ws.close(); } catch (e) {}
    }
    session.sockets.clear();
}

function listTerminalSessions() {
    return Array.from(sessions.values()).map(summarizeSession);
}

function getTerminalSession(terminalId) {
    return sessions.get(terminalId);
}

function readTerminalBuffer(terminalId) {
    const session = getTerminalSession(terminalId);
    if (!session) throw new Error(`Terminal session not found: ${terminalId}`);
    return { ...summarizeSession(session), buffer: session.buffer };
}

function writeTerminalInput(terminalId, input, { approved = false } = {}) {
    const session = getTerminalSession(terminalId);
    if (!session) throw new Error(`Terminal session not found: ${terminalId}`);
    if (!session.approvedInteractive && !approved) {
        const requestId = id('tap');
        pendingApprovals.set(requestId, {
            id: requestId,
            type: 'terminal_interactive_input',
            terminalId,
            inputPreview: String(input || '').slice(0, 200),
            createdAt: new Date().toISOString()
        });
        return { status: 'approval_required', requestId };
    }
    if (pty) {
        session.process.write(String(input || ''));
    } else if (session.process.stdin) {
        session.process.stdin.write(String(input || ''));
    }
    session.updatedAt = new Date().toISOString();
    return { status: 'written' };
}

function resizeTerminalSession(terminalId, cols, rows) {
    const session = getTerminalSession(terminalId);
    if (!session) throw new Error(`Terminal session not found: ${terminalId}`);
    session.cols = Math.max(20, Math.min(240, Number(cols) || session.cols || DEFAULT_COLS));
    session.rows = Math.max(5, Math.min(120, Number(rows) || session.rows || DEFAULT_ROWS));
    if (pty && typeof session.process.resize === 'function') {
        session.process.resize(session.cols, session.rows);
    }
    session.updatedAt = new Date().toISOString();
    return summarizeSession(session);
}

function runCommandProcess(command, { cwd, timeoutMs } = {}) {
    const shell = defaultShell();
    return new Promise(resolve => {
        let settled = false;
        let timedOut = false;
        const child = spawn(shell.command, shell.runArgs(command), {
            cwd: path.resolve(cwd || process.cwd()),
            env: { ...process.env, AUGUST_TERMINAL: '1' },
            windowsHide: true
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        const timeout = Number(timeoutMs) > 0 ? setTimeout(() => {
            timedOut = true;
            output += `\n[command timed out after ${Number(timeoutMs)}ms]\n`;
            try { child.kill(); } catch (e) {}
        }, Number(timeoutMs)) : null;
        child.on('error', error => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve({ exitCode: -1, output: error.message, timedOut });
        });
        child.on('exit', code => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve({ exitCode: timedOut ? -1 : (code ?? 0), output, timedOut });
        });
    });
}

async function submitTerminalCommand({ command, cwd, approved = false, reason = '', timeoutMs } = {}) {
    if (!command) throw new Error('command is required');
    const danger = dangerousReason(command);
    if (danger && !approved) {
        const requestId = id('tap');
        pendingApprovals.set(requestId, {
            id: requestId,
            type: 'terminal_command',
            command,
            cwd: cwd || process.cwd(),
            timeoutMs,
            reason: reason || danger,
            createdAt: new Date().toISOString()
        });
        return { status: 'approval_required', requestId, reason: danger };
    }
    const result = await runCommandProcess(command, { cwd, timeoutMs });
    return {
        status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'error',
        command,
        cwd: path.resolve(cwd || process.cwd()),
        exitCode: result.exitCode,
        output: result.output,
        timedOut: result.timedOut === true
    };
}

function listTerminalApprovals() {
    return Array.from(pendingApprovals.values());
}

async function approveTerminalRequest(requestId, { approve = true } = {}) {
    const request = pendingApprovals.get(requestId);
    if (!request) throw new Error(`Terminal approval not found: ${requestId}`);
    pendingApprovals.delete(requestId);
    if (!approve) return { status: 'rejected', requestId };
    if (request.type === 'terminal_command') {
        return submitTerminalCommand({ command: request.command, cwd: request.cwd, approved: true, timeoutMs: request.timeoutMs });
    }
    if (request.type === 'terminal_interactive_input') {
        const session = getTerminalSession(request.terminalId);
        if (!session) throw new Error(`Terminal session not found: ${request.terminalId}`);
        session.approvedInteractive = true;
        return { status: 'approved_interactive', terminalId: request.terminalId };
    }
    return { status: 'approved', requestId };
}

function closeTerminalSession(terminalId) {
    const session = getTerminalSession(terminalId);
    if (!session) return false;
    try {
        if (pty && typeof session.process.kill === 'function') {
            session.process.kill();
        } else {
            session.process.kill();
        }
    } catch (e) {}
    closeSockets(session);
    sessions.delete(terminalId);
    return true;
}

function handleTerminalConnection(ws, terminalId) {
    const session = getTerminalSession(terminalId);
    if (!session) {
        ws.close(4004, 'Terminal session not found');
        return;
    }
    session.sockets.add(ws);
    try { ws.send(session.buffer); } catch (e) { /* ignore */ }
    ws.on('message', (data) => {
        const message = data.toString();
        const result = writeTerminalInput(terminalId, message, { approved: session.approvedInteractive });
        if (result.status === 'approval_required') {
            try { ws.send(`\n[approval required: ${result.requestId}]\n`); } catch (e) { /* ignore */ }
        }
    });
    ws.on('close', () => session.sockets.delete(ws));
    ws.on('error', () => session.sockets.delete(ws));
}

module.exports = {
    approveTerminalRequest,
    closeTerminalSession,
    createTerminalSession,
    dangerousReason,
    handleTerminalConnection,
    isDangerousCommand,
    listTerminalApprovals,
    listTerminalSessions,
    readTerminalBuffer,
    resizeTerminalSession,
    submitTerminalCommand,
    writeTerminalInput
};
