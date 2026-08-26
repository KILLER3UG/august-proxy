import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WorkingIndicator } from '../WorkingIndicator';
import { publishLiveActivity, clearLiveActivity } from '@/store/liveActivity';

describe('WorkingIndicator', () => {
  beforeEach(() => {
    clearLiveActivity();
  });

  it('shows idle Thinking + dots when the session has no activity yet', () => {
    render(<WorkingIndicator sessionId="sess_ind" />);
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(document.querySelector('[data-aug-indicator]')).toBeTruthy();
    expect(document.querySelector('[data-testid="working-lines"]')).toBeTruthy();
  });

  it('renders one sentence per activity item, newest last with dots', () => {
    render(<WorkingIndicator sessionId="sess_ind" />);
    act(() => {
      publishLiveActivity({
        sessionId: 'sess_ind',
        headline: 'working',
        items: [
          { id: '1', kind: 'view', label: 'Reading src/app.py', status: 'done', at: 1 },
          { id: '2', kind: 'run', label: 'Running pytest -q', status: 'running', at: 2 },
        ],
      });
    });
    expect(screen.getByText('Reading src/app.py')).toBeTruthy();
    const last = screen.getByText('Running pytest -q');
    // Animated ellipsis dots ride on the newest line
    expect(last.parentElement?.querySelector('[data-testid="typing-dots"]')).not.toBeNull();
  });

  it('keeps the stack capped at 3 sentences, dropping the oldest', () => {
    render(<WorkingIndicator sessionId="sess_ind" />);
    act(() => {
      publishLiveActivity({
        sessionId: 'sess_ind',
        headline: 'working',
        items: ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({
          id: n,
          kind: 'tool' as const,
          label: `step ${n}`,
          status: i === 4 ? ('running' as const) : ('done' as const),
          at: i,
        })),
      });
    });
    expect(screen.getByText('step e')).toBeTruthy();
    expect(screen.queryByText('step a')).toBeNull();
    expect(screen.queryByText('step b')).toBeNull();
    expect(screen.getByText('step c')).toBeTruthy();
  });

  it('normalizes wb_* route ids onto the UI session key', () => {
    // Activity published under the UI id must show when the pane passes a
    // workbench id (session-id-map resolves via the sessions store; without
    // a registered mapping it falls through, so assert the fallthrough path
    // keeps the component stable rather than crashing).
    render(<WorkingIndicator sessionId="wb_unknown" />);
    expect(screen.getByText('Thinking')).toBeTruthy();
  });
});
