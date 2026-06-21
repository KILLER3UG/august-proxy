// Tests for the unified scheduler in backend/services/scheduler/index.js.
// Replaces the prior dual setInterval (cron-tools 30s + automation-jobs 60s)
// with one tick that fans out to both runners. Verifies:
//   • both runners are invoked on every tick
//   • a throwing runner does not block the others
//   • start()/stop() lifecycle and tickInFlight guard work
//   • the runDueCronJobs helper exported from cron-tools is callable

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../services/scheduler');

test.afterEach(() => {
    scheduler.stop();
});

test('start rejects an empty runners array', () => {
    assert.throws(() => scheduler.start([]));
    assert.throws(() => scheduler.start(null));
});

test('tick invokes every runner in order and aggregates results', async () => {
    const calls = [];
    const a = scheduler.runner('a', async () => { calls.push('a'); return { count: 1 }; });
    const b = scheduler.runner('b', async () => { calls.push('b'); return { count: 2 }; });

    const result = await scheduler.tick([a, b]);
    assert.equal(result.ran, 2);
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(result.results[0].runner, 'a');
    assert.equal(result.results[0].ok, true);
    assert.deepEqual(result.results[0].result, { count: 1 });
    assert.equal(result.results[1].runner, 'b');
    assert.equal(result.results[1].ok, true);
    assert.deepEqual(result.results[1].result, { count: 2 });
});

test('a throwing runner does not block subsequent runners', async () => {
    const calls = [];
    const a = scheduler.runner('a', async () => { calls.push('a'); throw new Error('boom'); });
    const b = scheduler.runner('b', async () => { calls.push('b'); return 'ok'; });

    const result = await scheduler.tick([a, b]);
    assert.equal(result.ran, 2);
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].error, 'boom');
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[1].result, 'ok');
});

test('a throwing runner that returns a rejected promise is captured', async () => {
    const a = scheduler.runner('a', () => Promise.reject(new Error('async-boom')));
    const b = scheduler.runner('b', async () => 'fine');

    const result = await scheduler.tick([a, b]);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].error, 'async-boom');
    assert.equal(result.results[1].ok, true);
});

test('a runner that returns a non-promise value is still awaited', async () => {
    const a = scheduler.runner('a', () => 42);
    const result = await scheduler.tick([a]);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].result, 42);
});

test('start schedules the interval and stop clears it', async () => {
    const a = scheduler.runner('a', async () => 'ok');
    const started = scheduler.start([a], { tickMs: 25, logger: { log() {}, warn() {} } });
    assert.equal(started, true);
    assert.equal(scheduler.isRunning(), true);

    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
});

test('start is idempotent — calling twice is a no-op', () => {
    const a = scheduler.runner('a', async () => 'ok');
    const first = scheduler.start([a], { tickMs: 1000, logger: { log() {}, warn() {} } });
    const second = scheduler.start([a], { tickMs: 1000, logger: { log() {}, warn() {} } });
    assert.equal(first, true);
    assert.equal(second, false);
});

test('the interval actually fires when tickMs is small', async () => {
    const calls = [];
    const a = scheduler.runner('a', async () => { calls.push(Date.now()); });
    scheduler.start([a], { tickMs: 20, logger: { log() {}, warn() {} } });
    await new Promise(resolve => setTimeout(resolve, 90));
    scheduler.stop();
    assert.ok(calls.length >= 2, `expected >= 2 ticks, got ${calls.length}`);
});

test('getLastTick returns the most recent tick metadata', async () => {
    const a = scheduler.runner('a', async () => 'ok');
    await scheduler.tick([a]);
    const after = scheduler.getLastTick();
    assert.ok(after.at);
    assert.equal(after.results.length, 1);
    assert.equal(after.results[0].runner, 'a');

    // Second tick updates the timestamp.
    await new Promise(r => setTimeout(r, 5));
    const b = scheduler.runner('b', async () => 'ok-2');
    await scheduler.tick([b]);
    const later = scheduler.getLastTick();
    assert.ok(later.at >= after.at, 'later tick should have a >= timestamp');
    assert.equal(later.results[0].runner, 'b');
});

test('concurrent ticks are coalesced (only one runs at a time)', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const a = scheduler.runner('a', async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise(r => setTimeout(r, 30));
        inFlight--;
    });
    const [r1, r2] = await Promise.all([scheduler.tick([a]), scheduler.tick([a])]);
    const completed = [r1, r2].filter(r => r.ran != null).length;
    const skipped = [r1, r2].filter(r => r.skipped).length;
    assert.equal(completed, 1, 'exactly one tick should have run');
    assert.equal(skipped, 1, 'the second tick should have been skipped');
    assert.equal(maxConcurrent, 1, 'no two runner invocations should overlap');
});

// ── Integration with the cron-tools export ──
// Verifies that runDueCronJobs is the contract the scheduler expects: a
// function that returns a Promise and is safe to call repeatedly.
test('runDueCronJobs from cron-tools is callable and returns a summary', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-cron-tick-'));
    process.env.AUGUST_DATA_DIR = tempDir;

    const cronTools = require('../services/tools/missing/cron-tools');

    // Clean any leftover jobs file from prior runs in this tempdir
    const jobsFile = path.join(tempDir, 'august_cron_jobs.json');
    if (fs.existsSync(jobsFile)) fs.unlinkSync(jobsFile);

    const summary = await cronTools.runDueCronJobs();
    assert.ok(summary, 'expected a summary object');
    assert.equal(summary.ran, 0, 'no jobs should be due in a fresh data dir');
    assert.ok(summary.at, 'expected an at timestamp');

    fs.rmSync(tempDir, { recursive: true, force: true });
});
