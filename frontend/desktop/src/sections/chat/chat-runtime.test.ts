import { describe, expect, it } from 'vitest';
import { createChatRuntime } from './chat-runtime';

describe('chat runtime session isolation', () => {
  it('allows different sessions to stream concurrently', () => {
    const runtime = createChatRuntime();
    const a = runtime.startTurn({ sessionId: 'a', assistantMsgId: 'a1' });
    const _b = runtime.startTurn({ sessionId: 'b', assistantMsgId: 'b1' });

    expect(runtime.isSessionStreaming('a')).toBe(true);
    expect(runtime.isSessionStreaming('b')).toBe(true);
    expect(runtime.canStartTurn('a')).toBe(false);
    expect(runtime.canStartTurn('b')).toBe(false);

    runtime.finishTurn(a.turnId, 'done');

    expect(runtime.isSessionStreaming('a')).toBe(false);
    expect(runtime.isSessionStreaming('b')).toBe(true);
  });

  it('blocks duplicate turns within the same session', () => {
    const runtime = createChatRuntime();
    const first = runtime.startTurn({ sessionId: 'a', assistantMsgId: 'a1' });
    const second = runtime.startTurn({ sessionId: 'a', assistantMsgId: 'a2' });

    expect(second.turnId).toBe(first.turnId);
    expect(runtime.getActiveTurn('a')?.assistantMsgId).toBe('a1');
    expect(runtime.canStartTurn('a')).toBe(false);
  });

  it('force starts a new turn after aborting the previous one', () => {
    const runtime = createChatRuntime();
    const first = runtime.startTurn({ sessionId: 'a', assistantMsgId: 'a1' });
    const second = runtime.startTurn({
      sessionId: 'a',
      assistantMsgId: 'a2',
      force: true,
    });

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.turnId).not.toBe(first.turnId);
    expect(runtime.getActiveTurn('a')?.assistantMsgId).toBe('a2');
  });
});
