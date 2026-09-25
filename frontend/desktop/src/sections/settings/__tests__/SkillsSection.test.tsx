/* ── SkillsSection test ────── */
/* Covers the workspace scope selector (C-1), the scope-grouped rows and
 * their overrides chip (C-2), workspace-threaded create/delete routing, the
 * usage readout, and the detail pane's lineage + open-proposal lines. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
      usageCount: 0,
      lastUsed: '',
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
      usageCount: 4,
      lastUsed: '2026-09-20T10:15:00Z',
    },
    // The v1 quartus-flow replaced: an approved proposal leaves it in the
    // catalogue, disabled, which is what the lineage line has to report.
    {
      name: 'legacy-flow',
      description: 'v1 of the Quartus flow',
      trigger: '',
      category: 'learned',
      enabled: false,
      createdBy: 'harness-proposal',
      scope: 'agent',
      overrides: '',
      usageCount: 2,
      lastUsed: '',
    },
  ],
  total: 3,
};

const detailPayload = {
  name: 'quartus-flow',
  description: 'Project-local Quartus flow',
  trigger: 'synthesise the design',
  category: 'development',
  enabled: true,
  createdBy: 'agent',
  instructions: '## When to Use\n\nFPGA synthesis.',
  scope: 'project',
  overrides: 'agent',
  usageCount: 4,
  lastUsed: '2026-09-20T10:15:00Z',
  supersedes: 'legacy-flow',
  origin: 'distilled',
  version: 3,
};

/* The open rows of the learning queue. Only the one naming this skill may
 * surface in its detail pane. */
