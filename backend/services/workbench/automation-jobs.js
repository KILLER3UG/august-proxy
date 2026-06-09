const fs = require('fs');
const path = require('path');
const terminal = require('./terminal-service');
const { appendRecentEvent, readAugustCoreMemory, writeAugustCoreMemory } = require('../memory/core-memory');

const AUTOMATION_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_automation_jobs.json');
const AUTOMATION_LOCK_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_automation_jobs.tick.lock');
const MAX_RUNS_PER_JOB = 50;
const DEFAULT_JOB_TIMEOUT_MS = 180000;
const STALE_LOCK_MS = 5 * 60 * 1000;

let tickInFlight = false;

function nowIso() {
    return new Date().toISOString();
}

function id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStore() {
    return { jobs: [], runs: [] };
}

function readStore() {
    if (!fs.existsSync(AUTOMATION_FILE)) {
        fs.writeFileSync(AUTOMATION_FILE, JSON.stringify(defaultStore(), null, 2));
        return defaultStore();
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(AUTOMATION_FILE, 'utf8'));
        return {
            jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
            runs: Array.isArray(parsed.runs) ? parsed.runs : []
        };
    } catch (e) {
        return defaultStore();
    }
}

function writeStore(store) {
    fs.writeFileSync(AUTOMATION_FILE, JSON.stringify({
        jobs: Array.isArray(store.jobs) ? store.jobs : [],
        runs: Array.isArray(store.runs) ? store.runs : []
    }, null, 2));
}

function parseDurationMinutes(amount, unit) {
    const value = Math.max(1, Number(amount) || 1);
    const normalized = String(unit || 'm').toLowerCase();
    if (normalized.startsWith('d')) return value * 1440;
    if (normalized.startsWith('h')) return value * 60;
    return value;
}

function parseSchedule(schedule) {
    if (!schedule) return { type: 'manual' };
    if (typeof schedule === 'object') return schedule;
    const text = String(schedule).trim();
    if (text === '@hourly') return { type: 'interval', minutes: 60 };
    if (text === '@daily') return { type: 'interval', minutes: 24 * 60 };
    const compact = /^(\d+)\s*([mhd])$/i.exec(text);
    if (compact) return { type: 'interval', minutes: parseDurationMinutes(compact[1], compact[2]) };
    const compactEvery = /^every\s+(\d+)\s*([mhd])$/i.exec(text);
    if (compactEvery) return { type: 'interval', minutes: parseDurationMinutes(compactEvery[1], compactEvery[2]) };
    const every = /^every\s+(\d+)\s*(minute|minutes|hour|hours|day|days)$/i.exec(text);
    if (every) {
        return { type: 'interval', minutes: parseDurationMinutes(every[1], every[2]) };
    }
    const cronMinutes = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(text);
    if (cronMinutes) return { type: 'interval', minutes: Number(cronMinutes[1]) };
    if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(text)) return { type: 'cron', expression: text };
    if (!Number.isNaN(Date.parse(text))) return { type: 'once', at: new Date(text).toISOString() };
    return { type: 'manual', raw: text };
}

function matchCronField(field, value, min, max) {
    const text = String(field || '*').trim();
    if (text === '*') return true;
    return text.split(',').some(part => {
        const item = part.trim();
        if (!item) return false;
        const step = /^(.+)\/(\d+)$/.exec(item);
        if (step) {
            const every = Math.max(1, Number(step[2]) || 1);
            const base = step[1] === '*' ? `${min}-${max}` : step[1];
            for (let current = min; current <= max; current++) {
                if (matchCronField(base, current, min, max) && ((current - min) % every === 0) && current === value) return true;
            }
            return false;
        }
        const range = /^(\d+)-(\d+)$/.exec(item);
        if (range) {
            const start = Math.max(min, Number(range[1]));
            const end = Math.min(max, Number(range[2]));
            return value >= start && value <= end;
        }
        const exact = Number(item);
        if (!Number.isFinite(exact)) return false;
        if (max === 7 && value === 0 && exact === 7) return true;
        return exact === value;
    });
}

function nextCronRunAt(expression, from = new Date()) {
    const fields = String(expression || '').trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const candidate = new Date(from.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
        const matches =
            matchCronField(minute, candidate.getMinutes(), 0, 59) &&
            matchCronField(hour, candidate.getHours(), 0, 23) &&
            matchCronField(dayOfMonth, candidate.getDate(), 1, 31) &&
            matchCronField(month, candidate.getMonth() + 1, 1, 12) &&
            matchCronField(dayOfWeek, candidate.getDay(), 0, 7);
        if (matches) return candidate.toISOString();
        candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
}

function nextRunAt(job, from = new Date()) {
    const schedule = parseSchedule(job.schedule);
    if (schedule.type === 'manual') return null;
    if (schedule.type === 'once') return job.lastRunAt ? null : schedule.at;
    if (schedule.type === 'interval') {
        const minutes = Math.max(1, Number(schedule.minutes) || 60);
        const base = job.lastRunAt ? new Date(job.lastRunAt) : new Date(job.createdAt || from);
        return new Date(base.getTime() + minutes * 60000).toISOString();
    }
    if (schedule.type === 'cron') {
        const base = job.lastRunAt ? new Date(job.lastRunAt) : new Date(job.createdAt || from);
        return nextCronRunAt(schedule.expression, base);
    }
    return null;
}

function coerceTimeoutMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_JOB_TIMEOUT_MS;
    return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.floor(numeric)));
}

