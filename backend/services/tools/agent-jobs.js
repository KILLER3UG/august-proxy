const fs = require('fs');
const path = require('path');

const DEFAULT_AGENT_JOBS_FILE = path.join(__dirname, '..', '..', 'data', 'august_agent_jobs.json');
const MAX_JOBS = 300;
const MAX_EVENTS_PER_JOB = 80;

function getAgentJobsFile() {
    return process.env.AUGUST_AGENT_JOBS_FILE || DEFAULT_AGENT_JOBS_FILE;
}

function nowIso() {
    return new Date().toISOString();
}

function newJobId() {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeJobs(raw) {
    const jobs = raw && typeof raw === 'object' ? raw.jobs : raw;
    return {
        version: 1,
        updatedAt: raw?.updatedAt || null,
        jobs: Array.isArray(jobs) ? jobs : []
    };
}

function readAgentJobs() {
    const filePath = getAgentJobsFile();
    if (!fs.existsSync(filePath)) return { version: 1, updatedAt: null, jobs: [] };
    try {
        return normalizeJobs(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (_err) {
        return { version: 1, updatedAt: null, jobs: [] };
    }
}

function writeAgentJobs(store) {
    const filePath = getAgentJobsFile();
    const normalized = normalizeJobs(store);
    normalized.updatedAt = nowIso();
    normalized.jobs = normalized.jobs
        .slice()
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .slice(-MAX_JOBS);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
    return normalized;
}

function summarizeText(value, max = 1200) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getAgentJob(id) {
    const store = readAgentJobs();
    return store.jobs.find(job => job.id === id) || null;
}

function listAgentJobs(options = {}) {
    const store = readAgentJobs();
    const status = String(options.status || '').trim();
    const sessionId = String(options.sessionId || '').trim();
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
    const jobs = store.jobs
        .filter(job => !status || status === 'all' || job.status === status)
        .filter(job => !sessionId || job.sessionId === sessionId)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
        .slice(0, limit);
    return {
        generatedAt: nowIso(),
        file: getAgentJobsFile(),
        count: store.jobs.length,
        jobs
    };
}

function createAgentJob(input = {}) {
    const store = readAgentJobs();
    const now = nowIso();
    const job = {
        id: input.id || newJobId(),
        sessionId: input.sessionId || null,
        parentJobId: input.parentJobId || null,
        depth: Number(input.depth || 0),
        agentId: input.agentId || 'general',
        parentAgentId: input.parentAgentId || null,
        provider: input.provider || null,
        model: input.model || null,
        task: summarizeText(input.task, 2400),
        status: input.status || 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: null,
        error: null,
        result: null,
        events: []
    };
    store.jobs.push(job);
    writeAgentJobs(store);
    return job;
}

function updateAgentJob(id, patch = {}) {
    const store = readAgentJobs();
    const job = store.jobs.find(item => item.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: nowIso() });
    if (Array.isArray(job.events) && job.events.length > MAX_EVENTS_PER_JOB) {
        job.events = job.events.slice(-MAX_EVENTS_PER_JOB);
    }
    writeAgentJobs(store);
    return job;
}

function appendAgentJobEvent(id, event = {}) {
    const store = readAgentJobs();
    const job = store.jobs.find(item => item.id === id);
    if (!job) return null;
    if (!Array.isArray(job.events)) job.events = [];
    job.events.push({
        at: nowIso(),
        type: event.type || 'note',
        title: summarizeText(event.title || '', 160),
        content: summarizeText(event.content || '', 4000),
        metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : undefined
    });
    job.events = job.events.slice(-MAX_EVENTS_PER_JOB);
    job.updatedAt = nowIso();
    writeAgentJobs(store);
    return job;
}

function appendAgentJobMessage(id, role, content, metadata = {}) {
    return appendAgentJobEvent(id, {
        type: 'message',
        title: role || 'message',
        content: typeof content === 'string' ? content : JSON.stringify(content || {}),
        metadata
    });
}

function appendAgentJobToolResult(id, toolName, result, metadata = {}) {
    return appendAgentJobEvent(id, {
        type: 'tool',
        title: toolName || 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result || {}),
        metadata
    });
}

function completeAgentJob(id, result, patch = {}) {
    return updateAgentJob(id, {
        ...patch,
        status: 'completed',
        result: summarizeText(typeof result === 'string' ? result : JSON.stringify(result || {}), 8000),
        completedAt: nowIso(),
        error: null
    });
}

function failAgentJob(id, error, patch = {}) {
    return updateAgentJob(id, {
        ...patch,
        status: 'failed',
        error: summarizeText(error instanceof Error ? error.message : error, 2000),
        completedAt: nowIso()
    });
}

module.exports = {
    DEFAULT_AGENT_JOBS_FILE,
    appendAgentJobEvent,
    appendAgentJobMessage,
    appendAgentJobToolResult,
    completeAgentJob,
    createAgentJob,
    failAgentJob,
    getAgentJob,
    getAgentJobsFile,
    listAgentJobs,
    readAgentJobs,
    updateAgentJob,
    writeAgentJobs
};
