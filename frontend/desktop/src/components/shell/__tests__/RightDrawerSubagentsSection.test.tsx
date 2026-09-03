import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorkbenchSessionAgents } from '@/api/workbench';
import { RightDrawerSubagentsSection } from '../RightDrawerSubagentsSection';

vi.mock('@/api/workbench', () => ({
  listWorkbenchSessionAgents: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ messages: [] }),
  },
}));

vi.mock('@/api/subagents', () => ({
  listWorkstreams: vi.fn().mockResolvedValue([]),
  listWorkstreamEpisodes: vi.fn().mockResolvedValue([]),
  listJobs: vi.fn().mockResolvedValue([]),
  getDigest: vi.fn().mockResolvedValue({ needsHandoff: [], running: 0, routines: [] }),
  searchHarness: vi.fn().mockResolvedValue({ hits: [] }),
  markWorkstreamRead: vi.fn(),
  saveSkillFromEpisode: vi.fn(),
  scheduleRoutine: vi.fn(),
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
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove subagent view' }));
    expect(screen.queryByTestId('right-drawer-subagent-view-goodall-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-drawer-subagent-goodall-1'));
    expect(screen.getByTestId('right-drawer-subagent-view-goodall-1')).toBeInTheDocument();
  });

  it('list is clutter-free: no harness bar, delegate button, goal card or debug panels', async () => {
    renderSection();
    await screen.findByTestId('right-drawer-subagent-goodall-1');
    expect(screen.queryByText('Harness')).toBeNull();
    expect(screen.queryByText('Delegate')).toBeNull();
    expect(screen.queryByTitle('Harness config')).toBeNull();
    expect(screen.queryByText(/Isolated context · fresh conversation/)).toBeNull();
    expect(screen.queryByText('Full run (')).toBeNull();
    expect(screen.queryByText('Workstreams')).toBeNull();
  });

  it('detail reads like chat: markdown result, no debug counters or raw dumps', async () => {
    const { api } = await import('@/api/client');
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/runs')) {
        return {
          runs: [
            {
              task_id: 'goodall-1',
              agent_id: 'goodall',
              goal: 'Inspect the backend flow',
              status: 'completed',
              result_full: '**All clear.** The backend flow checks out.',
            },
          ],
        };
      }
      if (url.includes('/transcript')) return { events: [] };
      if (url.includes('/config')) {
        return { maxConcurrent: 3, maxIterations: 25, maxDepth: 1, worktreeIsolation: false };
      }
      return { messages: [] };
    });

    renderSection();
    fireEvent.click(await screen.findByTestId('right-drawer-subagent-goodall-1'));
    const view = await screen.findByTestId('right-drawer-subagent-view-goodall-1');

    // Result renders as chat-formatted markdown…
    expect(view.querySelector('.chat-message-text')).toBeTruthy();
    expect(view.textContent).toContain('The backend flow checks out.');
    // …with none of the debug furniture.
    expect(view.textContent).not.toContain('Live transcript ·');
    expect(view.textContent).not.toContain('api calls');
    expect(view.textContent).not.toContain('iters');
    expect(view.textContent).not.toContain('Persisted final response');
    expect(view.textContent).not.toContain('No final response recorded.');
  });

  it('renders the worker\'s own todo list in the detail view', async () => {
    listAgentsMock.mockResolvedValue({
      agents: [
        {
          taskId: 'general-1',
          agentId: 'general',
          goal: 'Audit modules',
          status: 'running',
          todos: [
            { id: '1', content: 'read routers', status: 'completed' },
            { id: '2', content: 'read services', status: 'in_progress' },
            { id: '3', content: 'write report', status: 'pending' },
          ],
        },
      ],
      meta: {},
    });
    renderSection();
    fireEvent.click(await screen.findByTestId('right-drawer-subagent-general-1'));
    const progress = await screen.findByTestId('subagent-todo-progress');
    expect(progress.textContent).toContain('read routers');
    expect(progress.textContent).toContain('write report');
    expect(progress.textContent).toContain('1/3');
  });

  it('disambiguates multiple workers with the same role', async () => {
    listAgentsMock.mockResolvedValue({
      agents: [
        { taskId: 'g-1', agentId: 'general', goal: '', status: 'running' },
        { taskId: 'g-2', agentId: 'general', goal: '', status: 'running' },
      ],
      meta: {},
    });
    renderSection();
    await screen.findByTestId('right-drawer-subagent-g-1');
    const rows = await screen.findAllByText(/^General [12]$/);
    expect(rows.length).toBe(2);
  });

  it('shows queue position for queued workers', async () => {
    listAgentsMock.mockResolvedValue({
      agents: [
        {
          taskId: 'q-1',
          agentId: 'explore',
          goal: 'Later task',
          status: 'queued',
          queuePosition: 2,
          queueTotal: 2,
        },
      ],
      meta: {},
    });
    renderSection();
    const row = await screen.findByTestId('right-drawer-subagent-q-1');
    expect(row.textContent).toContain('queued #2/2');
  });
});
