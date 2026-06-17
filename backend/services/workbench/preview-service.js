const path = require('path');
const { spawn } = require('child_process');

const sessions = new Map();
const pendingApprovals = new Map();
const LOG_LIMIT = 256 * 1024;

function id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendLog(session, text) {
    const chunk = String(text || '');
    session.log += chunk;
    if (session.log.length > LOG_LIMIT) {
        session.log = session.log.slice(session.log.length - LOG_LIMIT);
    }
    session.updatedAt = new Date().toISOString();
}

function extractPreviewUrl(log) {
    const matches = String(log || '').match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s"'<>]*)?/gi) || [];
    const first = matches.find((url) => !url.includes('0.0.0.0')) || matches[0];
    if (!first) return null;
    return first.replace('0.0.0.0', 'localhost');
}

function summarizeSession(session) {
    const url = session.url || extractPreviewUrl(session.log);
    if (url && session.url !== url) {
        session.url = url;
    }
    return {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        command: session.command,
        status: session.status,
        url: session.url || null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        logLength: session.log.length,
    };
}

function createPreviewSession({ title = 'Preview', cwd, command, approved = false } = {}) {
    const dangerousReason = require('./terminal-service').dangerousReason;
    const danger = dangerousReason(command);
    if (danger && !approved) {
        const requestId = id('prev');
        pendingApprovals.set(requestId, {
            id: requestId,
            type: 'preview_command',
            command,
            cwd: cwd || process.cwd(),
            title,
            reason: danger,
            createdAt: new Date().toISOString(),
        });
        return { status: 'approval_required', requestId, reason: danger };
    }

    const previewId = id('preview');
    const resolvedCwd = path.resolve(cwd || process.cwd());
    const proc = spawn(command, {
        cwd: resolvedCwd,
        env: { ...process.env, AUGUST_PREVIEW: '1' },
        shell: true,
        windowsHide: true,
    });
    const session = {
        id: previewId,
        title,
        cwd: resolvedCwd,
        command,
        status: 'running',
        process: proc,
        log: '',
        url: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    sessions.set(previewId, session);

    proc.stdout.on('data', (chunk) => appendLog(session, chunk));
    proc.stderr.on('data', (chunk) => appendLog(session, chunk));
    proc.on('error', (error) => {
        session.status = 'error';
        appendLog(session, `\n[preview failed: ${error.message}]\n`);
    });
    proc.on('exit', (code) => {
        session.status = 'exited';
        appendLog(session, `\n[preview exited with code ${code}]\n`);
    });

    return summarizeSession(session);
}

function listPreviewSessions() {
    return {
        sessions: Array.from(sessions.values()).map(summarizeSession),
        approvals: Array.from(pendingApprovals.values()),
    };
}

function getPreviewSession(previewId) {
    const session = sessions.get(previewId);
    if (!session) throw new Error(`Preview session not found: ${previewId}`);
    return { ...summarizeSession(session), log: session.log };
}

function stopPreviewSession(previewId) {
    const session = sessions.get(previewId);
    if (!session) return false;
    try { session.process.kill(); } catch (e) {}
    sessions.delete(previewId);
    return true;
}

function approvePreviewRequest(requestId, { approve = true } = {}) {
    const request = pendingApprovals.get(requestId);
    if (!request) throw new Error(`Preview approval not found: ${requestId}`);
    pendingApprovals.delete(requestId);
    if (!approve) return { status: 'rejected', requestId };
    return createPreviewSession({
        title: request.title,
        cwd: request.cwd,
        command: request.command,
        approved: true,
    });
}

module.exports = {
    approvePreviewRequest,
    createPreviewSession,
    getPreviewSession,
    listPreviewSessions,
    stopPreviewSession,
};
