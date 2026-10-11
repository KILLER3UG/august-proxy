import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HistoryLoadError, RosterError } from '../TranscriptErrorStates';

/* A failed history load used to render nothing — the pane was simply blank,
 * which is indistinguishable from a chat that was deleted — and a failed
 * sub-agent roster left stale rows with no explanation and nothing to press.
 * These are the two states that replaced the silence. */

describe('HistoryLoadError', () => {
  it('names the failure and shows the reason', () => {
    render(<HistoryLoadError error="HTTP 502 from /api/sessions/x/history" onRetry={vi.fn()} />);
    expect(screen.getByText("Couldn't load this conversation")).toBeTruthy();
    expect(screen.getByText('HTTP 502 from /api/sessions/x/history')).toBeTruthy();
  });

  it('offers a retry that calls through', () => {
    const onRetry = vi.fn();
    render(<HistoryLoadError error="boom" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('RosterError', () => {
  it('stays quiet — the transcript below it is still real', () => {
    render(<RosterError onRetry={vi.fn()} />);
    const el = screen.getByTestId('roster-error');
    // Announced without stealing focus from the conversation.
    expect(el.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(el.textContent).toContain('temporarily unavailable');
  });

  it('offers a retry instead of only waiting out the poll', () => {
    // The 10s refetch would recover on its own, but a note that says
    // "retrying" with nothing to press leaves the user watching a stale list.
    const onRetry = vi.fn();
    render(<RosterError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});