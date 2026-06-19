const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Source-level test: verifies that repairManagedWebToolResults is bounded
// to a tail window instead of scanning the entire conversation. Runtime
// tests would require mocking executeManagedWebTool / formatManagedWebResult
// and several transitive deps (logger, selfheal, etc.) — source-level is the
// best signal-to-noise ratio here.

const source = fs.readFileSync(
    path.join(__dirname, '..', 'adapters', 'anthropic.js'),
    'utf8'
);

test('REPAIR_SCAN_WINDOW constant exists and equals 24', () => {
    const match = source.match(/const\s+REPAIR_SCAN_WINDOW\s*=\s*(\d+)\s*;/);
    assert.ok(match, 'expected `const REPAIR_SCAN_WINDOW = N;` declaration in anthropic.js');
    assert.equal(Number(match[1]), 24);
});

test('repairManagedWebToolResults slices the tail using REPAIR_SCAN_WINDOW', () => {
    // The function should compute `tailStart = length - REPAIR_SCAN_WINDOW`
    // (not necessarily inline), then slice from there.
    assert.ok(
        /\.length\s*-\s*REPAIR_SCAN_WINDOW/.test(source),
        'expected `length - REPAIR_SCAN_WINDOW` arithmetic in anthropic.js'
    );
    assert.ok(
        /\.slice\(\s*tailStart\s*\)/.test(source),
        'expected `.slice(tailStart)` call after computing tailStart'
    );
});

test('repairManagedWebToolResults preserves untouched prefix when windowing is active', () => {
    // The function should splice the repaired tail back onto the untouched
    // prefix (`slice(0, repairStartIndex).concat(repairedMessages)`).
    assert.ok(
        /\.slice\(\s*0\s*,\s*repairStartIndex\s*\)/.test(source),
        'expected prefix-preserving slice in repairManagedWebToolResults'
    );
    assert.ok(
        /\.concat\(\s*repairedMessages\s*\)/.test(source),
        'expected repaired tail concat with prefix'
    );
});

test('short histories still get scanned in full (≤ REPAIR_SCAN_WINDOW messages)', () => {
    // The function should check `length > REPAIR_SCAN_WINDOW` before windowing.
    const guardPattern = /length\s*>\s*REPAIR_SCAN_WINDOW/;
    assert.ok(
        guardPattern.test(source),
        'expected `length > REPAIR_SCAN_WINDOW` short-circuit in anthropic.js'
    );
});
