import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConversationStage } from '../ConversationStage';
import type { ConversationScript } from '@/lib/conversations';

const SCRIPT: ConversationScript = {
  id: 'test',
  beats: [
    { role: 'user', text: 'spin it up' },
    { role: 'assistant', text: 'booting now', live: true },
    { role: 'assistant', text: 'all ready', gate: 'ready' },
  ],
};

function renderStage(ready: boolean, onDone = vi.fn()) {
  const utils = render(
    <ConversationStage
      script={SCRIPT}
      ready={ready}
      liveLabel="Starting backend"
      onDone={onDone}
      pillText="starting backend"
      pillState="busy"
      composerHint="The app opens when ready"
    />,
  );
  return { ...utils, onDone };
}

describe('ConversationStage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reveals beats one by one but holds the ready-gated beat', () => {
    const { container } = renderStage(false);
    expect(screen.queryByTestId('conv-user')).toBeNull();

    act(() => vi.advanceTimersByTime(300)); // first beat
    expect(screen.getByTestId('conv-user')).toBeTruthy();

    act(() => vi.advanceTimersByTime(600)); // second (live) beat
    expect(screen.getByTestId('conv-assistant')).toBeTruthy();
    expect(container.textContent).toContain('booting now');

    // The gated closing line stays hidden while the backend is not ready.
    expect(container.textContent).not.toContain('all ready');
  });

  it('reveals every beat and calls onDone when ready from the start', () => {
    const { container, onDone } = renderStage(true);
    act(() => vi.advanceTimersByTime(400)); // first beat
    act(() => vi.advanceTimersByTime(400)); // live beat
    act(() => vi.advanceTimersByTime(400)); // gated closing beat (fast, ready)
    expect(container.textContent).toContain('all ready');
    act(() => vi.advanceTimersByTime(900)); // hold, then finish
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Skip finishes immediately', () => {
    const { onDone } = renderStage(false);
    fireEvent.click(screen.getByTestId('conversation-skip'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('revealOnReady converges the whole thread and finishes fast', () => {
    const onDone = vi.fn();
    const { container } = render(
      <ConversationStage
        script={SCRIPT}
        ready
        revealOnReady
        onDone={onDone}
        pillText="ready"
        pillState="ok"
        composerHint="Opening"
      />,
    );
    // A warm start (ready at mount) snaps to the full thread, then reveals.
    act(() => vi.advanceTimersByTime(120));
    expect(container.textContent).toContain('all ready');
    act(() => vi.advanceTimersByTime(600));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
