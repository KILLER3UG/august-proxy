/**
 * switchChatModel — the handoff-sequencing fix (the switch race). The server
 * handoff POST used to be fire-and-forget while the caller's auto-continue ran
 * on setTimeout(0); now switchChatModel returns a `handoffReady` promise the
 * caller awaits, so the re-send carries the upgraded summary and the notice
 * card is placed before the new turn.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestSessionHandoff = vi.fn();
const markHandoffPending = vi.fn();
const peekHandoffPending = vi.fn((..._a: unknown[]) => false);
const buildHandoffSummary = vi.fn((..._a: unknown[]) => 'local summary');
const buildHandoffNoticeMessage = vi.fn((..._a: unknown[]) => ({ role: 'system', content: 'notice' }));

vi.mock('@/api/workbench', () => ({
  requestSessionHandoff: (...a: unknown[]) => requestSessionHandoff(...a),
}));
vi.mock('../handoff-summary', () => ({
  markHandoffPending: (...a: unknown[]) => markHandoffPending(...a),
  peekHandoffPending: (...a: unknown[]) => peekHandoffPending(...a),
  buildHandoffSummary: (...a: unknown[]) => buildHandoffSummary(...a),
  buildHandoffNoticeMessage: (...a: unknown[]) => buildHandoffNoticeMessage(...a),
}));

import { switchChatModel } from '../switch-model';

const prev = { id: 'm-old', name: 'Old', provider: 'p' } as never;
const next = { id: 'm-new', name: 'New', provider: 'p' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  peekHandoffPending.mockReturnValue(false);
});

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    prevModel: prev,
    nextModel: next,
    streaming: false,
    stopStream: async () => undefined,
    getMessages: () => [{ role: 'user', content: 'hi' }] as never,
    setMessages: vi.fn(),
    onModelApplied: vi.fn(),
    ...over,
  };
}

describe('switchChatModel handoff sequencing', () => {
  it('handoffReady resolves only after the server summary is marked pending', async () => {
    let resolveHandoff: (v: { summary: string }) => void = () => {};
    requestSessionHandoff.mockReturnValue(
      new Promise((r) => {
        resolveHandoff = r;
      }),
    );
    const opts = baseOpts();
    const result = await switchChatModel(opts);

    // The server call is in flight: pending NOT yet upgraded by the server.
    expect(markHandoffPending).not.toHaveBeenCalledWith(
      's1',
      expect.stringContaining('SERVER'),
      'm-old',
    );
    // Resolve the server handoff.
    resolveHandoff({ summary: 'SERVER CONTEXT' });
    await result.handoffReady;

    expect(markHandoffPending).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('SERVER CONTEXT'),
      'm-old',
    );
    expect(opts.setMessages).toHaveBeenCalled();
    expect(opts.onModelApplied).toHaveBeenCalledWith(next);
  });

  it('awaits handoff before the caller would auto-continue (no race)', async () => {
    const order: string[] = [];
    requestSessionHandoff.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('server-handoff-resolved');
      return { summary: 'S' };
    });
    const opts = baseOpts({
      streaming: true,
      setMessages: () => order.push('notice-card'),
    });
    const result = await switchChatModel(opts);
    // Simulate the caller: await handoffReady, THEN auto-continue.
    await result.handoffReady;
    order.push('auto-continue');
    expect(order.indexOf('server-handoff-resolved')).toBeLessThan(order.indexOf('auto-continue'));
    expect(order.indexOf('notice-card')).toBeLessThan(order.indexOf('auto-continue'));
  });

  it('falls back to local summary when the server call rejects', async () => {
    requestSessionHandoff.mockRejectedValue(new Error('boom'));
    const opts = baseOpts();
    const result = await switchChatModel(opts);
    await result.handoffReady;
    // Local fallback marked pending (buildHandoffSummary path).
    expect(markHandoffPending).toHaveBeenCalled();
    expect(opts.onModelApplied).toHaveBeenCalledWith(next);
  });

  it('no model change → handoffReady resolves immediately, no server call', async () => {
    const opts = baseOpts({ prevModel: next }); // same model
    const result = await switchChatModel(opts);
    await result.handoffReady;
    expect(requestSessionHandoff).not.toHaveBeenCalled();
    expect(opts.onModelApplied).toHaveBeenCalledWith(next);
  });
});
