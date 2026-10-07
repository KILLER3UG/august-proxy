import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueuePills } from '../QueuePills';

const RECEIPT = [
  '[SUBAGENT_COMPLETE taskId="task_e7bae7f9024d" agentId="general" status="failed"]',
  'goal: Review uncommitted working-tree changes + UI scan doc myself',
  'I could not complete this: permission denied',
  '[/SUBAGENT_COMPLETE]',
].join('\n');

const renderWith = (text: string) =>
  render(
    <QueuePills
      sessionId="s1"
      workbenchSessionId="wb_1"
      items={[{ id: 'q1', text, queuedAt: '2026-10-04T00:00:00Z' }]}
    />,
  );

describe('QueuePills subagent receipts', () => {
  it('renders the envelope as a plain-language receipt, not raw protocol text', () => {
    renderWith(RECEIPT);
    const pill = screen.getByTestId('queue-pills');
    expect(pill.textContent).not.toContain('SUBAGENT_COMPLETE');
    expect(pill.textContent).not.toContain('task_e7bae7f9024d');
    expect(pill.textContent).toContain('Receipt');
    expect(pill.textContent).toContain('Subagent failed');
    expect(pill.textContent).toContain('Review uncommitted working-tree changes');
  });

  it('offers no edit or promote affordance on a machine receipt', () => {
    renderWith(RECEIPT);
    expect(screen.queryByLabelText('Edit queued message')).toBeNull();
    expect(screen.queryByLabelText('Promote to direction')).toBeNull();
    // Cancelling an undelivered receipt is still legitimate.
    expect(screen.getByLabelText('Cancel queued message')).toBeTruthy();
  });

  it('leaves an ordinary queued message untouched', () => {
    renderWith('also check the scroll behaviour');
    const pill = screen.getByTestId('queue-pills');
    expect(pill.textContent).toContain('Queued');
    expect(pill.textContent).toContain('also check the scroll behaviour');
    expect(screen.getByLabelText('Edit queued message')).toBeTruthy();
  });

  it('keeps the failure reason reachable on a receipt pill', () => {
    renderWith(RECEIPT);
    // The line is status + goal only, so the cause the model was handed has to
    // survive somewhere — receipts used to suppress the tooltip entirely, which
    // left "Subagent failed" with no way to find out why.
    const pill = screen.getByTestId('queue-pills');
    expect(pill.textContent).not.toContain('permission denied');
    expect(screen.getByTitle('I could not complete this: permission denied')).toBeTruthy();
  });
});
