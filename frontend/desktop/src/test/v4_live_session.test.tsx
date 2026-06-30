import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveSession } from '@/sections/live/useLiveSession';

describe('v4 — useLiveSession', () => {
  it('starts in idle state with empty transcript', () => {
    const { result } = renderHook(() => useLiveSession());
    expect(result.current.state).toBe('idle');
    expect(result.current.transcript).toBe('');
    expect(result.current.partialTranscript).toBe('');
    expect(result.current.toolEvents).toEqual([]);
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('transitions idle → listening on start()', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    expect(result.current.state).toBe('listening');
  });

  it('captures partial transcript while listening', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onPartial('Hello'));
    expect(result.current.partialTranscript).toBe('Hello');
    expect(result.current.state).toBe('listening');
  });

  it('commits final transcript → thinking', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onPartial('Hello world'));
    act(() => result.current.onFinal('Hello world'));
    expect(result.current.transcript).toBe('Hello world');
    expect(result.current.partialTranscript).toBe('');
    expect(result.current.state).toBe('thinking');
  });

  it('records tool events', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onFinal('read auth.py'));
    act(() => result.current.addToolEvent({ id: 't1', name: 'read_file', args: { path: 'auth.py' }, status: 'running' }));
    expect(result.current.toolEvents).toHaveLength(1);
    expect(result.current.toolEvents[0].status).toBe('running');
    act(() => result.current.updateToolEvent('t1', { status: 'done' }));
    expect(result.current.toolEvents[0].status).toBe('done');
  });

  it('approve() removes the mutation from pendingMutations', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.addPendingMutation({ id: 'm1', description: 'write auth.py' }));
    expect(result.current.pendingMutations).toHaveLength(1);
    act(() => result.current.approve('m1'));
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('deny() removes the mutation from pendingMutations', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.addPendingMutation({ id: 'm1', description: 'write auth.py' }));
    act(() => result.current.deny('m1'));
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('stop() resets to idle from any state', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onFinal('hi'));
    act(() => result.current.stop());
    expect(result.current.state).toBe('idle');
    expect(result.current.transcript).toBe('');
  });

  it('mute toggles isMuted without changing state', () => {
    const { result } = renderHook(() => useLiveSession());
    expect(result.current.isMuted).toBe(false);
    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(true);
    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(false);
  });
});
