import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { queryClient } from '@/query-client';
import { SubagentLaunchList } from '../SubagentLaunchList';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';

function wrap(ui: React.ReactElement) {
  return (
    <MemoryRouter initialEntries={['/chat/sess-1']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/chat/:sessionId" element={ui} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

vi.mock('@/components/shell/RightDrawerState', () => ({
  addRightDrawerSection: vi.fn(),
}));

import { addRightDrawerSection } from '@/components/shell/RightDrawerState';

function makeAgent(
  overrides: Partial<SubagentBlockState> & Pick<SubagentBlockState, 'jobId'>,
): SubagentBlockState {
  return {
    id: `sb_${overrides.jobId}`,
    parentToolId: 'tool-1',
    agentId: 'explore',
    task: 'Find scroll-down button bug',
    status: 'completed',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    blocks: [],
    ...overrides,
  };
}

describe('SubagentLaunchList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarizes workers without listing every lane in the thread', () => {
    const agents = [
      makeAgent({ jobId: 'j1', task: 'Find scroll-down button bug', status: 'completed' }),
      makeAgent({ jobId: 'j2', task: 'Find empty folder switch bug', status: 'running' }),
    ];
    render(wrap(<SubagentLaunchList agents={agents} modelLabel="Claude Sonnet 4" />));

    expect(screen.getByTestId('subagent-launch-open-sidebar')).toHaveTextContent('1 worker running');
    expect(screen.getByText('Open in sidebar')).toBeInTheDocument();
    expect(screen.queryByText('Find scroll-down button bug')).not.toBeInTheDocument();
    expect(screen.queryByText('Workers')).not.toBeInTheDocument();
  });

  it('opens the workers drawer on click', () => {
    const agents = [
      makeAgent({
        jobId: 'j1',
        task: 'Find empty folder switch bug',
        status: 'completed',
      }),
    ];
    render(wrap(<SubagentLaunchList agents={agents} />));

    fireEvent.click(screen.getByTestId('subagent-launch-open-sidebar'));
    expect(addRightDrawerSection).toHaveBeenCalledWith('subagents');
    expect(screen.queryByTestId('subagent-expanded-card')).not.toBeInTheDocument();
  });
});
