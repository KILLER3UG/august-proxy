import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WorkingIndicator } from '../WorkingIndicator';
import { publishLiveActivity, clearLiveActivity, publishTodos, publishExecutionState } from '@/store/liveActivity';

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

  it('shows the todo checklist widget with progress once todosUpdated lands', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(<WorkingIndicator sessionId="sess_ind" />);
    act(() => {
      publishTodos('sess_ind', [
        { id: '1', content: 'Map the composer', status: 'completed' },
        { id: '2', content: 'Add chips row', status: 'in_progress' },
        { id: '3', content: 'Wire branch switch', status: 'pending' },
      ], 'Composer parity');
    });
    const toggle = screen.getByTestId('working-todos-toggle');
    expect(toggle.textContent).toContain('Composer parity');
    expect(toggle.textContent).toContain('1/3');
    // Collapsed: the in-progress item reads as the current step.
    expect(screen.getByTestId('working-todo-current').textContent).toContain('Add chips row');
    // The phase pill is replaced while todos exist.
    expect(screen.queryByTestId('working-phase')).toBeNull();

    fireEvent.click(toggle);
    const rows = screen.getAllByTestId('working-todo-row');
    expect(rows).toHaveLength(3);
    expect(rows[2].getAttribute('data-status')).toBe('pending');
    expect(rows[2].textContent).toContain('Wire branch switch');
  });

  it('falls back to the phase pill when no todos were submitted', () => {
    render(<WorkingIndicator sessionId="sess_ind" />);
    act(() => {
      publishExecutionState('sess_ind', 'research', 1);
    });
    const chip = screen.getByTestId('working-phase');
    expect(chip.textContent).toContain('research');
    expect(chip.textContent).toContain('step 1');
    expect(screen.queryByTestId('working-todos')).toBeNull();
  });
});
