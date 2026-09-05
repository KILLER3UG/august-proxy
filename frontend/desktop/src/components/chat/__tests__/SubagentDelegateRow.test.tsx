import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentDelegateRow } from '@/components/chat/SubagentDelegateRow';
import { ExploreGroup } from '@/components/chat/ExploreGroup';

vi.mock('@/components/shell/RightDrawerState', () => ({
  addRightDrawerSection: vi.fn(),
}));
vi.mock('@/components/chat/focused-subagent', () => ({
  setFocusedSubagent: vi.fn(),
  useFocusedSubagent: () => null,
}));

describe('SubagentDelegateRow (Part 27 A1)', () => {
  it('renders role + task + Failed status and is clickable', () => {
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="general"
        task="Audit Part 17 memory plan"
        status="failed"
        startedAt={Date.now() - 5000}
      />,
    );
    const row = screen.getByTestId('subagent-delegate-row');
    expect(row.textContent).toContain('SubAgent');
    expect(row.textContent).toContain('General');
    expect(row.textContent).toContain('Audit Part 17 memory plan');
    expect(row.textContent).toContain('Failed');
    fireEvent.click(row);
  });

  it('shows a live elapsed timer while running', () => {
    render(
      <SubagentDelegateRow
        jobId="job-2"
        agentId="general"
        task="long task"
        status="running"
        startedAt={Date.now() - 3000}
      />,
    );
    const row = screen.getByTestId('subagent-delegate-row');
    expect(row.getAttribute('data-subagent-status')).toBe('running');
    expect(row.textContent).toMatch(/\ds/);
  });
});

describe('ExploreGroup (Part 27 B1)', () => {
  it('labels counts and collapses children by default', () => {
    render(
      <ExploreGroup searches={1} files={2} running={false} groupKey="g1">
        <div>child-a</div>
        <div>child-b</div>
      </ExploreGroup>,
    );
    const head = screen.getByTestId('explore-group-head');
    expect(head.textContent).toContain('Explore · 1 search, 2 files');
    expect(screen.queryByText('child-a')).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText('child-a')).toBeTruthy();
  });

  it('stays open while running', () => {
    render(
      <ExploreGroup searches={0} files={3} running groupKey="g2">
        <div>child-c</div>
      </ExploreGroup>,
    );
    expect(screen.getByText('child-c')).toBeTruthy();
  });
});
