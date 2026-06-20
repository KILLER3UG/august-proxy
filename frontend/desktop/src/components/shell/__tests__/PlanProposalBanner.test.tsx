/* ── PlanProposalBanner test — submit/Revise flow ──────────────────── */
/* Smoke test: rendering the banner with a pending plan shows the
 * Revise… button. Clicking it opens the textarea. Typing feedback and
 * clicking Send invokes `onRevise` exactly once with the typed text.
 * The Send button is disabled when feedback is empty or while sending.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanProposalBanner } from '../PlanProposalBanner';
import type { WorkbenchSession } from '@/types/workbench';

const baseSession: WorkbenchSession = {
  id: 'wb_test',
  provider: 'claude',
  agentId: 'build',
  agentRole: 'build',
  agentMode: 'assistant',
  approved: false,
  approvedAt: null,
  plan: {
    id: 'plan_test',
    summary: 'A short plan summary.',
    steps: ['Step 1', 'Step 2'],
    files: ['src/example.ts'],
    risks: [],
    verification: [],
    createdAt: new Date().toISOString(),
  },
  goal: null,
  lastGoal: null,
  messageCount: 0,
  mutationCount: 0,
  lastMutationAt: null,
  updatedAt: new Date().toISOString(),
  todos: [],
  guardMode: 'plan',
};

describe('PlanProposalBanner — Revise submit flow', () => {
  it('enables Send when feedback is present and calls onRevise on click', () => {
    const onRevise = vi.fn().mockResolvedValue(undefined);
    render(
      <PlanProposalBanner
        workbenchSession={baseSession}
        onOpenPlan={() => {}}
        onAccept={() => {}}
        onAcceptAndImplement={() => {}}
        onReject={() => {}}
        onRevise={onRevise}
        sending={false}
      />
    );

    // Open the revise form.
    fireEvent.click(screen.getByRole('button', { name: /Revise/i }));

    // Send should be disabled before any feedback is typed.
    const sendButton = screen.getByRole('button', { name: /Send/i });
    expect(sendButton).toBeDisabled();

    // Type feedback.
    const textarea = screen.getByPlaceholderText(/What would you like to change/i);
    fireEvent.change(textarea, { target: { value: 'add a verification step' } });

    // Send should now be enabled.
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(onRevise).toHaveBeenCalledTimes(1);
    expect(onRevise).toHaveBeenCalledWith('add a verification step');
  });

  it('disables Send while sending is true', () => {
    const onRevise = vi.fn();
    render(
      <PlanProposalBanner
        workbenchSession={baseSession}
        onOpenPlan={() => {}}
        onAccept={() => {}}
        onAcceptAndImplement={() => {}}
        onReject={() => {}}
        onRevise={onRevise}
        sending={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Revise/i }));
    const textarea = screen.getByPlaceholderText(/What would you like to change/i);
    fireEvent.change(textarea, { target: { value: 'feedback' } });

    const sendButton = screen.getByRole('button', { name: /Send/i });
    expect(sendButton).toBeDisabled();
  });
});
