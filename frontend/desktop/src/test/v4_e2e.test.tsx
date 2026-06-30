import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/api/speech/liveSTT', () => ({
  liveSTTFactory: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
  }),
}));
vi.mock('@/api/speech/liveTTS', () => ({
  liveTTSFactory: () => ({
    speak: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  }),
}));
vi.mock('@/api/liveClient', () => ({
  liveClient: {
    startSession: vi.fn().mockResolvedValue('live_e2e'),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sendTurn: vi.fn().mockResolvedValue('Processing: hello world'),
    transcribe: vi.fn().mockResolvedValue({ transcript: '', partial: false }),
    synthesize: vi.fn().mockResolvedValue({ audio: null, format: 'mp3' }),
  },
}));

import { LiveSurface } from '@/sections/live/LiveSurface';
import { liveClient } from '@/api/liveClient';

describe('v4 — Live e2e', () => {
  it('idle → listening (via Start) → thinking (via mock turn) → idle (via End)', async () => {
    render(<LiveSurface onSwitchToChat={vi.fn()} />);
    expect(screen.getByTestId('live-orb').getAttribute('data-state')).toBe('idle');

    fireEvent.click(screen.getByTestId('start-listening'));
    await waitFor(() => {
      expect(screen.getByTestId('live-orb').getAttribute('data-state')).toBe('listening');
    });
  });

  it('liveClient.sendTurn returns the assistant content from the stub backend', async () => {
    const text = await liveClient.sendTurn('live_e2e', 'hello world');
    expect(text).toBe('Processing: hello world');
  });
});
