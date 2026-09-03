/**
 * Bot Mode Phase B — RoutinesPane (plan: "pane CRUD against mock API").
 *
 * Pins: routines render from the automations list filtered to the Bot's
 * agentId; creation posts the namespaced job with deliver='bot-chat' and the
 * natural schedule form; run-now/pause/delete call the right endpoints.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const upsert = vi.fn();
const runNow = vi.fn();
const patch = vi.fn();
const remove = vi.fn();

vi.mock('@/api/api-client', () => ({
  getAutomations: vi.fn().mockResolvedValue({
    jobs: [
      {
        id: 'job_1',
        name: '[bot:Researcher] Morning brief',
        schedule: 'daily 09:00',
        agentId: 'agent_aaa1',
        deliver: 'bot-chat',
        status: 'succeeded',
        lastRunAt: '2026-09-01T01:00:00Z',
      },
      {
        id: 'job_other',
        name: '[bot:Critic] Watch',
        schedule: 'every 1h',
        agentId: 'agent_bbb2',
        deliver: 'bot-chat',
      },
      {
        id: 'job_plain',
        name: 'plain automation',
        schedule: 'every 2h',
        agentId: '',
      },
    ],
  }),
  getAutomationIncidents: vi.fn().mockResolvedValue({
    incidents: [{ jobId: 'job_1', signature: 'conn reset', state: 'open', count: 3 }],
  }),
  upsertAutomation: (...a: unknown[]) => upsert(...a),
  runAutomation: (...a: unknown[]) => runNow(...a),
  patchAutomation: (...a: unknown[]) => patch(...a),
  deleteAutomation: (...a: unknown[]) => remove(...a),
}));

import { RoutinesPane } from '../RoutinesPane';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoutinesPane agentId="agent_aaa1" botName="Researcher" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RoutinesPane', () => {
  it('lists only this Bot’s routines (namespace + agentId filter)', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByTestId('routine-row')).toHaveLength(1));
    expect(screen.getByText('Morning brief')).toBeInTheDocument();
    expect(screen.queryByText('Watch')).not.toBeInTheDocument();
    expect(screen.queryByText('plain automation')).not.toBeInTheDocument();
  });

  it('shows schedule and last-run status on the row', async () => {
    mount();
    await waitFor(() => screen.getByTestId('routine-row'));
    const row = screen.getByTestId('routine-row');
    expect(row).toHaveTextContent('daily 09:00');
    expect(row).toHaveTextContent('succeeded');
  });

  it('creates a routine with the daily natural form and bot-chat delivery', async () => {
    upsert.mockResolvedValue({ id: 'job_new' });
    mount();
    await waitFor(() => screen.getByTestId('routines-pane'));

    fireEvent.click(screen.getByTitle('New routine'));
    fireEvent.change(screen.getByTestId('routine-title'), { target: { value: 'Evening digest' } });
    fireEvent.change(screen.getByTestId('routine-prompt'), {
      target: { value: 'Summarize today.' },
    });
    // default freq is daily; set the time
    fireEvent.change(screen.getByTestId('routine-time'), { target: { value: '18:30' } });
    fireEvent.click(screen.getByTestId('routine-create'));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const body = upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(body['name']).toBe('[bot:Researcher] Evening digest');
    expect(body['schedule']).toBe('daily 18:30');
    expect(body['agentId']).toBe('agent_aaa1');
    expect(body['deliver']).toBe('bot-chat');
    expect(body['respond']).toBe(true);
  });

  it('weekly pick builds the weekly form', async () => {
    upsert.mockResolvedValue({ id: 'job_w' });
    mount();
    await waitFor(() => screen.getByTestId('routines-pane'));
    fireEvent.click(screen.getByTitle('New routine'));
    fireEvent.change(screen.getByTestId('routine-title'), { target: { value: 'W' } });
    fireEvent.click(screen.getByText('weekly'));
    fireEvent.change(screen.getByTestId('routine-day'), { target: { value: 'fri' } });
    fireEvent.click(screen.getByTestId('routine-create'));
    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const body = upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(body['schedule']).toMatch(/^weekly fri \d{2}:\d{2}$/);
  });

  it('run-now calls the manual trigger for that job', async () => {
    runNow.mockResolvedValue({});
    mount();
    await waitFor(() => screen.getByTestId('routine-row'));
    fireEvent.click(screen.getByTitle('Run now'));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith('job_1'));
  });

  it('pause toggles via patch', async () => {
    patch.mockResolvedValue({});
    mount();
    await waitFor(() => screen.getByTestId('routine-row'));
    fireEvent.click(screen.getByTitle('Pause'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('job_1', { paused: true }));
  });

  it('delete removes the routine', async () => {
    remove.mockResolvedValue({ deleted: true });
    mount();
    await waitFor(() => screen.getByTestId('routine-row'));
    fireEvent.click(screen.getByTitle('Delete routine'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('job_1'));
  });

  it('shows an incident badge only on this Bot’s failing routines (M-11)', async () => {
    mount();
    await waitFor(() => screen.getByTestId('routine-row'));
    const badge = await waitFor(() => screen.getByTestId('routine-incident-job_1'));
    expect(badge.textContent).toContain('3');
    // Other Bot's job + non-routine jobs must NOT show a badge.
    expect(screen.queryByTestId('routine-incident-job_other')).toBeNull();
  });
});
