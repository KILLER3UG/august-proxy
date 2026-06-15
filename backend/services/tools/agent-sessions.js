const fs = require('fs');
const path = require('path');
const terminal = require('../workbench/terminal-service');
const { dataPath } = require('../../lib/data-paths');

const AGENT_SESSIONS_FILE = dataPath('august_agent_sessions.json');
const VALID_STATUSES = new Set(['idle', 'running', 'blocked', 'completed', 'cancelled', 'failed']);
const VALID_TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
const MAX_EVENTS = 200;

function nowIso() {
    return new Date().toISOString();
}

function id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStore() {
    return { sessions: [], events: [] };
}

function readStore() {
    if (!fs.existsSync(AGENT_SESSIONS_FILE)) {
        const store = defaultStore();
        writeStore(store);
        return store;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(AGENT_SESSIONS_FILE, 'utf8'));
        return {
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSession) : [],
            events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : []
        };
    } catch (e) {
        return defaultStore();
    }
}

function writeStore(store) {
    fs.writeFileSync(AGENT_SESSIONS_FILE, JSON.stringify({
        sessions: Array.isArray(store.sessions) ? store.sessions.map(normalizeSession) : [],
        events: Array.isArray(store.events) ? store.events.slice(-MAX_EVENTS) : []
    }, null, 2));
}

function appendEvent(store, sessionId, type, detail = {}) {
    store.events.push({
        id: id('evt'),
        sessionId,
        type,
        detail,
        createdAt: nowIso()
    });
    if (store.events.length > MAX_EVENTS) store.events = store.events.slice(-MAX_EVENTS);
}

function normalizeStatus(status, fallback = 'idle') {
    const value = String(status || '').trim().toLowerCase();
    return VALID_STATUSES.has(value) ? value : fallback;
}

function normalizeTodoStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    return VALID_TODO_STATUSES.has(value) ? value : 'pending';
}

function normalizeTodo(item = {}) {
    const todoId = String(item.id || '').trim() || id('todo');
    const content = String(item.content || item.title || '').trim() || '(no description)';
    return {
        id: todoId,
        content,
        status: normalizeTodoStatus(item.status)
    };
}

function dedupeTodos(todos = []) {
    const lastIndex = new Map();
    todos.forEach((item, index) => {
        const todoId = String(item?.id || '').trim() || '?';
        lastIndex.set(todoId, index);
    });
    return Array.from(lastIndex.values()).sort((a, b) => a - b).map(index => todos[index]);
}

function summarizeTodos(todos = []) {
    const summary = {
        total: todos.length,
        pending: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0
    };
    for (const item of todos) {
        if (summary[item.status] !== undefined) summary[item.status] += 1;
    }
    return summary;
}

function normalizeRequest(item = {}, type = 'permission') {
    const createdAt = item.createdAt || nowIso();
    const status = ['pending', 'approved', 'rejected', 'answered'].includes(item.status) ? item.status : 'pending';
    const request = {
        id: item.id || id(type === 'question' ? 'qreq' : 'preq'),
        type,
        status,
        createdAt,
        updatedAt: item.updatedAt || createdAt
    };
    if (type === 'permission') {
        request.tool = String(item.tool || item.permission || '').trim() || 'tool';
        request.reason = String(item.reason || '').trim();
        request.payload = item.payload || {};
        request.response = item.response || null;
    } else {
        request.question = String(item.question || '').trim() || 'Question';
        request.choices = Array.isArray(item.choices) ? item.choices : [];
        request.answer = item.answer || null;
    }
    return request;
}

