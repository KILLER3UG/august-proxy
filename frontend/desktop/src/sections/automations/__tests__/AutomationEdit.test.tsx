import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  getAutomations: vi.fn(),
  upsertAutomation: vi.fn(),
  patchAutomation: vi.fn(),
  runAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  rotateAutomationToken: vi.fn(),
  getAggregatedModels: vi.fn(),
  listBots: vi.fn(),
}));

vi.mock('@/api/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/api-client')>()),
  ...mocks,
}));

vi.mock('@/lib/os-notify', () => ({
  OsNotifyService: { notifyJobComplete: vi.fn() },
}));

vi.mock('@/api/folder', () => ({
  openFolderViaTauri: vi.fn(),
}));

import { Automations } from '../Automations';

// The page polls the automations list every 5s and the first render waits on
// that query; testing-library's 1s default for findBy*/waitFor is shorter than
// a starved CPU takes to resolve it, which reads as a missing button.
configure({ asyncUtilTimeout: 5000 });

const JOB = {
  id: 'job-1',
  name: 'Nightly triage',
  jobType: 'workbench',
  schedule: '17 3 * * *',
  prompt: 'Summarize yesterday failures',
  workspacePath: 'C:\\Dev\\august-proxy',
  model: 'qwen3-test',
  modelProvider: 'deepseek',
  agentId: 'bot-nightly',
  maxRuns: 3,
  guardMode: 'plan',
  sandboxMode: 'read-only',
};

function renderPage(ui: ReactNode) {  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openEditForm() {
  renderPage(<Automations />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit automation' }));
  return screen.findByText('Edit automation');
}

describe('Automations — editing an existing job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomations.mockResolvedValue({ jobs: [JOB] });
    mocks.upsertAutomation.mockResolvedValue({ ...JOB });
    mocks.getAggregatedModels.mockResolvedValue({
      models: [{ id: 'qwen3-test', provider: 'deepseek', name: 'Qwen3 Test' }],
    });
    mocks.listBots.mockResolvedValue({
      bots: [{ id: 'bot-nightly', name: 'Nightly', uiMeta: { hidden: false } }],
    });
  });

  it('seeds every field from the job instead of starting blank', async () => {
    await openEditForm();

    expect(screen.getByLabelText('Name')).toHaveValue('Nightly triage');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Summarize yesterday failures');
    expect(screen.getByLabelText('Workspace path')).toHaveValue('C:\\Dev\\august-proxy');
    // The model/agent pins a job already carries must be visible, not silently
    // dropped on the next save.
    expect(screen.getByLabelText('Model (optional)')).toHaveValue('deepseek\nqwen3-test');
    expect(screen.getByLabelText('Agent (optional)')).toHaveValue('bot-nightly');
    expect(screen.getByLabelText(/Stop after N runs/)).toHaveValue(3);
    // An unattended run's execution policy is editable where it is set, not
    // only by hand-posting the API.
    expect(screen.getByLabelText('Approval mode for this run')).toHaveValue('plan');
    expect(screen.getByLabelText('Tool reach for this run')).toHaveValue('read-only');
  });

  it('keeps a hand-written cron out of the preset selector', async () => {
    // 'Schedule' presets cover a fixed list; a stored cron outside it must land
    // in the custom field, or saving would silently reschedule the job.
    await openEditForm();

    expect(screen.getByLabelText('Schedule')).toHaveValue('');
    expect(screen.getByLabelText('Cron or every Nm / Nh')).toHaveValue('17 3 * * *');
  });

  it('sends the job id so the upsert updates rather than duplicating', async () => {
    await openEditForm();

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Summarize yesterday failures and file bugs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.upsertAutomation).toHaveBeenCalledTimes(1));
    const body = mocks.upsertAutomation.mock.calls[0][0];
    expect(body).toMatchObject({
      id: 'job-1',
      name: 'Nightly triage',
      schedule: '17 3 * * *',
      prompt: 'Summarize yesterday failures and file bugs',
      model: 'qwen3-test',
      modelProvider: 'deepseek',
      agentId: 'bot-nightly',
      maxRuns: 3,
      guardMode: 'plan',
      sandboxMode: 'read-only',
    });
  });

  it('labels the execution policy a job runs under', async () => {
    renderPage(<Automations />);
    const badge = await screen.findByTitle('Execution policy for this unattended run');
    expect(badge.textContent).toContain('Plan mode');
    expect(badge.textContent).toContain('Read-only');
  });

  it('sends an empty model when the pin is switched to automatic', async () => {
    // The upsert only writes what the body carries, so "no model" has to be an
    // explicit '' — omitting the key would leave the stored pin in place.
    await openEditForm();
    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.upsertAutomation).toHaveBeenCalledTimes(1));
    const body = mocks.upsertAutomation.mock.calls[0][0];
    expect(body.model).toBe('');
    expect(body.agentId).toBe('bot-nightly');
  });

  it('re-arms a run-capped job instead of leaving it permanently disabled', async () => {
    const capped = { ...JOB, enabled: false, paused: false, limitReached: true };
    mocks.getAutomations.mockResolvedValue({ jobs: [capped] });
    renderPage(<Automations />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-arm automation' }));

    await waitFor(() => expect(mocks.patchAutomation).toHaveBeenCalledWith('job-1', {
      enabled: true,
      paused: false,
    }));
  });

  it('discards the form on cancel without touching the job', async () => {
    await openEditForm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Edit automation')).not.toBeInTheDocument());
    expect(mocks.upsertAutomation).not.toHaveBeenCalled();
  });

  it('switches the same form back to create mode from New', async () => {
    renderPage(<Automations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit automation' }));
    await screen.findByText('Edit automation');

    fireEvent.click(screen.getByRole('button', { name: /^New/ }));

    expect(await screen.findByText('New automation')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    // A create must not carry the id, or it would overwrite the job it came from.
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.upsertAutomation).toHaveBeenCalledTimes(1));
    expect(mocks.upsertAutomation.mock.calls[0][0].id).toBeUndefined();
  });
});

describe('Automations — running an approval-gated job', () => {
  const GATED = { ...JOB, id: 'job-gated', name: 'Nightly deploy', approvalRequired: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomations.mockResolvedValue({ jobs: [GATED] });
    mocks.runAutomation.mockResolvedValue({ status: 'approval_required' });
  });

  it('asks for an explicit decision instead of dead-ending on a toast', async () => {
    renderPage(<Automations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));

    await screen.findByText('Run this automation anyway?');
    // The first attempt honestly says "not approved"; the gate is real.
    expect(mocks.runAutomation).toHaveBeenCalledWith('job-gated', false);

    mocks.runAutomation.mockResolvedValue({ status: 'ok' });
    fireEvent.click(screen.getByRole('button', { name: 'Run once' }));

    await waitFor(() => expect(mocks.runAutomation).toHaveBeenCalledTimes(2));
    expect(mocks.runAutomation.mock.calls[1]).toEqual(['job-gated', true]);
  });

  it('leaves the job alone when the confirmation is declined', async () => {
    renderPage(<Automations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await screen.findByText('Run this automation anyway?');

    fireEvent.click(await screen.findByRole('button', { name: /^Cancel/ }));

    expect(mocks.runAutomation).toHaveBeenCalledTimes(1);
  });

  it('marks the gate on the card so it is not a surprise at click time', async () => {
    renderPage(<Automations />);
    expect(await screen.findByText('needs approval')).toBeInTheDocument();
  });
});
