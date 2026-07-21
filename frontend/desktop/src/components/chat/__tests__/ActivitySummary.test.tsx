import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivitySummary } from '../ActivitySummary';

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
