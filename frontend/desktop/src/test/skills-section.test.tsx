/* ── SkillsSection — unified skills + curator screen ─────────────────── */
/* Tests the consolidated SkillsSection that replaces the old
 * CuratorSection + SkillsAuthoringSection. Covers:
 *   • 4 stat tiles with initial zero values
 *   • unified table populated after /api/skills + /api/curator/usage load
 *   • + New button switches mode to create form
 *   • clicking a row opens the detail view
 *   • hover-revealed icon actions (pin/unpin/archive/restore)
 *   • lifecycle row exposes Run + Dry run buttons
 *
 * The `@/api/client` module is mocked wholesale with vi.mock so we
 * never touch the network. vi.hoisted carries the shared mock object
 * out of the hoisting sandbox so beforeEach can reset it. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── API mock ────────────────────────────────────────────────────────────
// vi.mock factories are hoisted to the top of the file, before any
// module-level `const`. Use vi.hoisted to allocate a single shared mock
// object that both the factory and the test body can reach.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/api/client', () => ({
  api: apiMock,
}));

// Import AFTER vi.mock so the component picks up the mocked api.
import { SkillsSection } from '@/sections/settings/SkillsSection';

// ── Fixtures ────────────────────────────────────────────────────────────
const SKILLS = {
  skills: [
    {
      name: 'alpha',
      description: 'Alpha skill',
      trigger: 'do alpha',
      category: 'development',
      enabled: true,
      createdBy: 'agent',
    },
    {
      name: 'beta',
      description: 'Beta skill',
      trigger: '',
      category: 'testing',
      enabled: true,
      createdBy: 'builtin',
    },
  ],
  total: 2,
};

const USAGE = {
  usage: [
    {
      name: 'alpha',
      useCount: 7,
      viewCount: 3,
      patchCount: 1,
      lastUsedAt: 1718000000,
      state: 'active',
      pinned: true,
      archivedAt: null,
    },
    {
      name: 'beta',
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      lastUsedAt: null,
      state: 'stale',
      pinned: false,
      archivedAt: null,
    },
  ],
};

function installFixtures(overrides: { skills?: any; usage?: any } = {}) {
  apiMock.get.mockImplementation((path: string) => {
    if (typeof path === 'string' && path.startsWith('/api/curator/usage')) {
      return Promise.resolve(overrides.usage ?? USAGE);
    }
    if (typeof path === 'string' && path.startsWith('/api/skills/')) {
      // detail fetch — return a SkillDetail matching the requested name.
      const name = decodeURIComponent(path.split('/').pop() ?? '');
      return Promise.resolve({
        name,
        description: `${name} description`,
        trigger: '',
        category: 'development',
        enabled: true,
        createdBy: 'agent',
        instructions: `# ${name}\n\ninstructions body`,
      });
    }
    if (typeof path === 'string' && path.startsWith('/api/skills')) {
      return Promise.resolve(overrides.skills ?? SKILLS);
    }
    return Promise.reject(new Error('unexpected GET ' + path));
  });
  // Post/patch/delete default to a no-op success.
  apiMock.post.mockResolvedValue({ report: { active: 2, staled: [], archived: [], errors: [] } });
  apiMock.patch.mockResolvedValue({});
  apiMock.delete.mockResolvedValue({});
}

// ── Tests ──────────────────────────────────────────────────────────────
describe('SkillsSection — unified skills + curator surface', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
  });

  it('renders 4 stat tiles (Active / Stale / Archived / Tracked) with loaded values', async () => {
    installFixtures();
    render(<SkillsSection />);

    await waitFor(() => {
      // Headings: Active / Stale / Archived / Tracked. Each label also
      // shows up in the state badge ("Active" for the alpha row), so we
      // use *AllBy* — at minimum one tile label for each must exist.
      expect(screen.getAllByText(/^active$/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/^stale$/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/^archived$/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/^tracked$/i).length).toBeGreaterThanOrEqual(1);
    });

    // With our fixtures: alpha=active, beta=stale, none archived,
    // 2 rows tracked. The numeric values 1 (×2: active + stale tiles),
    // 0 (archived tile + some "last used" cells), and 2 (tracked tile)
    // should all appear. We use *AllBy* because plain numbers can recur
    // in many places.
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
  });

  it('populates the unified table from /api/skills + /api/curator/usage', async () => {
    installFixtures();
    render(<SkillsSection />);

    // Both fixture skill names should appear as table cells.
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy();
      expect(screen.getByText('beta')).toBeTruthy();
    });

    // State badges: alpha is active, beta is stale.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Stale').length).toBeGreaterThan(0);

    // Usage is merged into the row — alpha.useCount=7, beta.useCount=0.
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('clicking [+] New switches mode to the create form', async () => {
    installFixtures();
    render(<SkillsSection />);

    await waitFor(() => screen.getByText('alpha'));

    fireEvent.click(screen.getByRole('button', { name: /New/i }));

    await waitFor(() => {
      expect(screen.getByText('Create skill')).toBeTruthy();
      // The form has the Name label.
      expect(screen.getByText(/^Name$/)).toBeTruthy();
      // And the Save / Cancel buttons.
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeTruthy();
    });
  });

  it('clicking a table row opens the detail view', async () => {
    installFixtures();
    render(<SkillsSection />);

    const row = await waitFor(() => screen.getByText('alpha'));
    fireEvent.click(row);

    // Detail view renders the heading with the skill name and the
    // "Instructions (SKILL.md body)" section.
    await waitFor(() => {
      expect(screen.getByText(/Instructions \(SKILL\.md body\)/i)).toBeTruthy();
      // The mock detail body comes back from the api.get mock.
      expect(screen.getByText(/instructions body/i)).toBeTruthy();
    });

    // Detail header has Edit + Delete actions.
    expect(screen.getByRole('button', { name: /Edit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete/i })).toBeTruthy();
  });

  it('exposes hover-revealed pin/unpin/archive/restore icon buttons per row', async () => {
    installFixtures();
    render(<SkillsSection />);

    await waitFor(() => screen.getByText('alpha'));

    // alpha is pinned → Unpin button. beta is not pinned → Pin button.
    expect(screen.getByRole('button', { name: /unpin/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^pin$/i })).toBeTruthy();

    // Both rows expose Archive + Restore.
    expect(screen.getAllByRole('button', { name: /^archive$/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('button', { name: /^restore$/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('the lifecycle row shows Run and Dry run buttons', async () => {
    installFixtures();
    render(<SkillsSection />);

    await waitFor(() => screen.getByText('alpha'));

    const run = screen.getByRole('button', { name: /^run$/i });
    const dry = screen.getByRole('button', { name: /dry run/i });
    expect(run).toBeTruthy();
    expect(dry).toBeTruthy();

    // Clicking Run triggers api.post('/api/curator/run?dry_run=false').
    fireEvent.click(run);
    await waitFor(() => {
      const call = apiMock.post.mock.calls.find(([path]) =>
        typeof path === 'string' && path.startsWith('/api/curator/run'),
      );
      expect(call, 'Run should POST to /api/curator/run').toBeDefined();
      expect((call as [string])[0]).toContain('dry_run=false');
    });

    // Clicking Dry run triggers ?dry_run=true.
    fireEvent.click(dry);
    await waitFor(() => {
      const calls = apiMock.post.mock.calls.filter(([path]) =>
        typeof path === 'string' && path.startsWith('/api/curator/run'),
      );
      expect(calls.some(([p]) => (p as string).includes('dry_run=true'))).toBe(true);
    });
  });

  it('clicking pin/unpin/archive/restore fires the right curator endpoints', async () => {
    installFixtures();
    render(<SkillsSection />);

    await waitFor(() => screen.getByText('alpha'));

    // alpha is pinned → click Unpin to POST /api/curator/unpin/alpha.
    fireEvent.click(screen.getByRole('button', { name: /unpin/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/curator/unpin/alpha');
    });

    // beta is not pinned → click Pin to POST /api/curator/pin/beta.
    fireEvent.click(screen.getByRole('button', { name: /^pin$/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/curator/pin/beta');
    });

    // Archive beta (not archived).
    const archiveButtons = screen.getAllByRole('button', { name: /^archive$/i });
    fireEvent.click(archiveButtons[archiveButtons.length - 1]); // last is beta
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/curator/archive/beta');
    });
  });
});