import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentDelegateRow } from '@/components/chat/SubagentDelegateRow';
import { ExploreGroup } from '@/components/chat/ExploreGroup';
import type { SubagentBlockState } from '@/types/chat';

vi.mock('@/components/shell/RightDrawerState', () => ({
  addRightDrawerSection: vi.fn(),
}));
vi.mock('@/components/chat/focused-subagent', () => ({
  setFocusedSubagent: vi.fn(),
  useFocusedSubagent: () => null,
}));

function workerState(overrides: Partial<SubagentBlockState> = {}): SubagentBlockState {
  return {
    id: 'sb_job-1',
    jobId: 'job-1',
    parentToolId: 'toolu_spawn',
    agentId: 'research',
    task: 'Audit the memory plan',
    status: 'completed',
    startedAt: 1_000,
    blocks: [
      { id: 'b_think_0', type: 'thinking', content: 'reading the migration list' },
      { id: 'b_out_0', type: 'finalOutput', content: 'The plan has three gaps.' },
    ],
    ...overrides,
  };
}

describe('SubagentDelegateRow', () => {
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

describe('SubagentDelegateRow — inline transcript', () => {
  it('collapses a settled worker by default and expands on click', () => {
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="research"
        task="Audit the memory plan"
        status="completed"
        state={workerState()}
      />,
    );
    expect(screen.queryByTestId('subagent-delegate-body')).toBeNull();

    fireEvent.click(screen.getByTestId('subagent-delegate-toggle'));

    const body = screen.getByTestId('subagent-delegate-body');
    expect(body.textContent).toContain('The plan has three gaps.');
    expect(screen.getByTestId('subagent-delegate-row').getAttribute('data-expanded')).toBe('true');
  });

  it('renders the restored worker timeline with no live SSE present', () => {
    // This is the reload case: the transcript carries the worker's own
    // blocks, so the row still shows its output inline.
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="research"
        task="Audit the memory plan"
        status="completed"
        state={workerState()}
        defaultExpanded
      />,
    );
    expect(screen.getByTestId('subagent-delegate-body').textContent).toContain(
      'The plan has three gaps.',
    );
  });

  it('auto-expands a running worker so the user watches it work', () => {
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="research"
        task="Audit the memory plan"
        status="running"
        state={workerState({ status: 'running', blocks: [{ id: 'b1', type: 'text', content: 'thinking' } as never] })}
      />,
    );
    expect(screen.getByTestId('subagent-delegate-body')).toBeTruthy();
  });

  it('keeps the drawer reachable when expanded', () => {
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="research"
        task="Audit"
        status="completed"
        state={workerState()}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-delegate-open-drawer'));
    // Clicking the drawer affordance must not collapse the inline transcript.
    expect(screen.getByTestId('subagent-delegate-body')).toBeTruthy();
  });

  it('falls back to the drawer when the worker has no transcript', () => {
    render(
      <SubagentDelegateRow
        jobId="job-1"
        agentId="research"
        task="Audit"
        status="running"
        state={workerState({ status: 'running', blocks: [] })}
      />,
    );
    // No transcript → status-only row, no disclosure chevron.
    expect(screen.queryByTestId('subagent-delegate-toggle')).toBeNull();
    expect(screen.queryByTestId('subagent-delegate-body')).toBeNull();
  });
});

describe('ExploreGroup', () => {
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
