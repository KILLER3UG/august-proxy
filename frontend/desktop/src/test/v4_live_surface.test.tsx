import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Stub the speech factory so tests don't actually open a mic.
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

// Stub the live client so we don't hit the network.
vi.mock('@/api/liveClient', () => ({
  liveClient: {
    startSession: vi.fn().mockResolvedValue('live_test'),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sendTurn: vi.fn().mockResolvedValue('Processing: hi'),
    transcribe: vi.fn().mockResolvedValue({ transcript: '', partial: false }),
    synthesize: vi.fn().mockResolvedValue({ audio: null, format: 'mp3' }),
  },
}));

import { LiveSurface } from '@/sections/live/LiveSurface';

describe('v4 — LiveSurface', () => {
  it('renders the orb, captions, controls, and tool rail', () => {
    render(<LiveSurface onSwitchToChat={() => {}} />);
    expect(screen.getByTestId('live-orb')).toBeTruthy();
    expect(screen.getByTestId('live-captions')).toBeTruthy();
    expect(screen.getByTestId('live-controls')).toBeTruthy();
    expect(screen.getByTestId('live-tool-rail')).toBeTruthy();
  });

  it('renders an approval card when pendingMutations is non-empty', () => {
    render(
      <LiveSurface
        onSwitchToChat={() => {}}
        pendingMutations={[{ id: 'm1', description: 'Write auth.py' }]}
      />,
    );
    expect(screen.getByTestId('live-approval-card')).toBeTruthy();
  });

  it('calls onSwitchToChat when Switch to chat is clicked', () => {
    const onSwitch = vi.fn();
    render(<LiveSurface onSwitchToChat={onSwitch} />);
    fireEvent.click(screen.getByText(/switch to chat/i));
    expect(onSwitch).toHaveBeenCalled();
  });

  it('starts STT and transitions to listening when the Start button is clicked', async () => {
    render(<LiveSurface onSwitchToChat={() => {}} />);
    fireEvent.click(screen.getByTestId('start-listening'));
    await waitFor(() => {
      expect(screen.getByTestId('live-orb').getAttribute('data-state')).toBe('listening');
    });
  });
});