function normalizeSession(session = {}) {
    const createdAt = session.createdAt || nowIso();
    const todos = Array.isArray(session.todos) ? session.todos.map(normalizeTodo) : [];
    return {
        id: session.id || id('sess'),
        title: session.title || session.task || 'August session',
        agent: session.agent || 'build',
        parentId: session.parentId || session.parentID || null,
        cwd: path.resolve(session.cwd || process.cwd()),
        task: session.task || '',
        status: normalizeStatus(session.status),
        createdAt,
        updatedAt: session.updatedAt || createdAt,
        todos,
        todoSummary: summarizeTodos(todos),
        permissions: Array.isArray(session.permissions) ? session.permissions.map(item => normalizeRequest(item, 'permission')) : [],
        questions: Array.isArray(session.questions) ? session.questions.map(item => normalizeRequest(item, 'question')) : [],
        messages: Array.isArray(session.messages) ? session.messages.slice(-50) : [],
        pendingFollowup: session.pendingFollowup || null,
        lastRun: session.lastRun || null,
        output: String(session.output || '').slice(-65536)
    };
}

function publicSession(session) {
    const normalized = normalizeSession(session);
    return {
        ...normalized,
        blocked: normalized.permissions.some(item => item.status === 'pending') || normalized.questions.some(item => item.status === 'pending'),
        todoDock: todoState(normalized)
    };
}

function findSessionIndex(store, sessionId) {
    return store.sessions.findIndex(item => item.id === sessionId);
}

function getSessionFromStore(store, sessionId) {
    const session = store.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    return session;
}

function listAgentSessions() {
    const store = readStore();
    return {
        sessions: store.sessions.map(publicSession),
        events: store.events.slice(-50),
        counts: {
            total: store.sessions.length,
            running: store.sessions.filter(item => item.status === 'running').length,
            blocked: store.sessions.filter(item => publicSession(item).blocked).length
        }
    };
}

function getAgentSession(sessionId) {
    const store = readStore();
    return {
        session: publicSession(getSessionFromStore(store, sessionId)),
        tree: sessionTree(store, sessionId),
        events: store.events.filter(item => item.sessionId === sessionId).slice(-50)
    };
}

function createAgentSession(input = {}) {
    const store = readStore();
    if (input.parentId) getSessionFromStore(store, input.parentId);
    const session = normalizeSession({
        id: input.id,
        title: input.title,
        agent: input.agent,
        parentId: input.parentId || null,
        cwd: input.cwd,
        task: input.task,
        status: 'idle'
    });
    store.sessions.unshift(session);
    appendEvent(store, session.id, 'created', { agent: session.agent, parentId: session.parentId });
    writeStore(store);
    return publicSession(session);
}

function updateAgentSession(sessionId, patch = {}) {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const current = store.sessions[index];
    const next = normalizeSession({
        ...current,
        ...patch,
        id: current.id,
        parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
        status: patch.status ? normalizeStatus(patch.status, current.status) : current.status,
        updatedAt: nowIso()
    });
    store.sessions[index] = next;
    appendEvent(store, sessionId, 'updated', { status: next.status });
    writeStore(store);
    return publicSession(next);
}

function writeTodos(sessionId, todos = [], { merge = false } = {}) {
    if (!Array.isArray(todos)) throw new Error('todos must be an array');
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    const incoming = dedupeTodos(todos).map(normalizeTodo);
    let nextTodos;
    if (!merge) {
        nextTodos = incoming;
    } else {
        const byId = new Map(session.todos.map(item => [item.id, { ...item }]));
        for (const item of incoming) {
            byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
        }
        const seen = new Set();
        nextTodos = [];
        for (const existing of session.todos) {
            const current = byId.get(existing.id);
            if (!current || seen.has(existing.id)) continue;
            nextTodos.push(normalizeTodo(current));
            seen.add(existing.id);
        }
        for (const item of incoming) {
            if (seen.has(item.id)) continue;
            nextTodos.push(item);
            seen.add(item.id);
        }
    }
    session.todos = nextTodos;
    session.todoSummary = summarizeTodos(nextTodos);
    session.updatedAt = nowIso();
    store.sessions[index] = normalizeSession(session);
    appendEvent(store, sessionId, 'todos_written', { merge, summary: session.todoSummary });
    writeStore(store);
    return { todos: nextTodos, summary: session.todoSummary, state: todoState(session), session: publicSession(session) };
}

