import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskProgressPill } from '../TaskProgressPill';
import { clearLiveActivity, useLiveActivityStore } from '@/store/liveActivity';
import { gitApi } from '@/api/git';

vi.mock('@/api/git', () => ({
  gitApi: {
    status: vi.fn().mockResolvedValue({
      files: [
        { path: 'src/main.rs', status: 'modified' },
        { path: 'src/lib.rs', status: 'added' },
      ],
      added: 42,
      removed: 5,
    }),
  },
}));

function withProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('TaskProgressPill', () => {
  beforeEach(() => {
    // The polling tests count gitApi.status calls; keep the mock's
    // implementation, drop only the recorded calls.
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when there are no todos and no modified files', () => {
    const { container } = withProviders(<TaskProgressPill sessionId="sess_empty" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders progress and toggles popover when todos are present', async () => {
    useLiveActivityStore.setState({
      bySession: {
        // Quoted: the key IS the session id (`sess_…`), not a camelCase name.
        'sess_todo': {
          headline: 'Working',
          items: [],
          todos: {
            title: 'Build Release',
            at: Date.now(),
            items: [
              { id: '1', content: 'Compile binary', status: 'completed' },
              { id: '2', content: 'Run test suite', status: 'in_progress' },
              { id: '3', content: 'Package bundle', status: 'pending' },
            ],
          },
        },
      },
    });

    withProviders(<TaskProgressPill sessionId="sess_todo" />);

    const pill = await screen.findByTestId('task-progress-pill-btn');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('Step 1/3');

    // Popover closed initially
    expect(screen.queryByTestId('task-progress-popover')).toBeNull();

    // Click opens popover
    fireEvent.click(pill);
    expect(screen.getByTestId('task-progress-popover')).toBeInTheDocument();
    expect(screen.getByText('Compile binary')).toBeInTheDocument();
    expect(screen.getByText('Run test suite')).toBeInTheDocument();
    expect(screen.getByText('Package bundle')).toBeInTheDocument();
  });

  // ── git status polling ─────────────────────────────────────────────
  // The 25s timer may only run while a turn is genuinely live; terminal
  // states arrive as live-activity store events, not as timer ticks.

  it('fetches git status once on mount but never starts polling an idle session', async () => {
    vi.useFakeTimers();
    withProviders(<TaskProgressPill sessionId="sess_idle" />);
    const status = vi.mocked(gitApi.status);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('keeps the 25s cadence while the step is active, stops the moment it settles', async () => {
    vi.useFakeTimers();
    useLiveActivityStore.setState({
      bySession: {
        // Quoted keys: the session id IS the key, not a camelCase name.
        'sess_live': {
          headline: 'Working',
          items: [],
          todos: {
            title: 'Build',
            at: Date.now(),
            items: [{ id: '1', content: 'Compile', status: 'in_progress' }],
          },
        },
      },
    });
    withProviders(<TaskProgressPill sessionId="sess_live" />);
    const status = vi.mocked(gitApi.status);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(status).toHaveBeenCalledTimes(1);

    // Genuinely in progress → one refetch per 25s tick, unchanged.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(status).toHaveBeenCalledTimes(2);

    // todosUpdated marks the last step terminal — the event drops the
    // interval; no later tick may fire.
    act(() => {
      useLiveActivityStore.setState({
        bySession: {
          'sess_live': {
            headline: 'Working',
            items: [],
            todos: {
              title: 'Build',
              at: Date.now(),
              items: [{ id: '1', content: 'Compile', status: 'completed' }],
            },
          },
        },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the stream ends and the live entry is cleared', async () => {
    vi.useFakeTimers();
    useLiveActivityStore.setState({
      bySession: {
        'sess_end': {
          headline: 'Working',
          items: [],
          todos: {
            title: 'Build',
            at: Date.now(),
            items: [{ id: '1', content: 'Compile', status: 'in_progress' }],
          },
        },
      },
    });
    withProviders(<TaskProgressPill sessionId="sess_end" />);
    const status = vi.mocked(gitApi.status);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(status).toHaveBeenCalledTimes(2);

    // Stream end clears the entry even though the todo never reached
    // 'completed' (error/cancel paths) — that is terminal all the same.
    act(() => {
      clearLiveActivity('sess_end');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    useLiveActivityStore.setState({
      bySession: {
        'sess_unmount': {
          headline: 'Working',
          items: [],
          todos: {
            title: 'Build',
            at: Date.now(),
            items: [{ id: '1', content: 'Compile', status: 'in_progress' }],
          },
        },
      },
    });
    const { unmount } = withProviders(<TaskProgressPill sessionId="sess_unmount" />);
    const status = vi.mocked(gitApi.status);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(status).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });
});