let proposalsPayload: { proposals: Array<Record<string, unknown>> } = {
  proposals: [
    { id: 'prop_1', kind: 'skill_patch', payload: { name: 'quartus-flow' } },
    { id: 'prop_2', kind: 'skill_delete', payload: { name: 'some-other-skill' } },
  ],
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
      if (key.includes('harness-proposals'))
        return { data: proposalsPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
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
      <MemoryRouter>
        <SkillsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Patch the shared fixtures for one test, then put them back. */
function withValues(fn: () => void) {
  const savedSkills = skillsPayload.skills.map((s) => ({ ...s }));
  const savedDetail = { ...detailPayload };
  const savedProposals = proposalsPayload;
  try {
    fn();
  } finally {
    // Assign in place: the mocked useQuery hands out these very objects, so
    // replacing array entries would leave a test holding a stale reference.
    skillsPayload.skills.forEach((s, i) => Object.assign(s, savedSkills[i]));
    Object.assign(detailPayload, savedDetail);
    proposalsPayload = savedProposals;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SkillsSection — scope selector + rows', () => {
  it('shows the scope selector with Global + known workspaces (C-1)', () => {
    renderSection();
    const select = screen.getByTestId('skills-scope-select');
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toEqual([
      'Global (all skills)',
      'august-proxy · has project skills',
      'sheesh',
    ]);
    expect(select).toHaveValue('');
  });

  it('groups rows by the scope that decides shadowing, and names what an override replaces (C-2)', () => {
    renderSection();
    const project = screen.getByTestId('skill-group-project');
    const learned = screen.getByTestId('skill-group-agent');
    expect(within(project).getByTestId('skill-row-quartus-flow')).toBeInTheDocument();
    expect(within(learned).getByTestId('skill-row-circuit-helper')).toBeInTheDocument();
    expect(within(learned).getByTestId('skill-row-legacy-flow')).toBeInTheDocument();
    expect(within(project).getByTestId('skill-row-overrides')).toHaveTextContent('overrides agent');
    // A disabled skill says so on its row rather than just vanishing.
    expect(within(learned).getByTestId('skill-row-legacy-flow')).toHaveTextContent('disabled');
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
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
    await screen.findByTestId('skill-detail');
    expect(screen.getByTestId('skill-scope-badge')).toHaveTextContent('project');
    expect(screen.getByTestId('skill-overrides-badge')).toHaveTextContent('overrides agent');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('switching scope drops the open detail — the skill may not exist there', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-row-circuit-helper'));
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
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
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

/* Usage chip: the sidecar counters (trigger hits) were written and read by the
 * backend for ranking but never shown, so "does anyone use this skill?" had no
 * answer in the catalogue. */
describe('SkillsSection — usage', () => {
  it('shows a count on a used skill and no chip on one never triggered', () => {
    renderSection();
    expect(within(screen.getByTestId('skill-row-quartus-flow')).getByTestId('skill-usage-badge')).toHaveTextContent('4 uses');
    expect(within(screen.getByTestId('skill-row-circuit-helper')).queryByTestId('skill-usage-badge')).toBeNull();
  });

  it('names the hit count and last-used time in the tooltip', () => {
    renderSection();
    const title = within(screen.getByTestId('skill-row-quartus-flow'))
      .getByTestId('skill-usage-badge')
      .getAttribute('title');
    expect(title).toContain('used 4×');
    expect(title).toContain('last');
  });

  it('reads a single hit as "1 use"', () => {
    withValues(() => {
      Object.assign(skillsPayload.skills[1], { usageCount: 1 });
      renderSection();
      const badge = within(screen.getByTestId('skill-row-quartus-flow')).getByTestId('skill-usage-badge');
      expect(badge).toHaveTextContent('1 use');
      expect(badge.textContent).not.toContain('1 uses');
    });
  });

  it('renders no chip for a row that carries no usage field at all', () => {
    // A `skills-list` response cached before this shipped has no such key —
    // that must read as "nothing shown", not as "0 uses" or NaN.
    withValues(() => {
      Object.assign(skillsPayload.skills[1], { usageCount: undefined, lastUsed: undefined });
      renderSection();
      expect(within(screen.getByTestId('skill-row-quartus-flow')).queryByTestId('skill-usage-badge')).toBeNull();
    });
  });

  it('the detail pane says how often it fired and when, not just a count', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
    const facts = screen.getByTestId('skill-facts');
    expect(within(facts).getByText(/Triggered 4× in chat/)).toBeInTheDocument();
    // The date was previously only a hover tooltip; the pane states it.
    expect(within(facts).getByText(/most recently/)).toBeInTheDocument();
  });

  it('an unused skill is told plainly instead of showing a bare zero', () => {
    withValues(() => {
      Object.assign(detailPayload, { usageCount: 0, lastUsed: '' });
      renderSection();
      fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
      expect(within(screen.getByTestId('skill-facts')).getByText(/No chat has triggered this skill yet/)).toBeInTheDocument();
    });
  });
});

describe('SkillsSection — lineage and the learning loop', () => {
  it('names the skill this one replaced and reports that it was retired', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
    const facts = screen.getByTestId('skill-facts');
    const older = within(facts).getByText('legacy-flow');
    expect(older.closest('div')?.textContent).toContain('Replaces');
    expect(older.closest('div')?.textContent).toContain('retired from injection');
  });

  it('warns when the superseded skill is somehow still enabled', () => {
    withValues(() => {
      Object.assign(skillsPayload.skills[2], { enabled: true });
      renderSection();
      fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
      expect(screen.getByTestId('skill-facts').textContent).toContain('both versions reach the model');
    });
  });

  it('says when the superseded skill is gone rather than linking a dead name', () => {
    withValues(() => {
      Object.assign(detailPayload, { supersedes: 'deleted-long-ago' });
      renderSection();
      fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
      const facts = screen.getByTestId('skill-facts');
      expect(facts.textContent).toContain('no longer in the catalogue');
      // Nothing to open, so nothing clickable.
      expect(within(facts).getByText('deleted-long-ago').tagName).not.toBe('BUTTON');
    });
  });

  it('carries no lineage line for a skill that replaced nothing', () => {
    withValues(() => {
      Object.assign(detailPayload, { supersedes: '', origin: '', version: undefined });
      renderSection();
      fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
      const facts = screen.getByTestId('skill-facts');
      expect(facts.textContent).not.toContain('Replaces');
      expect(facts.textContent).not.toContain('Source');
    });
  });

  it('says who wrote the current version, and that the loop revised it', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
    const facts = screen.getByTestId('skill-facts');
    expect(facts.textContent).toContain('August distilled this from its own sessions');
    expect(facts.textContent).toContain('now at version 3');
  });

  it('lists only the open proposals that name this skill, and links to the inbox', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
    const facts = screen.getByTestId('skill-facts');
    expect(facts.textContent).toContain('1 proposal awaiting your decision (skill_patch)');
    expect(facts.textContent).not.toContain('skill_delete');
    expect(within(facts).getByTestId('skill-open-inbox')).toHaveTextContent('Review inbox');
  });

  it('stays quiet about learning when nothing is waiting', () => {
    withValues(() => {
      proposalsPayload = { proposals: [] };
      renderSection();
      fireEvent.click(screen.getByTestId('skill-row-quartus-flow'));
      const facts = screen.getByTestId('skill-facts');
      expect(facts.textContent).not.toContain('awaiting your decision');
      expect(within(facts).queryByTestId('skill-open-inbox')).toBeNull();
    });
  });
});