function todoState(sessionOrId) {
    const session = typeof sessionOrId === 'string' ? getAgentSession(sessionOrId).session : normalizeSession(sessionOrId);
    const todos = Array.isArray(session.todos) ? session.todos : [];
    const count = todos.length;
    if (count === 0) return 'hide';
    const done = todos.every(item => item.status === 'completed' || item.status === 'cancelled');
    const blocked = (session.permissions || []).some(item => item.status === 'pending') || (session.questions || []).some(item => item.status === 'pending');
    const live = session.status === 'running' || session.status === 'blocked' || blocked;
    if (!live) return 'clear';
    if (!done) return 'open';
    return 'close';
}

function addPermissionRequest(sessionId, input = {}) {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    const request = normalizeRequest(input, 'permission');
    session.permissions.push(request);
    session.status = 'blocked';
    session.updatedAt = nowIso();
    appendEvent(store, sessionId, 'permission_requested', { requestId: request.id, tool: request.tool });
    writeStore(store);
    return { request, session: publicSession(session) };
}

function respondPermission(sessionId, requestId, response = 'reject') {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    const request = session.permissions.find(item => item.id === requestId);
    if (!request) throw new Error(`Permission request not found: ${requestId}`);
    request.status = response === 'once' || response === 'always' || response === 'approve' || response === true ? 'approved' : 'rejected';
    request.response = response === true ? 'once' : response;
    request.updatedAt = nowIso();
    if (!session.permissions.some(item => item.status === 'pending') && !session.questions.some(item => item.status === 'pending')) {
        session.status = session.status === 'blocked' ? 'idle' : session.status;
    }
    session.updatedAt = nowIso();
    appendEvent(store, sessionId, 'permission_replied', { requestId, response: request.response, status: request.status });
    writeStore(store);
    return { request, session: publicSession(session) };
}

function addQuestionRequest(sessionId, input = {}) {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    const request = normalizeRequest(input, 'question');
    session.questions.push(request);
    session.status = 'blocked';
    session.updatedAt = nowIso();
    appendEvent(store, sessionId, 'question_requested', { requestId: request.id });
    writeStore(store);
    return { request, session: publicSession(session) };
}

function respondQuestion(sessionId, requestId, answer) {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    const request = session.questions.find(item => item.id === requestId);
    if (!request) throw new Error(`Question request not found: ${requestId}`);
    request.status = answer === undefined || answer === null ? 'rejected' : 'answered';
    request.answer = answer === undefined ? null : answer;
    request.updatedAt = nowIso();
    if (!session.permissions.some(item => item.status === 'pending') && !session.questions.some(item => item.status === 'pending')) {
        session.status = session.status === 'blocked' ? 'idle' : session.status;
    }
    session.updatedAt = nowIso();
    appendEvent(store, sessionId, 'question_replied', { requestId, status: request.status });
    writeStore(store);
    return { request, session: publicSession(session) };
}

function sessionTree(store, rootId) {
    const childrenByParent = new Map();
    for (const session of store.sessions) {
        if (!session.parentId) continue;
        if (!childrenByParent.has(session.parentId)) childrenByParent.set(session.parentId, []);
        childrenByParent.get(session.parentId).push(session.id);
    }
    const ids = [];
    const seen = new Set();
    const queue = [rootId];
    while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        ids.push(current);
        for (const child of childrenByParent.get(current) || []) queue.push(child);
    }
    return ids
        .map(item => store.sessions.find(session => session.id === item))
        .filter(Boolean)
        .map(publicSession);
}

function findTreeRequest(rootId, type = 'permission') {
    const store = readStore();
    getSessionFromStore(store, rootId);
    const tree = sessionTree(store, rootId);
    const collection = type === 'question' ? 'questions' : 'permissions';
    for (const session of tree) {
        const request = (session[collection] || []).find(item => item.status === 'pending');
        if (request) return { sessionId: session.id, request };
    }
    return null;
}

function queueFollowup(session, followup) {
    session.pendingFollowup = {
        ...(session.pendingFollowup || {}),
        ...followup,
        updatedAt: nowIso()
    };
    return session.pendingFollowup;
}

