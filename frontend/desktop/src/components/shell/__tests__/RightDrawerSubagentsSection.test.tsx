import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorkbenchSessionAgents } from '@/api/workbench';
import { RightDrawerSubagentsSection } from '../RightDrawerSubagentsSection';

vi.mock('@/api/workbench', () => ({
  listWorkbenchSessionAgents: vi.fn(),
}));

vi.mock('@/api/subagents', () => ({
  listWorkstreams: vi.fn().mockResolvedValue([]),
  listWorkstreamEpisodes: vi.fn().mockResolvedValue([]),
  terminate: vi.fn(),
  stopAll: vi.fn(),
  steer: vi.fn(),
  continueWorkstream: vi.fn(),
}));

vi.mock('@/components/chat/SubagentTimeline', () => ({
  SubagentTimeline: () => <div data-testid="subagent-timeline">Live subagent timeline</div>,
}));

const listAgentsMock = vi.mocked(listWorkbenchSessionAgents);

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RightDrawerSubagentsSection
        sessionId="session-1"
        workbenchSessionId="workbench-1"
      />
    </QueryClientProvider>,
  );
}

describe('RightDrawerSubagentsSection', () => {
  beforeEach(() => {
    listAgentsMock.mockResolvedValue({
      agents: [
        {
          taskId: 'goodall-1',
          agentId: 'goodall',
          goal: 'Inspect the backend flow',
          status: 'running',
        },
      ],
      meta: {},
    });
  });

  it('expands a subagent row to show its live detail area', async () => {
    renderSection();

    const row = await screen.findByTestId('right-drawer-subagent-goodall-1');
    expect(screen.queryByTestId('right-drawer-subagent-detail-goodall-1')).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(await screen.findByTestId('right-drawer-subagent-view-goodall-1')).toBeInTheDocument();
    expect(screen.getByText('Waiting for subagent output…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove subagent view' }));
    expect(screen.queryByTestId('right-drawer-subagent-view-goodall-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-drawer-subagent-goodall-1'));
    expect(screen.getByTestId('right-drawer-subagent-view-goodall-1')).toBeInTheDocument();
  });
});
