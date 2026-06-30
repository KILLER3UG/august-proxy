import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveApprovalCard } from '@/sections/live/LiveApprovalCard';

describe('v4 — LiveApprovalCard', () => {
  it('renders the mutation description', () => {
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={() => {}}
        onDeny={() => {}}
        onVoiceConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/Write auth\.py/)).toBeTruthy();
  });

  it('fires onApprove when the Approve button is clicked', () => {
    const onApprove = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={onApprove}
        onDeny={() => {}}
        onVoiceConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalledWith('m1');
  });

  it('fires onDeny when Deny is clicked', () => {
    const onDeny = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={() => {}}
        onDeny={onDeny}
        onVoiceConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Deny'));
    expect(onDeny).toHaveBeenCalledWith('m1');
  });

  it('fires onVoiceConfirm when "voice confirm" is clicked (no spoken path yet)', () => {
    const onVoiceConfirm = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py', spokenPrompt: 'May I write auth.py?' }}
        onApprove={() => {}}
        onDeny={() => {}}
        onVoiceConfirm={onVoiceConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('voice-confirm'));
    expect(onVoiceConfirm).toHaveBeenCalledWith('m1');
  });
});
