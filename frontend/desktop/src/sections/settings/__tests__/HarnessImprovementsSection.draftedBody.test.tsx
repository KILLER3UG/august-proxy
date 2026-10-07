/* ── Review inbox: the drafted skill, rendered (skill authoring) ─────────────
 * A learned skill only exists because a human said yes. Until now the body was
 * reachable only inside `JSON.stringify(payload)` — escaped `\n`s in a 10rem
 * scroll box — so the approver read the one-line summary and a blob, never the
 * procedure they were about to install. The distiller now drafts full skills,
 * which makes this the gate that matters: what cannot be read cannot be judged.
 *
 * Pins: the body renders as markdown under a heading that names what it is, and
 * the raw payload stops duplicating it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { HarnessImprovementsSection } from '../HarnessImprovementsSection';

const getMock = vi.mocked(api.get);

const BODY = [
  '# ngspice batch simulation',
  '',
  'Runs a netlist headlessly. It does not flash hardware.',
  '',
  '## Procedure',
  '',
  '1. Run in batch mode',
  '   `ngspice -b a.cir`',
  '2. Read the print table from the receipt',
  '',
  '## Pitfalls',
  '',
  '- ngspice opened the GUI and hung the turn',
  '  Instead: pass -b',
].join('\n');

const SKILL_CREATE = {
  id: 'prop_create',
  createdAt: '2026-10-08T00:00:00Z',
  kind: 'skill_create',
  status: 'open' as const,
  problem: 'the flow hung on a GUI window',
  evidence: 'episode 3 [failure_recovery] outcome=resolved',
  proposal: 'create_skill: ngspice-batch-sim — Run netlists headlessly.',
  rollback: 'r',
  payload: { name: 'ngspice-batch-sim', description: 'Run netlists headlessly.', body: BODY },
};

const NO_BODY = {
  ...SKILL_CREATE,
  id: 'prop_observation',
  kind: 'observation',
  problem: 'an observation with no drafted file',
  payload: { name: 'some-skill', note: 'review only' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.includes('inbox/count')) return Promise.resolve({ open: 2 });
    if (url.startsWith('/api/harness/proposals')) {
      return Promise.resolve({ ok: true, openCount: 2, proposals: [SKILL_CREATE, NO_BODY] });
    }
    if (url.startsWith('/api/august/memory/proposals')) {
      return Promise.resolve({ ok: true, proposals: [] });
    }
    return Promise.resolve({});
  });
});

const openDetail = async (problem: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HarnessImprovementsSection />
    </QueryClientProvider>,
  );
  const row = await screen.findByText(problem);
  fireEvent.click(row);
};

describe('the drafted skill in the inbox', () => {
  it('renders the body as markdown, not as escaped JSON', async () => {
    await openDetail('the flow hung on a GUI window');
    const pane = await screen.findByTestId('proposal-drafted-body');
    expect(pane.querySelector('h1')?.textContent).toContain('ngspice batch simulation');
    expect(pane.textContent).toContain('Read the print table from the receipt');
    expect(pane.textContent).toContain('Instead: pass -b');
    // No literal newline escapes leak into the rendered document.
    expect(pane.innerHTML).not.toContain('\\n');
  });

  it('names the heading by what the proposal writes', async () => {
    await openDetail('the flow hung on a GUI window');
    expect(screen.getByText('Drafted skill')).toBeTruthy();
  });

  it('does not duplicate the body inside the payload dump', async () => {
    await openDetail('the flow hung on a GUI window');
    const payload = await screen.findByText(/chars — rendered above/);
    expect(payload.textContent).toContain(`${BODY.length} chars`);
    expect(payload.textContent).not.toContain('ngspice -b a.cir');
  });

  it('renders nothing when the proposal carries no body', async () => {
    await openDetail('an observation with no drafted file');
    await screen.findByText('Back to inbox');
    expect(screen.queryByTestId('proposal-drafted-body')).toBeNull();
  });
});
