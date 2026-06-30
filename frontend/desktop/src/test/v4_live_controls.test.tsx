import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveControls } from '@/sections/live/LiveControls';

describe('v4 — LiveControls', () => {
  it('renders Mute, End, push-to-talk toggle, and Switch to chat', () => {
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    expect(screen.getByText(/mute/i)).toBeTruthy();
    expect(screen.getByText(/end/i)).toBeTruthy();
    expect(screen.getByText(/switch to chat/i)).toBeTruthy();
  });

  it('calls onToggleMute when Mute is clicked', () => {
    const onToggleMute = vi.fn();
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={onToggleMute}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/^mute$|^Mute$/));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it('shows "Unmute" when isMuted is true', () => {
    render(
      <LiveControls
        isMuted={true}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    expect(screen.getByText(/^Unmute$/)).toBeTruthy();
  });

  it('calls onEnd when End is clicked', () => {
    const onEnd = vi.fn();
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={onEnd}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/^End$/));
    expect(onEnd).toHaveBeenCalled();
  });
});
