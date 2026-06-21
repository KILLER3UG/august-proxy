// ── August unified scheduler ──
// Owns the single server-side tick that drives every due-job runner in
// August. Today there are two runners: cron-tools (LLM-facing prompt/command
// jobs) and automation-jobs (UI-facing workbench automation with approvals).
// Each runner keeps its own in-flight guard / lock file; the scheduler does
// not own those guards, only the tick.
//
// Why one tick? Two `setInterval`s racing at 30s/60s is wasteful and the
// logs are noisy. With one tick every 30s:
//   • exactly one `[Scheduler] tick` line per 30 seconds
//   • both runners see every tick (they decide independently whether they
//     have due work, so a 60s automation tick is unaffected)
//   • one runner throwing does not block the other
//   • boot shutdown is a single clearInterval call

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_SLOW_RUNNER_MS = 1_000;

let emitLogEvent = null;
try {
    // Lazy-load so unit tests that stub the logger module don't pull the
    // websocket/ring-buffer machinery into the test sandbox.
    emitLogEvent = require('../../lib/logger').emitLogEvent;
} catch (_) {
    emitLogEvent = () => {};
}

let tickInterval = null;
let tickInFlight = false;
let lastTickAt = null;
let lastResults = null;
let lastTickStartedAt = null;

function yieldEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function nowIso() {
    return new Date().toISOString();
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    const abs = Math.abs(value);
    if (abs >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    if (abs >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (abs >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
}

function safeMemoryUsage() {
    try {
        return process.memoryUsage();
    } catch (_) {
        return null;
    }
}

function cpuPercent(cpuDelta, wallMs) {
    if (!cpuDelta || !wallMs) return null;
    const cpuMs = ((cpuDelta.user || 0) + (cpuDelta.system || 0)) / 1000;
    return Math.max(0, Math.round((cpuMs / wallMs) * 100));
}

async function safeRun(label, runner, metadata = {}, options = {}) {
    const logger = options.logger || console;
    const slowRunnerMs = Number(options.slowRunnerMs) > 0 ? Number(options.slowRunnerMs) : DEFAULT_SLOW_RUNNER_MS;
    const startedAtMs = Date.now();
    const startedCpu = typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;
    const startedMemory = safeMemoryUsage();
    logger.log(`[Scheduler] Runner started for job: "${label}" (type: ${metadata.type || 'unknown'}, priority: ${metadata.priority || 'normal'})`);
    try {
        const result = await runner();
        const durationMs = Date.now() - startedAtMs;
        const cpu = startedCpu && typeof process.cpuUsage === 'function' ? process.cpuUsage(startedCpu) : null;
        const memory = safeMemoryUsage();
        const memoryDeltaBytes = memory && startedMemory ? memory.rss - startedMemory.rss : null;
        const cpuPct = cpuPercent(cpu, durationMs);
        logger.log(`[Scheduler] Runner completed: "${label}" - took ${(durationMs / 1000).toFixed(1)}s, CPU: ${cpuPct == null ? 'n/a' : `${cpuPct}%`}, Memory: ${memoryDeltaBytes == null ? 'n/a' : `${memoryDeltaBytes >= 0 ? '+' : ''}${formatBytes(memoryDeltaBytes)}`}`);
        if (durationMs > slowRunnerMs) {
            logger.warn(`[Scheduler] Runner "${label}" exceeded ${slowRunnerMs}ms (${durationMs}ms)`);
            try { emitLogEvent({ category: 'scheduler', level: 'warn', message: `Runner "${label}" exceeded ${slowRunnerMs}ms (${durationMs}ms)`, metadata: { runner: label, durationMs } }); } catch (_) {}
        }
        return { runner: label, ok: true, result, at: nowIso(), durationMs, cpuPercent: cpuPct, memoryDeltaBytes, metadata };
    } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        logger.warn(`[Scheduler] ${label} tick failed:`, err.message);
        try { emitLogEvent({ category: 'scheduler', level: 'error', message: `${label} tick failed: ${err.message}`, metadata: { runner: label, error: err.message } }); } catch (_) {}
        return { runner: label, ok: false, error: err.message, at: nowIso(), durationMs, metadata };
    }
}

/**
 * Run one tick: invoke each registered runner in order and collect results.
 * Safe to call from outside the interval (e.g. a manual trigger for tests).
 */
async function tick(runners, options = {}) {
    if (tickInFlight) {
        return { skipped: true, reason: 'tick already running', at: nowIso() };
    }
    tickInFlight = true;
    try {
        const startedAt = Date.now();
        lastTickStartedAt = nowIso();
        const logger = options.logger || console;
        const maxConcurrentRunners = Math.max(1, Number(options.maxConcurrentRunners) || 1);
        const startedCpu = typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;
        const startedMemory = safeMemoryUsage();
        const results = [];
        await yieldEventLoop();
        for (const { label, run, metadata } of runners) {
            // Sequential — one runner's lock contention should not starve the
            // other, but it should not run in parallel either.
            const r = await safeRun(label, run, metadata || {}, options);
            results.push(r);
            if (maxConcurrentRunners === 1) await yieldEventLoop();
        }
        lastTickAt = nowIso();
        lastResults = results;
        const durationMs = Date.now() - startedAt;
        const cpu = startedCpu && typeof process.cpuUsage === 'function' ? process.cpuUsage(startedCpu) : null;
        const memory = safeMemoryUsage();
        const memoryRss = memory ? memory.rss : null;
        const memoryDeltaBytes = memory && startedMemory ? memory.rss - startedMemory.rss : null;
        const cpuPct = cpuPercent(cpu, durationMs);
        return {
            ran: results.length,
            results,
            durationMs,
            at: lastTickAt,
            startedAt: lastTickStartedAt,
            cpuPercent: cpuPct,
            memoryRss,
            memoryDeltaBytes,
            dbPool: 'n/a',
        };
    } finally {
        tickInFlight = false;
    }
}

function start(runners, { tickMs = DEFAULT_TICK_MS, logger = console, maxConcurrentRunners = 1, slowRunnerMs = DEFAULT_SLOW_RUNNER_MS } = {}) {
    if (tickInterval) {
        logger.log('[Scheduler] already started.');
        return false;
    }
    if (!Array.isArray(runners) || runners.length === 0) {
        throw new Error('Scheduler requires a non-empty runners array.');
    }

    logger.log(`[Scheduler] starting (${runners.length} runners, every ${tickMs}ms)`);
    tickInterval = setInterval(async () => {
        try {
            const t = await tick(runners, { logger, maxConcurrentRunners, slowRunnerMs });
            if (t.ran != null) {
                logger.log(`[System] Scheduler tick: ${t.ran} runners, ${t.durationMs}ms | CPU: ${t.cpuPercent == null ? 'n/a' : `${t.cpuPercent}%`} | Memory: ${t.memoryRss == null ? 'n/a' : formatBytes(t.memoryRss)} | DB pool: ${t.dbPool || 'n/a'}`);
                try { emitLogEvent({ category: 'scheduler', level: 'info', message: `tick — ${t.ran} runners, ${t.durationMs}ms`, metadata: { ran: t.ran, durationMs: t.durationMs, cpuPercent: t.cpuPercent, memoryRss: t.memoryRss } }); } catch (_) {}
            }
        } catch (e) {
            logger.warn('[Scheduler] tick threw unexpectedly:', e.message);
            try { emitLogEvent({ category: 'scheduler', level: 'error', message: `tick threw unexpectedly: ${e.message}`, metadata: { error: e.message } }); } catch (_) {}
        }
    }, tickMs);
    // unref so the timer does not hold the event loop open on shutdown
    if (typeof tickInterval.unref === 'function') tickInterval.unref();
    return true;
}

function stop() {
    if (!tickInterval) return false;
    clearInterval(tickInterval);
    tickInterval = null;
    return true;
}

function isRunning() {
    return tickInterval != null;
}

function getLastTick() {
    return { at: lastTickAt, results: lastResults };
}

/**
 * Convenience: build a runner from a function with a label. Used at boot
 * time to wire `runDueCronJobs` and `runDueAutomations` into the scheduler.
 */
function runner(label, run, metadata = {}) {
    return { label, run, metadata: metadata || {} };
}

module.exports = {
    start,
    stop,
    tick,
    isRunning,
    getLastTick,
    runner,
    DEFAULT_TICK_MS,
    DEFAULT_SLOW_RUNNER_MS,
};
