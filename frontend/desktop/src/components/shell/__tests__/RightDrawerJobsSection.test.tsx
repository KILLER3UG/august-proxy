import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightDrawerJobsSection } from '../RightDrawerJobsSection';
import { useBackgroundTasksStore } from '@/store/background-tasks';
import type { BackgroundTask } from '@/store/background-tasks';

function seed(tasks: BackgroundTask[]) {
  useBackgroundTasksStore.setState({ tasks });
}

const base = {
  createdAt: Date.now() - 9_000,
  updatedAt: Date.now() - 1_000,
  sessionId: 's1',
};

describe('RightDrawerJobsSection', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    useBackgroundTasksStore.setState({ tasks: [], trayOpen: false });
  });

  it('explains itself when there is nothing running', () => {
    seed([]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.getByText(/No background jobs/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('job-row')).toHaveLength(0);
  });

  it('renders one row per job with its status', () => {
    seed([
      { ...base, id: 'a', label: 'Preparing Python sandbox', status: 'running' },
      { ...base, id: 'b', label: 'Queue overflow flush', status: 'done' },
    ]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.getAllByTestId('job-row')).toHaveLength(2);
    expect(screen.getByText('Preparing Python sandbox')).toBeInTheDocument();
    expect(screen.getByText('Queue overflow flush')).toBeInTheDocument();
    expect(screen.getByText('1 running')).toBeInTheDocument();
  });

  it('says Idle when every job has settled', () => {
    seed([{ ...base, id: 'a', label: 'Preparing Python sandbox', status: 'done' }]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('hides jobs belonging to another session', () => {
    seed([
      { ...base, id: 'a', label: 'Mine', status: 'running' },
      { ...base, id: 'b', label: 'Theirs', status: 'running', sessionId: 'other' },
    ]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.getByText('Mine')).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).toBeNull();
  });

  it('keeps session-less jobs visible across chats', () => {
    seed([{ ...base, id: 'a', label: 'Global job', status: 'done', sessionId: undefined }]);
    render(<RightDrawerJobsSection sessionId="different" />);
    expect(screen.getByText('Global job')).toBeInTheDocument();
  });

  it('clears finished jobs but leaves running ones', () => {
    seed([
      { ...base, id: 'a', label: 'Still going', status: 'running' },
      { ...base, id: 'b', label: 'Finished', status: 'done' },
    ]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    fireEvent.click(screen.getByTestId('jobs-clear-finished'));
    expect(screen.getByText('Still going')).toBeInTheDocument();
    expect(screen.queryByText('Finished')).toBeNull();
  });

  it('offers no clear action while everything is active', () => {
    seed([{ ...base, id: 'a', label: 'Still going', status: 'running' }]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.queryByTestId('jobs-clear-finished')).toBeNull();
  });

  it('dismisses a single finished job', () => {
    seed([
      { ...base, id: 'a', label: 'One', status: 'error' },
      { ...base, id: 'b', label: 'Two', status: 'error' },
    ]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    fireEvent.click(screen.getByLabelText('Dismiss One'));
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Two')).toBeInTheDocument();
  });

  it('ticks elapsed time forward only while a job runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    seed([
      {
        ...base,
        createdAt: Date.now() - 5_000,
        updatedAt: Date.now(),
        id: 'a',
        label: 'Preparing Python sandbox',
        status: 'running',
      },
    ]);
    render(<RightDrawerJobsSection sessionId="s1" />);
    expect(screen.getByText('5.0s')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.getByText('9.0s')).toBeInTheDocument();
  });
});
