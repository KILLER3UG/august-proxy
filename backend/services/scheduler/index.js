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

let tickInterval = null;
let tickInFlight = false;
let lastTickAt = null;
let lastResults = null;

function nowIso() {
    return new Date().toISOString();
}

async function safeRun(label, runner) {
    try {
        const result = await runner();
        return { runner: label, ok: true, result, at: nowIso() };
    } catch (err) {
        console.warn(`[Scheduler] ${label} tick failed:`, err.message);
        return { runner: label, ok: false, error: err.message, at: nowIso() };
    }
}

/**
 * Run one tick: invoke each registered runner in order and collect results.
 * Safe to call from outside the interval (e.g. a manual trigger for tests).
 */
async function tick(runners) {
    if (tickInFlight) {
        return { skipped: true, reason: 'tick already running', at: nowIso() };
    }
    tickInFlight = true;
    try {
        const startedAt = Date.now();
        const results = [];
        for (const { label, run } of runners) {
            // Sequential — one runner's lock contention should not starve the
            // other, but it should not run in parallel either.
            const r = await safeRun(label, run);
            results.push(r);
        }
        lastTickAt = nowIso();
        lastResults = results;
        const durationMs = Date.now() - startedAt;
        return { ran: results.length, results, durationMs, at: lastTickAt };
    } finally {
        tickInFlight = false;
    }
}

function start(runners, { tickMs = DEFAULT_TICK_MS, logger = console } = {}) {
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
            const t = await tick(runners);
            if (t.ran != null) {
                logger.log(`[Scheduler] tick — ${t.ran} runners, ${t.durationMs}ms`);
            }
        } catch (e) {
            logger.warn('[Scheduler] tick threw unexpectedly:', e.message);
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
function runner(label, run) {
    return { label, run };
}

module.exports = {
    start,
    stop,
    tick,
    isRunning,
    getLastTick,
    runner,
    DEFAULT_TICK_MS,
};
