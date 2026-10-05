/* The live half of the SkillEvolvedChip's contract.
 *
 * The chip reads one query; what makes an apply by the six-hour reviewer job
 * arrive in an already-open window is the `skill-evolved` event carrying
 * `queryKeys`, which the bridge's forward-compatible default case turns into an
 * invalidation. That indirection is the whole live path, so it is pinned here
 * rather than assumed — an event nobody invalidates is a chip that only shows up
 * after a reload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));

vi.mock('@/query-client', () => ({
  queryClient: { invalidateQueries, setQueryData: vi.fn(), getQueryData: vi.fn() },
}));
vi.mock('@/api/client', () => ({
  whenReady: () => Promise.resolve(''),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onmessage: ((msg: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe('realtime bridge → harness-auto-history', () => {
  beforeEach(() => {
    vi.resetModules();
    invalidateQueries.mockClear();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the auto-history key for a skill-evolved event', async () => {
    const bridge = await import('./bridge');
    bridge.startRealtimeBridge();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    FakeEventSource.instances[0].emit({
      type: 'skill-evolved',
      skill: 'ngspice-flow',
      versionTs: '1791234567',
      queryKeys: ['harness-auto-history'],
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['harness-auto-history'] });
    bridge.stopRealtimeBridge();
  });
});
