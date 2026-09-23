import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskProgressPill } from '../TaskProgressPill';
import { useLiveActivityStore } from '@/store/liveActivity';

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
});