function normalizeJob(job = {}) {
    const createdAt = job.createdAt || nowIso();
    return {
        id: job.id || id('auto'),
        name: job.name || 'August automation',
        type: job.type || (job.command ? 'command' : 'memory_event'),
        schedule: job.schedule || 'manual',
        task: job.task || '',
        command: job.command || '',
        cwd: job.cwd || process.cwd(),
        agent: job.agent || 'build',
        enabled: job.enabled !== false,
        approved: job.approved === true,
        approvalRequired: job.approvalRequired !== false,
        timeoutMs: coerceTimeoutMs(job.timeoutMs),
        createdAt,
        updatedAt: job.updatedAt || createdAt,
        lastRunAt: job.lastRunAt || null,
        nextRunAt: job.nextRunAt || nextRunAt({ ...job, createdAt }, new Date())
    };
}

function acquireTickLock() {
    try {
        const fd = fs.openSync(AUTOMATION_LOCK_FILE, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
        return {
            acquired: true,
            release() {
                try { fs.closeSync(fd); } catch (e) {}
                try { fs.unlinkSync(AUTOMATION_LOCK_FILE); } catch (e) {}
            }
        };
    } catch (e) {
        try {
            const stat = fs.statSync(AUTOMATION_LOCK_FILE);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
                fs.unlinkSync(AUTOMATION_LOCK_FILE);
                return acquireTickLock();
            }
        } catch (_) {}
        return {
            acquired: false,
            release() {}
        };
    }
}

function listAutomationJobs() {
    const store = readStore();
    return {
        jobs: store.jobs.map(normalizeJob),
        runs: store.runs.slice(-100)
    };
}

function saveAutomationJob(job) {
    const store = readStore();
    const normalized = normalizeJob(job);
    const index = store.jobs.findIndex(item => item.id === normalized.id);
    if (index >= 0) store.jobs[index] = { ...store.jobs[index], ...normalized, updatedAt: nowIso() };
    else store.jobs.push(normalized);
    writeStore(store);
    return normalized;
}

function deleteAutomationJob(jobId) {
    const store = readStore();
    const before = store.jobs.length;
    store.jobs = store.jobs.filter(job => job.id !== jobId);
    writeStore(store);
    return before !== store.jobs.length;
}

function appendRun(store, run) {
    store.runs.push(run);
    const byJob = store.runs.filter(item => item.jobId === run.jobId);
    if (byJob.length > MAX_RUNS_PER_JOB) {
        const remove = new Set(byJob.slice(0, byJob.length - MAX_RUNS_PER_JOB).map(item => item.id));
        store.runs = store.runs.filter(item => !remove.has(item.id));
    }
}

async function executeJob(job, { approved = false, manual = false } = {}) {
    const normalized = normalizeJob(job);
    if (!normalized.enabled && !manual) {
        return { status: 'skipped', reason: 'disabled', jobId: normalized.id };
    }
    if (normalized.approvalRequired && !normalized.approved && !approved) {
        return { status: 'approval_required', jobId: normalized.id, reason: 'automation job is not approved' };
    }
    if (normalized.type === 'command') {
        return terminal.submitTerminalCommand({
            command: normalized.command,
            cwd: normalized.cwd,
            approved: approved || normalized.approved,
            reason: `automation:${normalized.name}`,
            timeoutMs: normalized.timeoutMs
        });
    }
    const memory = readAugustCoreMemory();
    writeAugustCoreMemory(appendRecentEvent(memory, {
        summary: normalized.task || `Automation ran: ${normalized.name}`,
        source: `automation:${normalized.id}`
    }));
    return { status: 'completed', output: `Recorded memory event for ${normalized.name}` };
}

async function runAutomationJob(jobId, options = {}) {
    const store = readStore();
    const index = store.jobs.findIndex(job => job.id === jobId);
    if (index === -1) throw new Error(`Automation job not found: ${jobId}`);
    const job = normalizeJob(store.jobs[index]);
    const result = await executeJob(job, { ...options, manual: true });
    const run = {
        id: id('run'),
        jobId: job.id,
        status: result.status,
        output: result.output || result.reason || '',
        exitCode: result.exitCode,
        createdAt: nowIso()
    };
    appendRun(store, run);
    if (result.status !== 'approval_required') {
        store.jobs[index] = {
            ...job,
            lastRunAt: run.createdAt,
            nextRunAt: nextRunAt({ ...job, lastRunAt: run.createdAt }, new Date())
        };
    }
    writeStore(store);
    return { job: store.jobs[index], run, result };
}

async function runDueAutomations() {
    if (tickInFlight) return { skipped: true, reason: 'tick already running' };
    const lock = acquireTickLock();
    if (!lock.acquired) return { skipped: true, reason: 'tick lock held' };
    tickInFlight = true;
    try {
        const store = readStore();
        const now = Date.now();
        const due = store.jobs
            .map((job, index) => ({ job: normalizeJob(job), index }))
            .filter(item => item.job.enabled && item.job.nextRunAt && Date.parse(item.job.nextRunAt) <= now);
        const runs = [];
        for (const item of due) {
            const result = await executeJob(item.job);
            const run = {
                id: id('run'),
                jobId: item.job.id,
                status: result.status,
                output: result.output || result.reason || '',
                exitCode: result.exitCode,
                createdAt: nowIso()
            };
            appendRun(store, run);
            if (result.status !== 'approval_required') {
                store.jobs[item.index] = {
                    ...item.job,
                    lastRunAt: run.createdAt,
                    nextRunAt: nextRunAt({ ...item.job, lastRunAt: run.createdAt }, new Date())
                };
            }
            runs.push(run);
        }
        writeStore(store);
        return { ran: runs.length, runs };
    } finally {
        tickInFlight = false;
        lock.release();
    }
}

module.exports = {
    AUTOMATION_FILE,
    AUTOMATION_LOCK_FILE,
    deleteAutomationJob,
    listAutomationJobs,
    nextCronRunAt,
    parseSchedule,
    runAutomationJob,
    runDueAutomations,
    saveAutomationJob
};
