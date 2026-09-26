/* ── QueryErrorState: the shared failure card ──────────────────────────────
 * One rule: a failure is never dressed up as an empty result, and there is
 * always a way back (Retry) when the caller can offer one.                */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryErrorState, queryErrorMessage } from '../QueryErrorState';

describe('queryErrorMessage', () => {
  it('reads Error, string, {message}, and ApiError-ish shapes', () => {
    expect(queryErrorMessage(new Error('boom'))).toBe('boom');
    expect(queryErrorMessage('plain failure')).toBe('plain failure');
    expect(queryErrorMessage({ message: 'from object' })).toBe('from object');
    expect(queryErrorMessage({ error: 'from error key' })).toBe('from error key');
    expect(queryErrorMessage({ status: 503 })).toBe('Request failed (HTTP 503).');
  });

  it('never renders an unnamed failure', () => {
    expect(queryErrorMessage(undefined)).toBe('The request failed.');
    expect(queryErrorMessage(new Error('   '))).toBe('The request failed.');
    expect(queryErrorMessage({})).toBe('The request failed.');
    expect(queryErrorMessage(undefined, 'custom')).toBe('custom');
  });
});

describe('QueryErrorState', () => {
  it('shows the reason, the not-empty note, and calls Retry', () => {
    const onRetry = vi.fn();
    render(
      <QueryErrorState error={new Error('automations: 503')} title="Couldn't load automations" onRetry={onRetry} />,
    );
    const alert = screen.getByTestId('query-error-state');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('query-error-message').textContent).toBe('automations: 503');
    expect(alert.textContent).toContain('not an empty result');
    fireEvent.click(screen.getByTestId('query-error-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables Retry and says so while the retry is in flight', () => {
    render(<QueryErrorState error={new Error('x')} onRetry={vi.fn()} retrying />);
    const button = screen.getByTestId<HTMLButtonElement>('query-error-retry');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Retrying');
  });
});