async function startSessionRun(sessionId, input = {}) {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('command is required');
    let store = readStore();
    let index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    let session = store.sessions[index];
    if (session.status === 'running' || session.status === 'blocked') {
        const queued = queueFollowup(session, {
            command,
            cwd: input.cwd || session.cwd,
            task: input.task || '',
            reason: session.status === 'blocked' ? 'session blocked' : 'session running'
        });
        session.updatedAt = nowIso();
        store.sessions[index] = normalizeSession(session);
        appendEvent(store, sessionId, 'followup_queued', { reason: queued.reason });
        writeStore(store);
        return { status: 'queued', queued, session: publicSession(session) };
    }

    session.status = 'running';
    session.lastRun = {
        command,
        cwd: path.resolve(input.cwd || session.cwd || process.cwd()),
        startedAt: nowIso(),
        timeoutMs: input.timeoutMs ? Number(input.timeoutMs) : undefined
    };
    session.updatedAt = nowIso();
    store.sessions[index] = normalizeSession(session);
    appendEvent(store, sessionId, 'run_started', { command: command.slice(0, 200) });
    writeStore(store);

    const result = await terminal.submitTerminalCommand({
        command,
        cwd: input.cwd || session.cwd,
        approved: input.approved === true,
        reason: input.reason || `agent-session:${sessionId}`,
        timeoutMs: input.timeoutMs
    });

    store = readStore();
    index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    session = store.sessions[index];
    session.output = result.output || result.reason || JSON.stringify(result);
    session.lastRun = {
        ...(session.lastRun || {}),
        finishedAt: nowIso(),
        status: result.status,
        exitCode: result.exitCode,
        requestId: result.requestId || null
    };
    if (result.status === 'approval_required') {
        session.status = 'blocked';
        session.permissions.push(normalizeRequest({
            id: result.requestId,
            tool: 'terminal_execute',
            reason: result.reason || 'terminal command requires approval',
            payload: { command, cwd: input.cwd || session.cwd }
        }, 'permission'));
    } else if (result.status === 'completed') {
        session.status = 'completed';
    } else if (result.status === 'timeout' || result.status === 'error') {
        session.status = 'failed';
    } else {
        session.status = 'idle';
    }
    session.updatedAt = nowIso();
    store.sessions[index] = normalizeSession(session);
    appendEvent(store, sessionId, 'run_finished', { status: result.status, exitCode: result.exitCode });
    writeStore(store);
    return { status: result.status, result, session: publicSession(session) };
}

function cancelAgentSession(sessionId, reason = 'cancelled by user') {
    const store = readStore();
    const index = findSessionIndex(store, sessionId);
    if (index === -1) throw new Error(`Agent session not found: ${sessionId}`);
    const session = store.sessions[index];
    session.status = 'cancelled';
    session.pendingFollowup = null;
    session.updatedAt = nowIso();
    appendEvent(store, sessionId, 'cancelled', { reason });
    writeStore(store);
    return publicSession(session);
}

function deleteAgentSession(sessionId, { includeChildren = false } = {}) {
    const store = readStore();
    getSessionFromStore(store, sessionId);
    const ids = includeChildren
        ? new Set(sessionTree(store, sessionId).map(item => item.id))
        : new Set([sessionId]);
    if (!includeChildren && store.sessions.some(item => item.parentId === sessionId)) {
        throw new Error('Session has child sessions; set includeChildren=true to delete the tree');
    }
    const before = store.sessions.length;
    store.sessions = store.sessions.filter(item => !ids.has(item.id));
    appendEvent(store, sessionId, 'deleted', { includeChildren, count: before - store.sessions.length });
    writeStore(store);
    return { deleted: before - store.sessions.length, includeChildren };
}

module.exports = {
    AGENT_SESSIONS_FILE,
    VALID_STATUSES,
    VALID_TODO_STATUSES,
    addPermissionRequest,
    addQuestionRequest,
    cancelAgentSession,
    createAgentSession,
    deleteAgentSession,
    findTreeRequest,
    getAgentSession,
    listAgentSessions,
    respondPermission,
    respondQuestion,
    startSessionRun,
    todoState,
    updateAgentSession,
    writeTodos
};
