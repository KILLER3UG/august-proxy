/* ── SkillsSection test (Part 17 Phase C gap C-12, from Phase B) ────── */
/* Covers the workspace scope selector (C-1), scope/overrides badges
 * (C-2), and workspace-threaded create/delete routing. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const workspacesPayload = {
  workspaces: [
    { path: 'C:\\Dev\\august-proxy', name: 'august-proxy', hasMemory: true, hasSkills: true, sessions: 4 },
    { path: 'C:\\Dev\\sheesh', name: 'sheesh', hasMemory: false, hasSkills: false, sessions: 1 },
  ],
};

const skillsPayload = {
  skills: [
    {
      name: 'circuit-helper',
      description: 'Build and test circuits',
      trigger: '',
      category: 'development',
      enabled: true,
      createdBy: 'agent',
      scope: 'agent',
      overrides: '',
    },
    {
      name: 'quartus-flow',
      description: 'Project-local Quartus flow',
      trigger: '',
      category: 'development',
      enabled: true,
      createdBy: 'agent',
      scope: 'project',
      overrides: 'agent',
    },
  ],
  total: 2,
};

const detailPayload = {
  name: 'quartus-flow',
  description: 'Project-local Quartus flow',
  trigger: '',
  category: 'development',
  enabled: true,
  createdBy: 'agent',
  instructions: '## When to Use\n\nFPGA synthesis.',
  scope: 'project',
  overrides: 'agent',
};

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  type QOpts = { queryKey?: unknown; enabled?: boolean; queryFn?: () => Promise<unknown> };
  const idle = { data: null, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  return {
    ...actual,
    useQuery: (opts: QOpts) => {
      const key = JSON.stringify(opts.queryKey ?? []);
      if (key.includes('memory-workspaces'))
        return { data: workspacesPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      if (key.includes('skills-list')) {
        // Exercise the real queryFn so api.get receives the built URL.
        void opts.queryFn?.().catch(() => undefined);
        return { data: skillsPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      }
      if (key.includes('skill-detail')) {
        if (opts.enabled === false) return idle;
        void opts.queryFn?.().catch(() => undefined);
        return { data: detailPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      }
      return { data: null, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ row: {} })),
    delete: vi.fn(async () => ({ ok: true })),
  },
}));

import { SkillsSection } from '../SkillsSection';
import { api } from '@/api/client';

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SkillsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SkillsSection — scope selector + badges (Part 17 C-1/C-2)', () => {
  it('shows the scope selector with Global + known workspaces (C-1)', () => {
    renderSection();
    const select = screen.getByTestId('skills-scope-select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toEqual([
      'Global (all skills)',
      'august-proxy · has project skills',
      'sheesh',
    ]);
    expect(select.value).toBe('');
  });

  it('cards carry project + overrides badges (C-2)', () => {
    renderSection();
    expect(screen.getByTestId('skill-card-quartus-flow')).toHaveTextContent('project');
    expect(screen.getByTestId('skill-card-overrides')).toHaveTextContent('overrides agent');
    expect(screen.queryByTestId('skill-card-scope')).toBeInTheDocument();
  });

  it('list fetch passes workspace once a scope is selected (C-1)', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('skills-scope-select'), {
      target: { value: 'C:\\Dev\\august-proxy' },
    });
    await waitFor(() => {
      const urls = (api.get as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      const listFetch = urls.filter((u) => u.includes('/api/skills?') || u.endsWith('/api/skills'));
      expect(listFetch.length).toBeGreaterThan(0);
      expect(listFetch[listFetch.length - 1]).toContain('workspace=C%3A%5CDev%5Caugust-proxy');
    });
  });

  it('detail view shows scope + overrides badges and offers Delete for project overrides (C-2)', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-card-quartus-flow'));
    await screen.findByTestId('skill-detail');
    expect(screen.getByTestId('skill-scope-badge')).toHaveTextContent('project');
    expect(screen.getByTestId('skill-overrides-badge')).toHaveTextContent('overrides agent');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('switching scope drops the open detail — the skill may not exist there', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-card-circuit-helper'));
    await screen.findByTestId('skill-detail');
    // The scope row only renders in list mode; return first, then switch.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const select = screen.getByTestId('skills-scope-select');
    fireEvent.change(select, { target: { value: 'C:\\Dev\\sheesh' } });
    expect(screen.queryByTestId('skill-detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('skills-grid')).toBeInTheDocument();
  });

  it('create posts the workspace so the skill lands in the project root', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('skills-scope-select'), {
      target: { value: 'C:\\Dev\\august-proxy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByPlaceholderText('my-skill-name'), { target: { value: 'ws-skill' } });
    fireEvent.change(screen.getByPlaceholderText('Use when…'), { target: { value: 'Project skill test' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/skills',
        expect.objectContaining({
          name: 'ws-skill',
          workspace: 'C:\\Dev\\august-proxy',
        }),
      );
    });
  });

  it('delete routes through ?workspace= and the dialog explains the override safety', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('skills-scope-select'), {
      target: { value: 'C:\\Dev\\august-proxy' },
    });
    fireEvent.click(screen.getByTestId('skill-card-quartus-flow'));
    await screen.findByTestId('skill-detail');
    // The header Delete button opens the dialog (two Delete-named buttons exist).
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/The global skill it shadows \(if any\) stays intact\./),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => {
      const urls = (api.delete as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/api/skills/quartus-flow') && u.includes('workspace='))).toBe(true);
    });
  });
});
