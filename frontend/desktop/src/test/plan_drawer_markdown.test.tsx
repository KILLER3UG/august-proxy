/* Plan drawer — renders the model's own markdown, chat formatting, no
 * app-imposed structure (Steps/Files/Risks/Verification are gone). */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RightDrawerPlanSection } from '@/components/shell/RightDrawerPlanSection';
import type { WorkbenchSession } from '@/types/workbench';

function sessionWithPlan(plan: Record<string, unknown>): WorkbenchSession {
  return { plan } as unknown as WorkbenchSession;
}

describe('RightDrawerPlanSection', () => {
  it('renders the model markdown with assistant chat formatting', () => {
    const session = sessionWithPlan({
      markdown: '## Refactor plan\n\n- extract the hook\n- update callers',
      planPath: '.aug/plans/plan.md',
    });

    const { container } = render(<RightDrawerPlanSection session={session} />);

    expect(screen.getByText('Refactor plan')).toBeTruthy();
    expect(screen.getByText('extract the hook')).toBeTruthy();
    // Same Markdown variant as assistant messages.
    expect(container.querySelector('.markdown-content--assistant')).toBeTruthy();
    // The plan file path is surfaced for reference.
    expect(screen.getByText('.aug/plans/plan.md')).toBeTruthy();
  });

  it('ignores legacy structured arrays — no Steps/Files/Risks/Verification', () => {
    const session = sessionWithPlan({
      markdown: '# The only plan',
      steps: ['should not render'],
      files: ['should not render either'],
      risks: ['nor this'],
      verification: ['nor that'],
    });

    render(<RightDrawerPlanSection session={session} />);

    expect(screen.getByText('The only plan')).toBeTruthy();
    expect(screen.queryByText('Steps')).toBeNull();
    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.queryByText('Risks')).toBeNull();
    expect(screen.queryByText('Verification')).toBeNull();
    expect(screen.queryByText('should not render')).toBeNull();
  });

  it('shows the empty state when there is no plan', () => {
    render(<RightDrawerPlanSection session={null} />);
    expect(screen.getByText('No plan yet')).toBeTruthy();
  });
});
