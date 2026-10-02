/* Discovery must be RECOVERABLE.
 *
 * `api/client.ts` used to bind one `const ready = initBaseUrl()` promise. A
 * first launch or post-update bootstrap slower than ~3 minutes rejected it
 * FOREVER — `const` cannot be reassigned — so every `await ready()` in
 * whenReady/apiUrl/wsUrl rejected from then on, `installFetchPatch` never ran,
 * and every relative `/api` request went to the Tauri asset origin. Meanwhile
 * `BackendBootstrapGate` polls `proxy_status` on its own 1 s interval and
 * reveals the app anyway, so the user got a fully mounted UI against a dead
 * API layer with restart as the only way out.
 *
 * This had NO test at all. It runs on every launch, so a regression here is
 * "August cannot talk to its own backend".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

// `client.ts` captures these at import time; they must be settable per test.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@/lib/tauri-detect', () => ({ isTauri: true }));

async function loadClient() {
  vi.resetModules();
  return import('@/api/client');
}

type ClientModule = Awaited<ReturnType<typeof loadClient>>;

/** Shrink the retry budget for the current module instance only. */
function setDiscoveryBudget(mod: ClientModule, attempts: number, maxBackoffMs = 1) {
  mod.setDiscoveryBudget(attempts, maxBackoffMs);
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('api/client — backend discovery', () => {
  it('resolves once the supervisor reports ok', async () => {
    invokeMock.mockResolvedValue('ok:8123');
    const { whenReady } = await loadClient();
    await expect(whenReady()).resolves.toBe('http://127.0.0.1:8123');
  });

  it('keeps polling through a slow backend rather than giving up early', async () => {
    // The first several calls report "not up yet", which is the normal case.
    invokeMock
      .mockResolvedValueOnce('starting')
      .mockResolvedValueOnce('starting')
      .mockResolvedValue('ok:8123');
    const { whenReady } = await loadClient();
    await expect(whenReady()).resolves.toBe('http://127.0.0.1:8123');
    expect(invokeMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('surfaces a failure instead of hanging when the backend never comes up', async () => {
    // Shrink the retry budget for this test only; production keeps 120. Without
    // this the real backoff ramp costs ~3 minutes of wall clock.
    const mod = await loadClient();
    setDiscoveryBudget(mod, 3, 1);
    invokeMock.mockResolvedValue('starting');
    await expect(mod.whenReady()).rejects.toThrow(/did not become ready/i);
  });

  it('exports resetDiscovery so a later success can retry discovery', async () => {
    const mod = await loadClient();
    expect(typeof mod.resetDiscovery).toBe('function');
  });

  it('does not treat an unknown status as healthy', async () => {
    const mod = await loadClient();
    setDiscoveryBudget(mod, 3, 1);
    invokeMock.mockResolvedValue('error: something went wrong');
    // 'error: …' must not be read as 'ok:<port>'.
    await expect(mod.whenReady()).rejects.toThrow(/did not become ready/i);
  });

  it('can retry after a failure once the backend comes up', async () => {
    const mod = await loadClient();
    setDiscoveryBudget(mod, 2, 1);
    invokeMock.mockResolvedValue('starting');
    await expect(mod.whenReady()).rejects.toThrow(/did not become ready/i);

    // This is the regression: the old `const ready` promise was poisoned for
    // the life of the window. After resetDiscovery, discovery runs again.
    invokeMock.mockResolvedValue('ok:8123');
    mod.resetDiscovery();
    await expect(mod.whenReady()).resolves.toBe('http://127.0.0.1:8123');
  });
});
