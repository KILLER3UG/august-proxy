import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivitySummary, buildCompletionSummary } from '../ActivitySummary';

describe('ActivitySummary live indicator', () => {
  it('shows a pulse next to the chevron when collapsed and live', () => {
    render(
      <ActivitySummary
        thoughtCount={1}
        summary="The user wants to understand how the model is being trained"
        live
        liveDetail="Working…"
        collapseWhen
      >
        <div>body</div>
      </ActivitySummary>,
    );

    // collapseWhen forces closed on mount via effect — click open then closed if needed
    expect(screen.getByTestId('activity-summary-live-indicator')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides the header pulse when expanded', () => {
    render(
      <ActivitySummary
        thoughtCount={1}
        summary="Planning next steps"
        live
        defaultOpen
      >
        <div>body</div>
      </ActivitySummary>,
    );

    expect(screen.queryByTestId('activity-summary-live-indicator')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides the header pulse when not live', () => {
    render(
      <ActivitySummary thoughtCount={1} summary="Settled thought" collapseWhen>
        <div>body</div>
      </ActivitySummary>,
    );
    expect(screen.queryByTestId('activity-summary-live-indicator')).toBeNull();
  });

  it('toggles expand and shows pulse only while collapsed+live', () => {
    render(
      <ActivitySummary
        thoughtCount={1}
        summary="Exploring workspace"
        live
        defaultOpen
      >
        <div>inner</div>
      </ActivitySummary>,
    );
    const btn = screen.getByRole('button');
    expect(screen.queryByTestId('activity-summary-live-indicator')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('activity-summary-live-indicator')).toBeInTheDocument();
  });
});

describe('buildCompletionSummary — §9 aggregate tally', () => {
  it('joins files, searches, and commands with an Oxford "and"', () => {
    expect(
      buildCompletionSummary({ thoughtCount: 0, filesTouched: 1, searches: 1, commands: 1 }),
    ).toBe('1 file, 1 search, and 1 command');
  });

  it('pluralizes non-single counts', () => {
    expect(
      buildCompletionSummary({ thoughtCount: 0, filesTouched: 3, searches: 2, commands: 4 }),
    ).toBe('3 files, 2 searches, and 4 commands');
  });

  it('omits zero counts and pairs with "and"', () => {
    expect(
      buildCompletionSummary({ thoughtCount: 0, filesTouched: 1, commands: 2 }),
    ).toBe('1 file and 2 commands');
    expect(buildCompletionSummary({ thoughtCount: 0, filesTouched: 2 })).toBe('2 files');
  });

  it('falls back to steps, then empty string', () => {
    expect(buildCompletionSummary({ thoughtCount: 0, toolsCount: 3 })).toBe('3 steps');
    expect(buildCompletionSummary({ thoughtCount: 2 })).toBe('');
  });
});

describe('ActivitySummary completion mode (§9 bar)', () => {
  it('renders a collapsed "Task completed" bar with tally and elapsed time', () => {
    render(
      <ActivitySummary
        thoughtCount={1}
        toolsCount={3}
        filesTouched={1}
        searches={1}
        commands={1}
        durationLabel="6s"
        mode="completion"
        collapseWhen
      >
        <div>task blocks</div>
      </ActivitySummary>,
    );

    const root = document.querySelector('[data-slot="activity-summary"]');
    expect(root).toHaveAttribute('data-mode', 'completion');
    // Collapsed by default once the sequence completes.
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Task completed')).toBeInTheDocument();
    expect(screen.getByText('1 file, 1 search, and 1 command')).toBeInTheDocument();
    expect(screen.getByText('6s')).toBeInTheDocument();

    // Expanding reveals the wrapped blocks.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('task blocks')).toBeInTheDocument();
  });

  it('shows an alert accent when some tool calls errored', () => {
    render(
      <ActivitySummary
        thoughtCount={0}
        toolsCount={1}
        commands={1}
        errors={1}
        mode="completion"
        collapseWhen
      >
        <div>x</div>
      </ActivitySummary>,
    );
    expect(screen.getByLabelText('Some steps failed')).toBeInTheDocument();
  });
});
