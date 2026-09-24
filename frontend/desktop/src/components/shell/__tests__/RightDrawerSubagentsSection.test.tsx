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
  // Real orchestrator transcript vocabulary. The jsonl written by
  // `_append_transcript` carries `subagent*` frame types, NOT the block types
  // `appendBlockEvent` speaks — an earlier version of this mock returned
  // `{type:'text'}`, which the backend never writes, so the replay path looked
  // covered while nothing exercised it.
  getSubagentTranscript: vi.fn(async () => ({
    events: [
      { type: 'subagentStart', taskId: 'goodall-1', jobId: 'goodall-1', agentId: 'goodall', goal: 'Inspect the backend flow' },
      { type: 'subagentToolCall', jobId: 'goodall-1', id: 'tu_1', name: 'read_file', input: { path: 'app/main.py' }, status: 'running' },
      { type: 'subagentText', jobId: 'goodall-1', content: 'replayed output' },
      { type: 'subagentWarning', jobId: 'goodall-1', message: 'worker was steered' },
      { type: 'subagentDone', jobId: 'goodall-1', status: 'completed', result: 'the final answer' },
    ],
  })),
}));

vi.mock('@/components/chat/SubagentTimeline', () => ({
  SubagentTimeline: ({ state }: { state: { status: string; blocks?: Array<{ type: string; content?: string }> } }) => (
    <div
      data-testid="subagent-timeline"
      data-status={state.status}
      data-block-count={state.blocks?.length ?? 0}
      data-block-types={state.blocks?.map((block) => block.type).join(',') ?? ''}
    >
      {state.blocks?.map((block, i) => (
        <span key={i} data-testid={`subagent-timeline-block-${block.type}`}>
          {block.content}
        </span>
      ))}
    </div>
  ),
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

  it('replays the persisted work transcript for a settled worker', async () => {
    // The reason this test exists: `transcriptToBlocks` filtered on
    // `text`/`toolCall`/`finalOutput` against a jsonl that only ever contains
    // `subagentText`/`subagentToolCall`/`subagentDone`, so every settled
    // worker's tab rendered "Waiting for output…" forever after a reload even
    // though the full transcript was on disk.
    listAgentsMock.mockResolvedValue({
      agents: [
        {
          taskId: 'goodall-1',
          agentId: 'goodall',
          goal: 'Inspect the backend flow',
          status: 'completed',
        },
      ],
      meta: {},
    });
    renderSection();

    fireEvent.click(await screen.findByTestId('right-drawer-subagent-goodall-1'));
    const timeline = await screen.findByTestId('subagent-timeline');

    // `appendBlockEvent` coalesces adjacent text frames, so assert on what the
    // user can read rather than on a block count that depends on merge rules.
    expect(Number(timeline.getAttribute('data-block-count'))).toBeGreaterThan(0);
    expect(timeline.textContent).toContain('the final answer');
    expect(timeline.textContent).toContain('replayed output');
    expect(timeline.textContent).toContain('worker was steered');
    // The worker's own tool call replays too (its bytes live on `block.tool`,
    // not `block.content`, so assert on the type list rather than the text).
    expect(timeline.getAttribute('data-block-types')).toMatch(/tool/);
    expect(screen.queryByText('Waiting for output…')).not.toBeInTheDocument();
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

  it('renders the worker\'s own todo list behind the Progress popover', async () => {
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
    // The todo list is a header chip that opens a popover.
    const chip = await screen.findByTestId('subagent-progress-chip');
    expect(chip.textContent).toContain('1/3');
    fireEvent.click(chip);
    const popover = await screen.findByTestId('subagent-progress-popover');
    expect(popover.textContent).toContain('read services');
    expect(popover.textContent).toContain('write report');
    expect(popover.textContent).toContain('1 completed');
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
    // Plan A2: the tab strip renders whenever ≥1 entry exists (not only
    // after selection), so the same disambiguated label appears in both the
    // strip (2) and the unselected roster (2). Scope the assertion to the
    // roster list to keep this test focused on disambiguation.
    const roster = await screen.findByTestId('right-drawer-subagents-list');
    const rows = Array.from(roster.querySelectorAll('button')).filter((b) =>
      /^General [12]$/.test(b.textContent || ''),
    );
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

  it('replayed settled error run keeps failure semantics (audit 2026-09-09)', async () => {
    listAgentsMock.mockResolvedValue({
      agents: [{ taskId: 'r-err', agentId: 'goodall', goal: 'Errored run', status: 'error' }],
      meta: {},
    });
    renderSection();
    fireEvent.click(await screen.findByTestId('right-drawer-subagent-r-err'));
    const tl = await screen.findByTestId('subagent-timeline');
    // The old replay mapped everything except 'failed' to 'completed' — an
    // errored run reloaded from disk must still read as failed.
    expect(tl.getAttribute('data-status')).toBe('failed');
  });

  it('replayed settled cancelled run stays cancelled', async () => {
    listAgentsMock.mockResolvedValue({
      agents: [{ taskId: 'r-cancel', agentId: 'goodall', goal: 'Cancelled run', status: 'cancelled' }],
      meta: {},
    });
    renderSection();
    fireEvent.click(await screen.findByTestId('right-drawer-subagent-r-cancel'));
    const tl = await screen.findByTestId('subagent-timeline');
    expect(tl.getAttribute('data-status')).toBe('cancelled');
  });
});
