import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueuePills } from '../QueuePills';

/* The overflow menu is a Radix portal. It is NOT opened here: Radix needs
 * PointerEvent plus a capture/release pair jsdom does not implement, and every
 * attempt to open it here tested the environment rather than this component.
 * What is asserted instead is the set of controls the pill renders PERMANENTLY,
 * which is the part C7 actually changed and the part jsdom can see. */

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
    // Edit moved behind the pill's own menu (spec §6.1 C7: cancel stays
    // permanent, everything else is one click away). The affordance is not
    // gone — it just stopped being a second permanent control on every row.
    // C7: a queued message keeps exactly two permanent controls — cancel, and the
    // overflow that holds move/promote/edit. Before, every pill also carried a
    // permanent grip, a promote button and an inline edit button.
    expect(screen.getByLabelText('Cancel queued message')).toBeTruthy();
    expect(screen.getByLabelText('More options for queued message 1')).toBeTruthy();
    expect(screen.queryByLabelText('Edit queued message')).toBeNull();
    expect(screen.queryByLabelText('Promote to direction')).toBeNull();
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
